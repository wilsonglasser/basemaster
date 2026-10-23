//! HTTP JSON-RPC client for the MCP server the GUI runs on 127.0.0.1.
//!
//! Every CLI command is one `tools/call`; the server keeps the connections,
//! tunnels and guardrails, so a script can fire dozens of commands without
//! reconnecting. Port and token come from the same places the GUI writes
//! them (local store setting `mcp.port`, OS keyring) with env/flag overrides
//! for setups where the keyring isn't reachable (CLI inside WSL, etc).

use std::fmt;
use std::time::Duration;

use anyhow::Context;
use basemaster_store::{AppPaths, Store};
use serde_json::{json, Value as JsonValue};

pub const DEFAULT_PORT: u16 = 7424;
pub const ENV_PORT: &str = "BASEMASTER_MCP_PORT";
pub const ENV_TOKEN: &str = "BASEMASTER_MCP_TOKEN";

/// Server-side long-poll cap (`MAX_WAIT_SECS` in mcp_server.rs).
pub const MAX_WAIT_SECS: u64 = 60;

#[derive(Debug)]
pub enum CliError {
    /// Nothing is listening on the port: GUI closed or MCP server stopped.
    NotRunning(String),
    /// Token rejected.
    Unauthorized,
    /// The server answered with a JSON-RPC error (tool failure, guardrail, ...).
    Tool(String),
    Other(anyhow::Error),
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            CliError::Tool(_) | CliError::Other(_) => 1,
            CliError::NotRunning(_) => 3,
            CliError::Unauthorized => 4,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::NotRunning(url) => write!(
                f,
                "cannot reach BaseMaster at {url}: the app is not running or its MCP server is stopped (Settings > MCP server > Start). Override with --port / {ENV_PORT}."
            ),
            CliError::Unauthorized => write!(
                f,
                "MCP token rejected. The GUI token changed? Pass --token or set {ENV_TOKEN}."
            ),
            CliError::Tool(m) => write!(f, "{m}"),
            CliError::Other(e) => write!(f, "{e:#}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<anyhow::Error> for CliError {
    fn from(e: anyhow::Error) -> Self {
        CliError::Other(e)
    }
}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        CliError::Other(e.into())
    }
}

pub type Result<T> = std::result::Result<T, CliError>;

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

impl Endpoint {
    /// Precedence: explicit flag, env var, what the GUI persisted, default.
    pub async fn resolve(port: Option<u16>, token: Option<String>) -> anyhow::Result<Self> {
        let env_port = std::env::var(ENV_PORT)
            .ok()
            .and_then(|s| s.parse::<u16>().ok());
        let env_token = std::env::var(ENV_TOKEN).ok().filter(|s| !s.is_empty());

        let mut port = port.or(env_port);
        let mut token = token.or(env_token);

        if port.is_none() || token.is_none() {
            if port.is_none() {
                port = stored_port().await;
            }
            if token.is_none() {
                token = basemaster_store::secrets::get_mcp_token()
                    .context("read MCP token from the OS keyring")?;
            }
        }

        let token = token.ok_or_else(|| {
            anyhow::anyhow!(
                "no MCP token found. Open BaseMaster > Settings > MCP server once (it creates the token), or pass --token / {ENV_TOKEN}."
            )
        })?;
        Ok(Self {
            port: port.unwrap_or(DEFAULT_PORT),
            token,
        })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }
}

async fn stored_port() -> Option<u16> {
    let paths = AppPaths::resolve().ok()?;
    let store = Store::open(&paths.db_path()).await.ok()?;
    store
        .settings()
        .get("mcp.port")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u16>().ok())
}

#[derive(Debug, Clone)]
pub struct ConnInfo {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub default_database: Option<String>,
}

pub struct Client {
    agent: ureq::Agent,
    url: String,
    token: String,
}

impl Client {
    pub fn new(ep: &Endpoint) -> Self {
        // Long-poll calls block up to MAX_WAIT_SECS server-side; the budget
        // above that covers a slow tunnel open on first use.
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(MAX_WAIT_SECS + 120)))
            .http_status_as_error(false)
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
            url: ep.url(),
            token: ep.token.clone(),
        }
    }

    fn rpc(&self, method: &str, params: JsonValue) -> Result<JsonValue> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let mut resp = match self
            .agent
            .post(&self.url)
            .header("Authorization", &format!("Bearer {}", self.token))
            .send_json(&body)
        {
            Ok(r) => r,
            Err(ureq::Error::Io(e)) if is_unreachable(&e) => {
                return Err(CliError::NotRunning(self.url.clone()))
            }
            Err(ureq::Error::Timeout(_)) => {
                return Err(CliError::Other(anyhow::anyhow!(
                    "request timed out. A tunnelled connection waiting for an SSH host-key answer in the GUI window can cause this."
                )))
            }
            Err(e) => return Err(CliError::Other(anyhow::anyhow!("HTTP request failed: {e}"))),
        };
        if resp.status() == 401 {
            return Err(CliError::Unauthorized);
        }
        if !resp.status().is_success() {
            return Err(CliError::Other(anyhow::anyhow!(
                "server answered HTTP {}",
                resp.status()
            )));
        }
        let parsed: JsonValue = resp
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_json()
            .map_err(|e| anyhow::anyhow!("invalid JSON-RPC response: {e}"))?;
        if let Some(err) = parsed.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
                .to_string();
            return Err(CliError::Tool(msg));
        }
        Ok(parsed.get("result").cloned().unwrap_or(JsonValue::Null))
    }

    /// `tools/call` and unwrap the structured payload.
    pub fn call(&self, tool: &str, args: JsonValue) -> Result<JsonValue> {
        let result = self.rpc("tools/call", json!({ "name": tool, "arguments": args }))?;
        if let Some(sc) = result.get("structuredContent") {
            return Ok(sc.clone());
        }
        // Older servers only ship the text block.
        let text = result
            .pointer("/content/0/text")
            .and_then(|t| t.as_str())
            .unwrap_or("null");
        serde_json::from_str(text)
            .map_err(|e| CliError::Other(anyhow::anyhow!("unparseable tool result: {e}")))
    }

    pub fn server_info(&self) -> Result<JsonValue> {
        self.rpc("initialize", json!({}))
    }

    pub fn connections(&self) -> Result<Vec<ConnInfo>> {
        let v = self.call("list_connections", json!({}))?;
        let list = v
            .get("connections")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(list
            .iter()
            .map(|c| ConnInfo {
                id: c.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                name: c.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                driver: c.get("driver").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                default_database: c
                    .get("default_database")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            })
            .collect())
    }

    /// Accepts a saved connection name (case-insensitive) or its UUID.
    pub fn resolve_connection(&self, name_or_id: &str) -> Result<ConnInfo> {
        let list = self.connections()?;
        let needle = name_or_id.trim();
        let found = list
            .iter()
            .find(|c| c.id.eq_ignore_ascii_case(needle))
            .or_else(|| list.iter().find(|c| c.name == needle))
            .or_else(|| list.iter().find(|c| c.name.eq_ignore_ascii_case(needle)))
            .cloned();
        found.ok_or_else(|| {
            let names: Vec<&str> = list.iter().map(|c| c.name.as_str()).collect();
            CliError::Tool(format!(
                "no saved connection named '{needle}'. Known: {}",
                if names.is_empty() {
                    "(none)".to_string()
                } else {
                    names.join(", ")
                }
            ))
        })
    }

    /// Follows a job until it leaves `running`. `first` is the payload the
    /// tool call returned; when it already carries the result it's returned
    /// as-is. Progress snapshots (transfers) go to `on_progress`.
    pub fn wait_job(
        &self,
        first: JsonValue,
        poll_secs: u64,
        on_progress: &mut dyn FnMut(&JsonValue),
    ) -> Result<JsonValue> {
        if first.get("status").and_then(|s| s.as_str()) != Some("running") {
            return Ok(first);
        }
        let job_id = first
            .get("job_id")
            .and_then(|j| j.as_str())
            .ok_or_else(|| CliError::Other(anyhow::anyhow!("running job without job_id")))?
            .to_string();
        loop {
            let snap = self.call(
                "job_status",
                json!({ "job_id": job_id, "wait_seconds": poll_secs.min(MAX_WAIT_SECS) }),
            )?;
            match snap.get("status").and_then(|s| s.as_str()) {
                Some("running") => {
                    if let Some(p) = snap.get("progress") {
                        on_progress(p);
                    }
                }
                Some("done") => {
                    let mut out = snap.get("result").cloned().unwrap_or(JsonValue::Null);
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("job_id".into(), json!(job_id));
                        obj.insert("status".into(), json!("done"));
                    }
                    return Ok(out);
                }
                Some("failed") => {
                    let msg = snap
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("job failed")
                        .to_string();
                    return Err(CliError::Tool(msg));
                }
                other => {
                    return Err(CliError::Other(anyhow::anyhow!(
                        "unexpected job status {other:?}"
                    )))
                }
            }
        }
    }
}

fn is_unreachable(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        e.kind(),
        ConnectionRefused | ConnectionReset | ConnectionAborted | NotConnected | AddrNotAvailable
    )
}
