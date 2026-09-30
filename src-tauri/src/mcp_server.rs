//! Local MCP (Model Context Protocol) server.
//!
//! Exposes a subset of MCP over HTTP JSON-RPC 2.0 on 127.0.0.1:<port>.
//! The caller passes in the auth token (persisted in the OS keyring) —
//! any MCP client that configures the token + URL can access it.
//!
//! Exposed tools:
//!  - `list_connections` — saved connections (without passwords).
//!  - `open_connection` / `close_connection`: explicit lifecycle; every
//!    tool taking a `connection_id` also opens it on demand.
//!  - `list_schemas`, `list_tables`, `describe_table`, `get_table_ddl`.
//!  - `run_query` — runs arbitrary SQL, returns bounded rows.
//!  - `run_query_to_file`: streams a result set to disk.
//!  - `transfer_tables` — copies tables between two connections.
//!  - `job_status` / `job_list` / `job_cancel`: long-running work.
//!
//! Long-running tools (`run_query`, `run_query_to_file`, `transfer_tables`)
//! never block the HTTP request to completion: they run in a detached task
//! registered in the job registry and the call returns either the finished
//! result (when it lands inside `wait_seconds`) or a `job_id` to poll with
//! `job_status`. That keeps a client-side tool timeout from dropping the
//! request future mid-transfer and leaving a half-copied target behind.
//!
//! Security:
//!  - Bind on 127.0.0.1 only (never 0.0.0.0).
//!  - Bearer token required on every request.
//!  - Random 32-byte token, persisted in the keyring, regenerated only
//!    on explicit user request (so client config survives restarts).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{Mutex, Notify, RwLock};
use uuid::Uuid;

use crate::state::AppState;

#[derive(Clone)]
pub struct McpServer {
    /// Port in use (0 = not started).
    pub port: Arc<RwLock<u16>>,
    /// Handle for the server task so it can be stopped.
    pub handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Shutdown signal.
    pub shutdown: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Long-running tool calls, keyed by job id. Finished jobs stay around
    /// so a late poll still sees the result; capped by `JOB_HISTORY`.
    pub jobs: Arc<RwLock<HashMap<String, Arc<Job>>>>,
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            port: Arc::new(RwLock::new(0)),
            handle: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(Mutex::new(None)),
            jobs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn is_running(&self) -> bool {
        self.handle.lock().await.is_some()
    }

    pub async fn current_port(&self) -> u16 {
        *self.port.read().await
    }

    /// Starts the HTTP server. If already running, stops and restarts it.
    /// The token is supplied by the caller (loaded from the keyring).
    pub async fn start(
        &self,
        app_handle: AppHandle,
        preferred_port: u16,
        token: String,
    ) -> Result<(String, u16), String> {
        self.stop().await;
        let listener = tokio::net::TcpListener::bind((
            std::net::Ipv4Addr::LOCALHOST,
            preferred_port,
        ))
        .await
        .map_err(|e| format!("bind :{}: {}", preferred_port, e))?;
        let bound = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();

        let ctx = Arc::new(HandlerContext {
            app_handle,
            token: token.clone(),
        });
        let router = Router::new()
            .route("/mcp", post(rpc_handler))
            .route("/health", post(health_handler))
            .with_state(ctx);

        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await;
        });

        *self.port.write().await = bound;
        *self.handle.lock().await = Some(handle);
        *self.shutdown.lock().await = Some(tx);

        Ok((token, bound))
    }

    pub async fn stop(&self) {
        if let Some(tx) = self.shutdown.lock().await.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.lock().await.take() {
            let _ = h.await;
        }
        *self.port.write().await = 0;
    }
}

impl Default for McpServer {
    fn default() -> Self {
        Self::new()
    }
}

struct HandlerContext {
    app_handle: AppHandle,
    token: String,
}

// -------------------------------------------------------------------- jobs

/// Finished jobs kept in the registry before the oldest one is evicted.
const JOB_HISTORY: usize = 50;
/// How long a tool call blocks waiting for its own job before handing back
/// a `job_id`. Well under any client-side tool timeout.
const DEFAULT_WAIT_SECS: u64 = 25;
const MAX_WAIT_SECS: u64 = 60;

enum JobState {
    Running { progress: Option<JsonValue> },
    Done(JsonValue),
    Failed(String),
}

pub struct Job {
    tool: String,
    started: Instant,
    /// std mutex, not tokio: the Tauri event listener that feeds progress
    /// in is a sync closure and cannot await.
    state: std::sync::Mutex<JobState>,
    /// Woken when `state` leaves `Running`.
    notify: Notify,
    /// Transfers cancel cooperatively through their own control; everything
    /// else is aborted at the task level.
    control: Option<Arc<crate::data_transfer::TransferControl>>,
    abort: std::sync::Mutex<Option<tokio::task::AbortHandle>>,
}

impl Job {
    fn is_running(&self) -> bool {
        matches!(&*self.state.lock().unwrap(), JobState::Running { .. })
    }

    fn snapshot(&self, job_id: &str) -> JsonValue {
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        let base = |status: &str| {
            json!({
                "job_id": job_id,
                "tool": self.tool,
                "status": status,
                "elapsed_ms": elapsed_ms,
            })
        };
        match &*self.state.lock().unwrap() {
            JobState::Running { progress } => {
                let mut v = base("running");
                if let Some(p) = progress {
                    v["progress"] = p.clone();
                }
                v
            }
            JobState::Done(result) => {
                let mut v = base("done");
                v["result"] = result.clone();
                v
            }
            JobState::Failed(err) => {
                let mut v = base("failed");
                v["error"] = json!(err);
                v
            }
        }
    }

    /// Same as `snapshot` minus the result payload, which can be large.
    fn summary(&self, job_id: &str) -> JsonValue {
        let status = match &*self.state.lock().unwrap() {
            JobState::Running { .. } => "running",
            JobState::Done(_) => "done",
            JobState::Failed(_) => "failed",
        };
        json!({
            "job_id": job_id,
            "tool": self.tool,
            "status": status,
            "elapsed_ms": self.started.elapsed().as_millis() as u64,
        })
    }

    fn finish(&self, outcome: Result<JsonValue, String>) {
        {
            let mut st = self.state.lock().unwrap();
            *st = match outcome {
                Ok(v) => JobState::Done(v),
                Err(e) => JobState::Failed(e),
            };
        }
        self.notify.notify_waiters();
    }
}

fn wait_duration(args: &JsonValue) -> Duration {
    let secs = args
        .get("wait_seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_WAIT_SECS)
        .min(MAX_WAIT_SECS);
    Duration::from_secs(secs)
}

/// Blocks up to `dur` for the job to leave `Running`.
async fn wait_for_job(job: &Arc<Job>, dur: Duration) {
    let _ = tokio::time::timeout(dur, async {
        loop {
            // Register before checking so a completion that lands in
            // between still wakes us.
            let notified = job.notify.notified();
            if !job.is_running() {
                return;
            }
            notified.await;
        }
    })
    .await;
}

/// Spawns `fut` as a detached job, waits `wait` for it, and returns either
/// the finished payload or the job handle to poll. The task outlives the
/// HTTP request, so a client giving up never cancels the work.
async fn run_as_job<F>(
    ctx: &HandlerContext,
    tool: &str,
    job_id: String,
    control: Option<Arc<crate::data_transfer::TransferControl>>,
    wait: Duration,
    fut: F,
) -> Result<JsonValue, String>
where
    F: std::future::Future<Output = Result<JsonValue, String>> + Send + 'static,
{
    let job = Arc::new(Job {
        tool: tool.to_string(),
        started: Instant::now(),
        state: std::sync::Mutex::new(JobState::Running { progress: None }),
        notify: Notify::new(),
        control,
        abort: std::sync::Mutex::new(None),
    });

    let registry = {
        let state = ctx.app_handle.state::<AppState>();
        state.inner().mcp.jobs.clone()
    };
    {
        let mut map = registry.write().await;
        map.insert(job_id.clone(), job.clone());
        evict_finished(&mut map);
    }

    // Transfer progress arrives as Tauri events; mirror the aggregate into
    // the job so `job_status` can report it.
    let listener = if job.control.is_some() {
        let job_for_ev = job.clone();
        let run_id = job_id.clone();
        Some(ctx.app_handle.listen("transfer:progress", move |ev| {
            let Ok(p) = serde_json::from_str::<JsonValue>(ev.payload()) else {
                return;
            };
            if p.get("run_id").and_then(|v| v.as_str()) != Some(run_id.as_str()) {
                return;
            }
            if let Ok(mut st) = job_for_ev.state.lock() {
                if let JobState::Running { progress } = &mut *st {
                    *progress = Some(p);
                }
            }
        }))
    } else {
        None
    };

    let inner = tokio::spawn(fut);
    *job.abort.lock().unwrap() = Some(inner.abort_handle());

    // Supervisor: whatever happens to the work task (finish, abort, panic),
    // the job leaves `Running` and the run's control is dropped. Without it
    // a panicking transfer would be polled forever.
    let job_for_task = job.clone();
    let app_for_task = ctx.app_handle.clone();
    let run_id = job_id.clone();
    tokio::spawn(async move {
        let outcome = match inner.await {
            Ok(r) => r,
            Err(e) if e.is_cancelled() => Err("cancelled".to_string()),
            Err(e) => Err(format!("job panicked: {}", e)),
        };
        if let Some(id) = listener {
            app_for_task.unlisten(id);
        }
        let state = app_for_task.state::<AppState>();
        state.inner().transfer_runs.write().await.remove(&run_id);
        job_for_task.finish(outcome);
    });

    wait_for_job(&job, wait).await;
    let out = match &*job.state.lock().unwrap() {
        JobState::Failed(e) => Err(e.clone()),
        JobState::Done(v) => {
            let mut out = v.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.insert("job_id".into(), json!(job_id));
                obj.insert("status".into(), json!("done"));
            }
            Ok(out)
        }
        JobState::Running { .. } => Ok(json!({
            "job_id": job_id,
            "tool": tool,
            "status": "running",
            "note": "still running; poll with job_status (it long-polls, so a single call can wait out short jobs) or stop it with job_cancel",
        })),
    };
    out
}

async fn get_job(app: &AppState, job_id: &str) -> Result<Arc<Job>, String> {
    app.mcp
        .jobs
        .read()
        .await
        .get(job_id)
        .cloned()
        .ok_or_else(|| format!("unknown job: {}", job_id))
}

fn evict_finished(map: &mut HashMap<String, Arc<Job>>) {
    while map.len() > JOB_HISTORY {
        let oldest = map
            .iter()
            .filter(|(_, j)| !j.is_running())
            .min_by_key(|(_, j)| j.started)
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                map.remove(&k);
            }
            None => break,
        }
    }
}


fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), StatusCode> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let want = format!("Bearer {}", expected);
    if ct_eq(auth.as_bytes(), want.as_bytes()) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Constant-time byte comparison for the bearer token. Avoids the
/// early-return timing leak of `==`. The length is not secret (fixed-width
/// hex token), so an upfront length check is acceptable.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn health_handler(
    AxumState(ctx): AxumState<Arc<HandlerContext>>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, StatusCode> {
    check_auth(&headers, &ctx.token)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RpcRequest {
    #[serde(default)]
    jsonrpc: String,
    #[serde(default)]
    id: JsonValue,
    method: String,
    #[serde(default)]
    params: JsonValue,
}

#[derive(Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    id: JsonValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

async fn rpc_handler(
    AxumState(ctx): AxumState<Arc<HandlerContext>>,
    headers: HeaderMap,
    Json(req): Json<RpcRequest>,
) -> impl IntoResponse {
    if let Err(code) = check_auth(&headers, &ctx.token) {
        return (code, Json(json!({ "error": "unauthorized" })))
            .into_response();
    }
    let _ = req.jsonrpc;
    let id = req.id.clone();
    match dispatch(&ctx, &req.method, &req.params).await {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::to_value(RpcResponse {
                jsonrpc: "2.0",
                id,
                result: Some(result),
                error: None,
            }).unwrap()),
        )
            .into_response(),
        Err(msg) => (
            StatusCode::OK,
            Json(serde_json::to_value(RpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(RpcError {
                    code: -32000,
                    message: msg,
                }),
            }).unwrap()),
        )
            .into_response(),
    }
}

async fn dispatch(
    ctx: &HandlerContext,
    method: &str,
    params: &JsonValue,
) -> Result<JsonValue, String> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "basemaster",
                "version": env!("CARGO_PKG_VERSION"),
            }
        })),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing tool name".to_string())?;
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(JsonValue::Null);
            // Wrap the tool output in an MCP `CallToolResult`. The handlers return
            // the payload directly, but the spec requires `tools/call` results to
            // expose the data under `content` (text block) — clients such as Claude
            // Code render `content`/`structuredContent` and show nothing otherwise.
            let payload = call_tool(ctx, name, args).await?;
            let text = serde_json::to_string_pretty(&payload)
                .unwrap_or_else(|_| payload.to_string());
            Ok(json!({
                "content": [{ "type": "text", "text": text }],
                "structuredContent": payload,
                "isError": false
            }))
        }
        other => Err(format!("unknown method: {}", other)),
    }
}

fn tool_definitions() -> JsonValue {
    json!([
        {
            "name": "list_connections",
            "description": "List saved database connection profiles (no passwords).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "open_connection",
            "description": "Open a saved connection by id (stored credentials, SSH/SSM tunnel if configured). Optional: every tool that takes a connection_id opens it on demand.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" }
                },
                "required": ["connection_id"]
            }
        },
        {
            "name": "close_connection",
            "description": "Close an open connection.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" }
                },
                "required": ["connection_id"]
            }
        },
        {
            "name": "list_schemas",
            "description": "List schemas/databases on a connection.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" }
                },
                "required": ["connection_id"]
            }
        },
        {
            "name": "list_tables",
            "description": "List tables + views of a schema.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" },
                    "schema": { "type": "string" }
                },
                "required": ["connection_id", "schema"]
            }
        },
        {
            "name": "describe_table",
            "description": "Describe columns of a table.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" },
                    "schema": { "type": "string" },
                    "table": { "type": "string" }
                },
                "required": ["connection_id", "schema", "table"]
            }
        },
        {
            "name": "get_table_ddl",
            "description": "Get CREATE TABLE DDL for a table.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" },
                    "schema": { "type": "string" },
                    "table": { "type": "string" }
                },
                "required": ["connection_id", "schema", "table"]
            }
        },
        {
            "name": "run_query",
            "description": "Execute SQL on a connection. Returns columns + up to max_rows rows.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" },
                    "schema": { "type": "string" },
                    "sql": { "type": "string" },
                    "max_rows": { "type": "integer", "default": 500 },
                    "wait_seconds": { "type": "integer", "default": 25, "description": "How long to wait inline before returning a job_id to poll with job_status. Max 60." }
                },
                "required": ["connection_id", "sql"]
            }
        },
        {
            "name": "run_query_to_file",
            "description": "Execute SQL and stream the result to a file (jsonl or csv). Returns path, row/byte count, sha256 and a small in-memory sample. Use this instead of run_query when you expect a large result or need to persist the output without round-tripping it through the model.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" },
                    "schema": { "type": "string" },
                    "sql": { "type": "string" },
                    "path": { "type": "string", "description": "Absolute filesystem path where the result will be written." },
                    "format": { "type": "string", "enum": ["jsonl", "csv"], "default": "jsonl" },
                    "sample_rows": { "type": "integer", "default": 20, "description": "Number of rows to include verbatim in the return payload." },
                    "wait_seconds": { "type": "integer", "default": 25, "description": "How long to wait inline before returning a job_id to poll with job_status. Max 60." }
                },
                "required": ["connection_id", "sql", "path"]
            }
        },
        {
            "name": "transfer_tables",
            "description": "Copy tables from one connection to another (structure and/or rows), the same engine the Data Transfer window uses. Cross-dialect copies (MySQL <-> Postgres) are translated. Big transfers keep running in the background: if the copy is still going after wait_seconds the call returns {job_id, status:'running'} and you poll it with job_status (or stop it with job_cancel), so a slow transfer never trips the client tool timeout. Guardrails apply to the TARGET connection: creating/dropping tables needs DDL allowed, copying rows needs DML allowed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source_connection_id": { "type": "string" },
                    "source_schema": { "type": "string" },
                    "target_connection_id": { "type": "string" },
                    "target_schema": { "type": "string" },
                    "tables": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Tables to copy. Omit to copy every base table of source_schema (views are skipped)."
                    },
                    "create_tables": { "type": "boolean", "default": true, "description": "CREATE TABLE on the target from the source DDL." },
                    "drop_target": { "type": "boolean", "default": false, "description": "DROP TABLE on the target first. Destructive." },
                    "empty_target": { "type": "boolean", "default": false, "description": "DELETE FROM the target table before inserting. Destructive." },
                    "create_records": { "type": "boolean", "default": true, "description": "Copy rows. false = structure only." },
                    "insert_mode": { "type": "string", "enum": ["insert", "insert_ignore", "replace"], "default": "insert" },
                    "continue_on_error": { "type": "boolean", "default": false },
                    "concurrency": { "type": "integer", "default": 1, "description": "Tables copied in parallel (1-16)." },
                    "chunk_size": { "type": "integer", "default": 1000 },
                    "wait_seconds": { "type": "integer", "default": 25, "description": "How long to wait inline before returning a job_id to poll with job_status. Max 60." }
                },
                "required": [
                    "source_connection_id",
                    "source_schema",
                    "target_connection_id",
                    "target_schema"
                ]
            }
        },
        {
            "name": "job_status",
            "description": "Poll a job started by run_query, run_query_to_file or transfer_tables. Long-polls: it blocks up to wait_seconds for the job to finish, so calling it in a loop is cheap. Returns status running|done|failed, elapsed_ms, the last progress event (transfers) and the full result once done.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "job_id": { "type": "string" },
                    "wait_seconds": { "type": "integer", "default": 25, "description": "Max seconds to block waiting for completion. 0 returns immediately. Max 60." }
                },
                "required": ["job_id"]
            }
        },
        {
            "name": "job_list",
            "description": "List the jobs this server knows about (running first, then recently finished), without their result payloads.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "job_cancel",
            "description": "Stop a running job. Transfers stop cooperatively between batches and still report what was copied; other jobs are aborted outright.",
            "inputSchema": {
                "type": "object",
                "properties": { "job_id": { "type": "string" } },
                "required": ["job_id"]
            }
        }
    ])
}

async fn call_tool(
    ctx: &HandlerContext,
    name: &str,
    args: JsonValue,
) -> Result<JsonValue, String> {
    let state = ctx.app_handle.state::<AppState>();
    let app: &AppState = state.inner();
    match name {
        "list_connections" => {
            let list = app
                .store
                .connections()
                .list()
                .await
                .map_err(|e| e.to_string())?;
            // Return only the essentials — no passwords.
            let items: Vec<_> = list
                .into_iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "name": c.name,
                        "driver": c.driver,
                        "host": c.host,
                        "port": c.port,
                        "default_database": c.default_database,
                    })
                })
                .collect();
            Ok(json!({ "connections": items }))
        }
        "open_connection" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            open_connection_impl(&ctx.app_handle, app, id).await?;
            Ok(json!({ "ok": true }))
        }
        "close_connection" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let driver = app.active.write().await.remove(&id);
            if let Some(driver) = driver {
                let _ = driver.disconnect().await;
            }
            let tunnel = app.tunnels.write().await.remove(&id);
            if let Some(t) = tunnel {
                t.close().await;
            }
            Ok(json!({ "ok": true }))
        }
        "list_schemas" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let driver = get_active(&ctx.app_handle, app, id).await?;
            let schemas = driver
                .list_schemas()
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "schemas": schemas }))
        }
        "list_tables" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let schema = parse_str(&args, "schema")?;
            let driver = get_active(&ctx.app_handle, app, id).await?;
            let tables = driver
                .list_tables(&schema)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "tables": tables }))
        }
        "describe_table" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let schema = parse_str(&args, "schema")?;
            let table = parse_str(&args, "table")?;
            let driver = get_active(&ctx.app_handle, app, id).await?;
            let cols = driver
                .describe_table(&schema, &table)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "columns": cols }))
        }
        "get_table_ddl" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let schema = parse_str(&args, "schema")?;
            let table = parse_str(&args, "table")?;
            let driver = get_active(&ctx.app_handle, app, id).await?;
            let ddl = driver
                .get_table_ddl(&schema, &table)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ddl": ddl }))
        }
        "run_query" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let sql = parse_str(&args, "sql")?;
            let max_rows = args
                .get("max_rows")
                .and_then(|v| v.as_u64())
                .unwrap_or(500) as usize;
            check_sql_allowed(&sql, &load_guardrail_policy(app, id).await)?;
            let driver = get_active(&ctx.app_handle, app, id).await?;
            let wait = wait_duration(&args);
            run_as_job(
                ctx,
                "run_query",
                Uuid::new_v4().to_string(),
                None,
                wait,
                async move {
                    let result = driver
                        .query(schema.as_deref(), &sql)
                        .await
                        .map_err(|e| e.to_string())?;
                    let truncated = result.rows.len() > max_rows;
                    let rows = result
                        .rows
                        .iter()
                        .take(max_rows)
                        .cloned()
                        .collect::<Vec<_>>();
                    Ok(json!({
                        "columns": result.columns,
                        "rows": rows,
                        "elapsed_ms": result.elapsed_ms,
                        "truncated": truncated,
                        "total_rows": result.rows.len(),
                    }))
                },
            )
            .await
        }
        "run_query_to_file" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let sql = parse_str(&args, "sql")?;
            let path = parse_str(&args, "path")?;
            let format = args
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("jsonl")
                .to_string();
            let sample_rows = args
                .get("sample_rows")
                .and_then(|v| v.as_u64())
                .unwrap_or(20) as usize;
            check_sql_allowed(&sql, &load_guardrail_policy(app, id).await)?;
            let driver = get_active(&ctx.app_handle, app, id).await?;
            let fmt = crate::query_export::ExportFormat::parse(&format)?;
            let wait = wait_duration(&args);
            run_as_job(
                ctx,
                "run_query_to_file",
                Uuid::new_v4().to_string(),
                None,
                wait,
                async move {
                    let result = crate::query_export::export_query(
                        driver.as_ref(),
                        schema.as_deref(),
                        &sql,
                        std::path::Path::new(&path),
                        fmt,
                        sample_rows,
                    )
                    .await?;
                    serde_json::to_value(result).map_err(|e| e.to_string())
                },
            )
            .await
        }
        "transfer_tables" => {
            let source_id: Uuid = parse_uuid(&args, "source_connection_id")?;
            let target_id: Uuid = parse_uuid(&args, "target_connection_id")?;
            let source_schema = parse_str(&args, "source_schema")?;
            let target_schema = parse_str(&args, "target_schema")?;
            let source = get_active(&ctx.app_handle, app, source_id).await?;
            let target = get_active(&ctx.app_handle, app, target_id).await?;

            let flag =
                |k: &str, d: bool| args.get(k).and_then(|v| v.as_bool()).unwrap_or(d);
            let create_tables = flag("create_tables", true);
            let drop_target = flag("drop_target", false);
            let empty_target = flag("empty_target", false);
            let create_records = flag("create_records", true);

            // The transfer engine writes without ever handing us SQL to
            // classify, so the guardrails are applied to the declared intent
            // instead — against the TARGET connection's policy, since that's
            // the side being written.
            let policy = load_guardrail_policy(app, target_id).await;
            if (create_tables || drop_target) && policy.block_ddl {
                return Err("MCP guardrail blocked schema-changing (CREATE/DROP/ALTER/...) statement. Enable it in Settings → MCP to allow.".into());
            }
            if (create_records || empty_target) && policy.block_dml {
                return Err("MCP guardrail blocked data-modifying (INSERT/UPDATE/DELETE/...) statement. Enable it in Settings → MCP to allow.".into());
            }

            let tables: Vec<String> = match args.get("tables").and_then(|v| v.as_array()) {
                Some(a) if !a.is_empty() => a
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect(),
                _ => source
                    .list_tables(&source_schema)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|t| matches!(t.kind, basemaster_core::TableKind::Table))
                    .map(|t| t.name)
                    .collect(),
            };
            if tables.is_empty() {
                return Err(format!("nenhuma tabela pra transferir em {}", source_schema));
            }
            let table_count = tables.len();

            // Own run id: keeps this transfer's events and its pause/stop
            // control separate from anything running in the GUI.
            let run_id = Uuid::new_v4().to_string();
            let mut opts_json = json!({
                "run_id": run_id,
                "source_connection_id": source_id,
                "source_schema": source_schema,
                "target_connection_id": target_id,
                "target_schema": target_schema,
                "tables": tables,
                "create_tables": create_tables,
                "drop_target": drop_target,
                "empty_target": empty_target,
                "create_records": create_records,
                "continue_on_error": flag("continue_on_error", false),
            });
            for k in ["insert_mode", "concurrency", "chunk_size"] {
                if let Some(v) = args.get(k) {
                    opts_json[k] = v.clone();
                }
            }
            let opts: crate::data_transfer::TransferOptions =
                serde_json::from_value(opts_json)
                    .map_err(|e| format!("invalid options: {}", e))?;

            let control = Arc::new(crate::data_transfer::TransferControl::new());
            app.transfer_runs
                .write()
                .await
                .insert(run_id.clone(), control.clone());
            let app_handle = ctx.app_handle.clone();
            let wait = wait_duration(&args);
            let job_run_id = run_id.clone();
            run_as_job(
                ctx,
                "transfer_tables",
                run_id,
                Some(control.clone()),
                wait,
                async move {
                    let done = crate::data_transfer::run_transfer(
                        app_handle, opts, source, target, control,
                    )
                    .await?;
                    Ok(json!({
                        "run_id": job_run_id,
                        "tables": table_count,
                        "total_rows": done.total_rows,
                        "failed": done.failed,
                        "elapsed_ms": done.elapsed_ms,
                    }))
                },
            )
            .await
        }
        "job_status" => {
            let job_id = parse_str(&args, "job_id")?;
            let job = get_job(app, &job_id).await?;
            wait_for_job(&job, wait_duration(&args)).await;
            Ok(job.snapshot(&job_id))
        }
        "job_list" => {
            let jobs = app.mcp.jobs.read().await;
            let mut list: Vec<(bool, std::time::Instant, JsonValue)> = jobs
                .iter()
                .map(|(id, j)| (j.is_running(), j.started, j.summary(id)))
                .collect();
            // Running first, then most recently started.
            list.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
            Ok(json!({
                "jobs": list.into_iter().map(|(_, _, v)| v).collect::<Vec<_>>(),
            }))
        }
        "job_cancel" => {
            let job_id = parse_str(&args, "job_id")?;
            let job = get_job(app, &job_id).await?;
            if !job.is_running() {
                return Ok(json!({ "job_id": job_id, "status": "already finished" }));
            }
            let how = match &job.control {
                // Cooperative: the transfer engine stops between batches and
                // still reports the totals it managed to copy.
                Some(c) => {
                    c.request_stop();
                    "stop requested"
                }
                None => {
                    if let Some(h) = job.abort.lock().unwrap().take() {
                        h.abort();
                    }
                    "aborted"
                }
            };
            Ok(json!({ "job_id": job_id, "cancel": how }))
        }
        other => Err(format!("unknown tool: {}", other)),
    }
}

/// Opens the connection through the same tunnel-aware path the UI uses
/// (SSH / SSM / HTTP proxy + keyring secrets). An unknown SSH host key pops
/// the normal trust prompt in the app window.
async fn open_connection_impl(
    app_handle: &AppHandle,
    app: &AppState,
    id: Uuid,
) -> Result<(), String> {
    if app.active.read().await.contains_key(&id) {
        return Ok(());
    }
    let (driver, tunnel, _effective) = crate::commands::open_driver_with_tunnel(
        &app.store,
        app.known_hosts.clone(),
        app.ssh_key_prompts.clone(),
        crate::ssh_tunnel::HostKeyPolicy::Prompt(app_handle.clone()),
        id,
    )
    .await?;
    // Two tool calls can race to open the same id; keep the first one.
    let mut active = app.active.write().await;
    if active.contains_key(&id) {
        drop(active);
        let _ = driver.disconnect().await;
        if let Some(t) = tunnel {
            t.close().await;
        }
        return Ok(());
    }
    active.insert(id, driver);
    drop(active);
    if let Some(t) = tunnel {
        app.tunnels.write().await.insert(id, t);
    }
    let _ = app.store.connections().touch(id).await;
    Ok(())
}

/// Returns the live driver, opening the saved connection on demand.
async fn get_active(
    app_handle: &AppHandle,
    app: &AppState,
    id: Uuid,
) -> Result<Arc<dyn basemaster_core::Driver>, String> {
    if let Some(d) = app.active.read().await.get(&id).cloned() {
        return Ok(d);
    }
    open_connection_impl(app_handle, app, id).await?;
    app.active
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "connection closed while opening".into())
}

fn parse_uuid(args: &JsonValue, key: &str) -> Result<Uuid, String> {
    let s = args
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing {}", key))?;
    Uuid::parse_str(s).map_err(|e| format!("invalid uuid: {}", e))
}

fn parse_str(args: &JsonValue, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("missing {}", key))
}

// ---------------------------------------------------------------- guardrails
//
// MCP exposes `run_query` with arbitrary SQL. By default the server is
// read-only: each statement is classified by its leading keyword and blocked
// if its category is disabled. Settings are global (keyring/store), default
// all-blocked, toggled from the Settings → MCP panel.

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct GuardrailPolicy {
    pub block_dml: bool,
    pub block_ddl: bool,
    pub block_perms: bool,
    pub block_tx: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StmtClass {
    Read,
    Dml,
    Ddl,
    Perms,
    Tx,
    Unknown,
}

/// Resolves the effective guardrail policy for a connection. A per-connection
/// `McpAccess` of `ReadOnly`/`Custom` overrides the global settings; `Inherit`
/// (the default) falls back to them. A missing/unreadable profile fails closed
/// to the global policy.
async fn load_guardrail_policy(app: &AppState, conn_id: Uuid) -> GuardrailPolicy {
    let access = app
        .store
        .connections()
        .get(conn_id)
        .await
        .map(|p| p.mcp_access)
        .unwrap_or_default();
    match access {
        basemaster_core::McpAccess::ReadOnly => GuardrailPolicy {
            block_dml: true,
            block_ddl: true,
            block_perms: true,
            block_tx: true,
        },
        basemaster_core::McpAccess::Custom {
            block_dml,
            block_ddl,
            block_perms,
            block_tx,
        } => GuardrailPolicy {
            block_dml,
            block_ddl,
            block_perms,
            block_tx,
        },
        basemaster_core::McpAccess::Inherit => load_global_guardrail_policy(app).await,
    }
}

/// Guardrail policy for the in-app AI agent. Unlike MCP, the agent already
/// gates every write behind an explicit user-approval modal, so an `Inherit`
/// connection (the default) is left fully open — approval is the control.
/// An explicit per-connection `ReadOnly`/`Custom` access still constrains the
/// agent: a prod-locked connection can't be written even with approval.
async fn load_agent_policy(app: &AppState, conn_id: Uuid) -> GuardrailPolicy {
    let access = app
        .store
        .connections()
        .get(conn_id)
        .await
        .map(|p| p.mcp_access)
        .unwrap_or_default();
    match access {
        basemaster_core::McpAccess::ReadOnly => GuardrailPolicy {
            block_dml: true,
            block_ddl: true,
            block_perms: true,
            block_tx: true,
        },
        basemaster_core::McpAccess::Custom {
            block_dml,
            block_ddl,
            block_perms,
            block_tx,
        } => GuardrailPolicy {
            block_dml,
            block_ddl,
            block_perms,
            block_tx,
        },
        basemaster_core::McpAccess::Inherit => GuardrailPolicy {
            block_dml: false,
            block_ddl: false,
            block_perms: false,
            block_tx: false,
        },
    }
}

/// Guardrail check for the in-app AI agent's raw-SQL write path.
pub(crate) async fn agent_check_sql(
    app: &AppState,
    conn_id: Uuid,
    sql: &str,
) -> Result<(), String> {
    check_sql_allowed(sql, &load_agent_policy(app, conn_id).await)
}

/// Effective agent policy, for tools that don't produce raw SQL (row ops).
pub(crate) async fn agent_policy(app: &AppState, conn_id: Uuid) -> GuardrailPolicy {
    load_agent_policy(app, conn_id).await
}

async fn load_global_guardrail_policy(app: &AppState) -> GuardrailPolicy {
    let s = app.store.settings();
    GuardrailPolicy {
        block_dml: s.get_bool("mcp.block_dml", true).await.unwrap_or(true),
        block_ddl: s.get_bool("mcp.block_ddl", true).await.unwrap_or(true),
        block_perms: s.get_bool("mcp.block_perms", true).await.unwrap_or(true),
        block_tx: s.get_bool("mcp.block_tx", true).await.unwrap_or(true),
    }
}

/// Rejects the SQL if any of its statements falls in a blocked category.
/// An unrecognized leading keyword is treated as blocked unless every
/// guardrail is off (fail-closed: don't let unknown writes slip through).
fn check_sql_allowed(sql: &str, policy: &GuardrailPolicy) -> Result<(), String> {
    let all_off = !(policy.block_dml
        || policy.block_ddl
        || policy.block_perms
        || policy.block_tx);
    for stmt in split_sql_statements(sql) {
        let class = classify_statement(&stmt);
        let blocked = match class {
            StmtClass::Read => false,
            StmtClass::Dml => policy.block_dml,
            StmtClass::Ddl => policy.block_ddl,
            StmtClass::Perms => policy.block_perms,
            StmtClass::Tx => policy.block_tx,
            StmtClass::Unknown => !all_off,
        };
        if blocked {
            let what = match class {
                StmtClass::Dml => "data-modifying (INSERT/UPDATE/DELETE/...)",
                StmtClass::Ddl => "schema-changing (CREATE/DROP/ALTER/...)",
                StmtClass::Perms => "permission (GRANT/REVOKE)",
                StmtClass::Tx => "transaction/control (COMMIT/SET/CALL/...)",
                _ => "unrecognized",
            };
            return Err(format!(
                "MCP guardrail blocked {} statement. Enable it in Settings → MCP to allow.",
                what
            ));
        }
    }
    Ok(())
}

/// Splits SQL on `;`, skipping `'`, `"`, backtick literals and `--` / `/* */`
/// comments so a separator inside a string/comment isn't treated as one.
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' | '`' => {
                cur.push(c);
                while let Some(n) = chars.next() {
                    cur.push(n);
                    if n == c {
                        // doubled quote = escaped, stay inside
                        if chars.peek() == Some(&c) {
                            cur.push(chars.next().unwrap());
                        } else {
                            break;
                        }
                    }
                }
            }
            '-' if chars.peek() == Some(&'-') => {
                chars.next();
                while let Some(&n) = chars.peek() {
                    if n == '\n' {
                        break;
                    }
                    chars.next();
                }
                cur.push(' ');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
                cur.push(' ');
            }
            ';' => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().filter(|s| !s.trim().is_empty()).collect()
}

fn classify_statement(stmt: &str) -> StmtClass {
    let words: Vec<String> = stmt
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_uppercase())
        .collect();
    let Some(first) = words.first().map(String::as_str) else {
        return StmtClass::Read;
    };
    match first {
        // `SELECT ... INTO <table>` (Postgres) creates a table; `SELECT ...
        // INTO OUTFILE/DUMPFILE` (MySQL) writes a file. Both write despite
        // the SELECT prefix, so treat any SELECT carrying INTO as DML.
        // `SELECT ... INTO @var` (a read) gets caught too — fail-closed.
        "SELECT" => {
            if words.iter().any(|w| w == "INTO") {
                StmtClass::Dml
            } else {
                StmtClass::Read
            }
        }
        // Plain EXPLAIN only plans the query. `EXPLAIN ANALYZE <write>`
        // EXECUTES the statement (Postgres always; MySQL 8.0.18+), so when
        // ANALYZE wraps a write, classify by the embedded statement.
        "EXPLAIN" => {
            if words.iter().any(|w| w == "ANALYZE") && has_embedded_dml(&words) {
                StmtClass::Dml
            } else {
                StmtClass::Read
            }
        }
        "SHOW" | "DESCRIBE" | "DESC" | "USE" | "PRAGMA" | "VALUES" | "TABLE" => {
            StmtClass::Read
        }
        // A CTE can wrap a write (Postgres `WITH ... DELETE`): scan deeper.
        "WITH" => {
            if has_embedded_dml(&words) {
                StmtClass::Dml
            } else {
                StmtClass::Read
            }
        }
        "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" | "REPLACE" | "MERGE"
        | "UPSERT" | "LOAD" | "COPY" => StmtClass::Dml,
        "CREATE" | "DROP" | "ALTER" | "RENAME" | "COMMENT" => StmtClass::Ddl,
        "GRANT" | "REVOKE" => StmtClass::Perms,
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE"
        | "SET" | "LOCK" | "UNLOCK" | "CALL" | "EXEC" | "EXECUTE" | "DO"
        | "PREPARE" | "DEALLOCATE" => StmtClass::Tx,
        _ => StmtClass::Unknown,
    }
}

/// True if any token is a data-modifying keyword. Used to look past a
/// leading `WITH` CTE or `EXPLAIN ANALYZE` that hides a write.
fn has_embedded_dml(words: &[String]) -> bool {
    words.iter().any(|w| {
        matches!(
            w.as_str(),
            "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" | "UPSERT"
        )
    })
}

pub fn random_hex_token(bytes: usize) -> String {
    // Source: Uuid::new_v4() provides 128 bits; concatenates until
    // reaching the requested size. Not a full CSPRNG but enough for a local token.
    let mut out = String::with_capacity(bytes * 2);
    while out.len() < bytes * 2 {
        let u = Uuid::new_v4();
        out.push_str(&u.simple().to_string());
    }
    out.truncate(bytes * 2);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK_ALL: GuardrailPolicy = GuardrailPolicy {
        block_dml: true,
        block_ddl: true,
        block_perms: true,
        block_tx: true,
    };
    const ALLOW_ALL: GuardrailPolicy = GuardrailPolicy {
        block_dml: false,
        block_ddl: false,
        block_perms: false,
        block_tx: false,
    };

    fn cls(sql: &str) -> StmtClass {
        classify_statement(sql)
    }

    #[test]
    fn classify_basic() {
        assert_eq!(cls("SELECT 1"), StmtClass::Read);
        assert_eq!(cls("  select * from t"), StmtClass::Read);
        assert_eq!(cls("SHOW TABLES"), StmtClass::Read);
        assert_eq!(cls("EXPLAIN DELETE FROM t"), StmtClass::Read);
        assert_eq!(cls("INSERT INTO t VALUES (1)"), StmtClass::Dml);
        assert_eq!(cls("update t set a=1"), StmtClass::Dml);
        assert_eq!(cls("TRUNCATE t"), StmtClass::Dml);
        assert_eq!(cls("CREATE TABLE t (id int)"), StmtClass::Ddl);
        assert_eq!(cls("DROP TABLE t"), StmtClass::Ddl);
        assert_eq!(cls("GRANT ALL ON t TO u"), StmtClass::Perms);
        assert_eq!(cls("COMMIT"), StmtClass::Tx);
        assert_eq!(cls("SET foreign_key_checks=0"), StmtClass::Tx);
        assert_eq!(cls("VACUUM"), StmtClass::Unknown);
    }

    #[test]
    fn explain_analyze_write_is_not_read() {
        // Plain EXPLAIN only plans → Read.
        assert_eq!(cls("EXPLAIN SELECT * FROM t"), StmtClass::Read);
        assert_eq!(cls("EXPLAIN DELETE FROM t"), StmtClass::Read);
        assert_eq!(cls("EXPLAIN (FORMAT JSON) SELECT 1"), StmtClass::Read);
        // EXPLAIN ANALYZE executes the inner write → classified DML.
        assert_eq!(cls("EXPLAIN ANALYZE DELETE FROM t"), StmtClass::Dml);
        assert_eq!(cls("EXPLAIN (ANALYZE) UPDATE t SET a=1"), StmtClass::Dml);
        assert_eq!(cls("EXPLAIN ANALYZE INSERT INTO t VALUES (1)"), StmtClass::Dml);
        // ANALYZE around a pure read stays Read.
        assert_eq!(cls("EXPLAIN ANALYZE SELECT * FROM t"), StmtClass::Read);
    }

    #[test]
    fn select_into_writes() {
        // SELECT ... INTO creates a table (PG) / writes a file (MySQL).
        assert_eq!(cls("SELECT * INTO new_t FROM t"), StmtClass::Dml);
        assert_eq!(cls("SELECT a FROM t INTO OUTFILE '/tmp/x'"), StmtClass::Dml);
        // Plain SELECT stays Read.
        assert_eq!(cls("SELECT * FROM t"), StmtClass::Read);
    }

    #[test]
    fn guardrail_blocks_explain_analyze_and_select_into() {
        assert!(check_sql_allowed("EXPLAIN ANALYZE DELETE FROM t", &BLOCK_ALL).is_err());
        assert!(check_sql_allowed("SELECT * INTO x FROM t", &BLOCK_ALL).is_err());
        // Plain reads still pass.
        assert!(check_sql_allowed("EXPLAIN SELECT 1", &BLOCK_ALL).is_ok());
    }

    #[test]
    fn classify_cte() {
        assert_eq!(cls("WITH x AS (SELECT 1) SELECT * FROM x"), StmtClass::Read);
        assert_eq!(
            cls("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"),
            StmtClass::Dml
        );
    }

    #[test]
    fn split_respects_quotes_and_comments() {
        let s = split_sql_statements("SELECT ';'; SELECT 2 -- ; not a split\n;");
        assert_eq!(s.len(), 2);
        let s = split_sql_statements("SELECT 1 /* ; */ ; SELECT 2");
        assert_eq!(s.len(), 2);
        // escaped quote stays inside the literal
        let s = split_sql_statements("SELECT 'a''b;c'");
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn block_all_allows_only_reads() {
        assert!(check_sql_allowed("SELECT 1", &BLOCK_ALL).is_ok());
        assert!(check_sql_allowed("DELETE FROM t", &BLOCK_ALL).is_err());
        assert!(check_sql_allowed("DROP TABLE t", &BLOCK_ALL).is_err());
        assert!(check_sql_allowed("GRANT ALL ON t TO u", &BLOCK_ALL).is_err());
        assert!(check_sql_allowed("SET x=1", &BLOCK_ALL).is_err());
        // unknown keyword fails closed when any guardrail is on
        assert!(check_sql_allowed("VACUUM", &BLOCK_ALL).is_err());
    }

    #[test]
    fn allow_all_passes_everything() {
        assert!(check_sql_allowed("DELETE FROM t", &ALLOW_ALL).is_ok());
        assert!(check_sql_allowed("DROP TABLE t", &ALLOW_ALL).is_ok());
        assert!(check_sql_allowed("VACUUM", &ALLOW_ALL).is_ok());
    }

    #[test]
    fn multi_statement_blocks_if_any_blocked() {
        // a SELECT followed by a hidden DELETE must be rejected
        let sql = "SELECT 1; DELETE FROM t";
        assert!(check_sql_allowed(sql, &BLOCK_ALL).is_err());
    }

    #[test]
    fn selective_policy() {
        let dml_only = GuardrailPolicy {
            block_dml: true,
            block_ddl: false,
            block_perms: false,
            block_tx: false,
        };
        assert!(check_sql_allowed("DELETE FROM t", &dml_only).is_err());
        assert!(check_sql_allowed("DROP TABLE t", &dml_only).is_ok());
        // unknown allowed because not every guardrail is off? no — fail-closed
        // only when ALL off; here one is on, so unknown blocked.
        assert!(check_sql_allowed("VACUUM", &dml_only).is_err());
    }

    fn job(tool: &str) -> Arc<Job> {
        Arc::new(Job {
            tool: tool.to_string(),
            started: Instant::now(),
            state: std::sync::Mutex::new(JobState::Running { progress: None }),
            notify: Notify::new(),
            control: None,
            abort: std::sync::Mutex::new(None),
        })
    }

    #[test]
    fn wait_seconds_clamped() {
        assert_eq!(
            wait_duration(&json!({})),
            Duration::from_secs(DEFAULT_WAIT_SECS)
        );
        assert_eq!(wait_duration(&json!({ "wait_seconds": 0 })), Duration::ZERO);
        assert_eq!(
            wait_duration(&json!({ "wait_seconds": 9999 })),
            Duration::from_secs(MAX_WAIT_SECS)
        );
    }

    #[tokio::test]
    async fn wait_returns_when_job_finishes() {
        let j = job("run_query");
        let j2 = j.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            j2.finish(Ok(json!({ "rows": 3 })));
        });
        wait_for_job(&j, Duration::from_secs(5)).await;
        assert!(!j.is_running());
        assert_eq!(j.snapshot("x")["result"]["rows"], json!(3));
    }

    #[tokio::test]
    async fn wait_times_out_while_running() {
        let j = job("transfer_tables");
        wait_for_job(&j, Duration::from_millis(20)).await;
        assert!(j.is_running());
        assert_eq!(j.snapshot("x")["status"], json!("running"));
    }

    #[test]
    fn evict_keeps_running_jobs() {
        let mut map: HashMap<String, Arc<Job>> = HashMap::new();
        for i in 0..(JOB_HISTORY + 10) {
            let j = job("run_query");
            j.finish(Ok(json!(i)));
            map.insert(format!("done-{}", i), j);
        }
        map.insert("live".into(), job("transfer_tables"));
        evict_finished(&mut map);
        assert_eq!(map.len(), JOB_HISTORY);
        assert!(map.contains_key("live"));
    }
}
