//! Local MCP (Model Context Protocol) server.
//!
//! Exposes a subset of MCP over HTTP JSON-RPC 2.0 on 127.0.0.1:<port>.
//! The caller passes in the auth token (persisted in the OS keyring) —
//! any MCP client that configures the token + URL can access it.
//!
//! Exposed tools:
//!  - `list_connections` — saved connections (without passwords).
//!  - `open_connection` / `close_connection` — controls which conn is alive.
//!  - `list_schemas`, `list_tables`, `describe_table`, `get_table_ddl`.
//!  - `run_query` — runs arbitrary SQL, returns bounded rows.
//!
//! Security:
//!  - Bind on 127.0.0.1 only (never 0.0.0.0).
//!  - Bearer token required on every request.
//!  - Random 32-byte token, persisted in the keyring, regenerated only
//!    on explicit user request (so client config survives restarts).

use std::sync::Arc;

use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, RwLock};
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
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            port: Arc::new(RwLock::new(0)),
            handle: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(Mutex::new(None)),
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
            "description": "Open a connection by id (uses stored credentials from keyring).",
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
            "description": "List schemas/databases on an open connection.",
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
            "description": "Execute SQL on an open connection. Returns columns + up to max_rows rows.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": { "type": "string" },
                    "schema": { "type": "string" },
                    "sql": { "type": "string" },
                    "max_rows": { "type": "integer", "default": 500 }
                },
                "required": ["connection_id", "sql"]
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
            // Reuses the command's logic — we need to call the same path.
            // Here's a simplified replica: get profile, build config
            // with the keyring password, call driver.connect.
            open_connection_impl(app, id).await?;
            Ok(json!({ "ok": true }))
        }
        "close_connection" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let mut active = app.active.write().await;
            if let Some(driver) = active.remove(&id) {
                let _ = driver.disconnect().await;
            }
            Ok(json!({ "ok": true }))
        }
        "list_schemas" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let driver = get_active(app, id).await?;
            let schemas = driver
                .list_schemas()
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "schemas": schemas }))
        }
        "list_tables" => {
            let id: Uuid = parse_uuid(&args, "connection_id")?;
            let schema = parse_str(&args, "schema")?;
            let driver = get_active(app, id).await?;
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
            let driver = get_active(app, id).await?;
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
            let driver = get_active(app, id).await?;
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
            check_sql_allowed(&sql, &load_guardrail_policy(app).await)?;
            let driver = get_active(app, id).await?;
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
        }
        other => Err(format!("unknown tool: {}", other)),
    }
}

async fn open_connection_impl(app: &AppState, id: Uuid) -> Result<(), String> {
    if app.active.read().await.contains_key(&id) {
        return Ok(());
    }
    let profile = app
        .store
        .connections()
        .get(id)
        .await
        .map_err(|e| e.to_string())?;
    let driver_kind = profile.driver.clone();
    let driver = crate::state::make_driver(&driver_kind)
        .ok_or_else(|| format!("driver não suportado: {}", driver_kind))?;
    let password =
        basemaster_store::secrets::get_password(id).unwrap_or_default();
    let config = profile.into_config(password);
    driver
        .connect(&config)
        .await
        .map_err(|e| e.to_string())?;
    app.active.write().await.insert(id, driver);
    Ok(())
}

async fn get_active(
    app: &AppState,
    id: Uuid,
) -> Result<Arc<dyn basemaster_core::Driver>, String> {
    app.active
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            "conexão não está aberta — chame open_connection antes".into()
        })
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

#[derive(Debug, Clone, Copy)]
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

async fn load_guardrail_policy(app: &AppState) -> GuardrailPolicy {
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
}
