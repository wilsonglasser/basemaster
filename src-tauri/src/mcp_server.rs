//! MCP (Model Context Protocol) server local.
//!
//! Expõe um subset do MCP via HTTP JSON-RPC 2.0 em 127.0.0.1:<porta>.
//! O token de autenticação é gerado no start e exibido pro usuário —
//! qualquer cliente MCP que configurar `MCP_TOKEN` + URL acessa.
//!
//! Ferramentas expostas:
//!  - `list_connections` — conexões salvas (sem senhas).
//!  - `open_connection` / `close_connection` — controla qual conn está viva.
//!  - `list_schemas`, `list_tables`, `describe_table`, `get_table_ddl`.
//!  - `run_query` — executa SQL arbitrário, retorna rows limitadas.
//!
//! Segurança:
//!  - Bind em 127.0.0.1 only (nunca 0.0.0.0).
//!  - Token Bearer obrigatório em todo request.
//!  - Token aleatório de 32 bytes, regenerado em cada start.

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
    /// Token gerado no start. Clients passam via `Authorization: Bearer <token>`.
    pub token: Arc<RwLock<Option<String>>>,
    /// Porta em uso (0 = não iniciado).
    pub port: Arc<RwLock<u16>>,
    /// Handle do task do servidor pra poder parar.
    pub handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Shutdown signal.
    pub shutdown: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            token: Arc::new(RwLock::new(None)),
            port: Arc::new(RwLock::new(0)),
            handle: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn is_running(&self) -> bool {
        self.handle.lock().await.is_some()
    }

    pub async fn current_token(&self) -> Option<String> {
        self.token.read().await.clone()
    }

    pub async fn current_port(&self) -> u16 {
        *self.port.read().await
    }

    /// Inicia o servidor HTTP. Se já tá rodando, para e recomeça.
    pub async fn start(
        &self,
        app_handle: AppHandle,
        preferred_port: u16,
    ) -> Result<(String, u16), String> {
        self.stop().await;
        let token = random_hex_token(32);
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

        *self.token.write().await = Some(token.clone());
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
        *self.token.write().await = None;
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
    if auth != want {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
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
            call_tool(ctx, name, args).await
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
            // Devolve só o essencial — sem passwords.
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
            // Reusa a lógica do command — precisamos chamar o mesmo path.
            // Aqui uma réplica simplificada: pega profile, monta config
            // com senha do keyring, chama driver.connect.
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

fn random_hex_token(bytes: usize) -> String {
    // Fonte: Uuid::new_v4() fornece 128 bits; concatena até atingir o
    // tamanho pedido. Não é CSPRNG full mas suficiente pra token local.
    let mut out = String::with_capacity(bytes * 2);
    while out.len() < bytes * 2 {
        let u = Uuid::new_v4();
        out.push_str(&u.simple().to_string());
    }
    out.truncate(bytes * 2);
    out
}
