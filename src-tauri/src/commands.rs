//! Tauri commands — interface IPC do front com o backend.
//!
//! Erros são serializados como `String` para simplificar o consumo
//! no front. Estrutura mais rica pode ser introduzida depois sem
//! mudar a assinatura dos commands.

use std::sync::Arc;

use std::time::Instant;

use basemaster_core::{
    Column, Driver, ForeignKeyInfo, IndexInfo, PageOptions, QueryResult, SchemaInfo,
    SchemaSnapshot, TableInfo, TableOptions, Value,
};
use basemaster_store::{
    secrets, ConnectionDraft, ConnectionFolder, ConnectionFolderDraft,
    ConnectionProfile, QueryHistoryDraft, QueryHistoryEntry, SavedQuery,
    SavedQueryDraft,
};
use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

use crate::state::{make_driver, AppState};

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- smoke test

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

// ---------------------------------------------------------------- conexões

#[tauri::command]
pub async fn connection_list(state: State<'_, AppState>) -> R<Vec<ConnectionProfile>> {
    state.store.connections().list().await.map_err(err)
}

#[tauri::command]
pub async fn connection_get(
    state: State<'_, AppState>,
    id: Uuid,
) -> R<ConnectionProfile> {
    state.store.connections().get(id).await.map_err(err)
}

#[tauri::command]
pub async fn connection_create(
    state: State<'_, AppState>,
    draft: ConnectionDraft,
    password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
) -> R<ConnectionProfile> {
    let profile = state.store.connections().create(draft).await.map_err(err)?;
    if let Some(p) = password.filter(|s| !s.is_empty()) {
        secrets::set_password(profile.id, &p).map_err(err)?;
    }
    if let Some(p) = ssh_password.filter(|s| !s.is_empty()) {
        secrets::set_ssh_password(profile.id, &p).map_err(err)?;
    }
    if let Some(p) = ssh_key_passphrase.filter(|s| !s.is_empty()) {
        secrets::set_ssh_key_passphrase(profile.id, &p).map_err(err)?;
    }
    Ok(profile)
}

#[tauri::command]
pub async fn connection_update(
    state: State<'_, AppState>,
    id: Uuid,
    draft: ConnectionDraft,
    password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
) -> R<ConnectionProfile> {
    let profile = state
        .store
        .connections()
        .update(id, draft)
        .await
        .map_err(err)?;
    // Convenção: Some("") limpa, None mantém como está, Some(valor) sobrescreve.
    if let Some(p) = password {
        if p.is_empty() {
            secrets::delete_password(id).map_err(err)?;
        } else {
            secrets::set_password(id, &p).map_err(err)?;
        }
    }
    if let Some(p) = ssh_password {
        if p.is_empty() {
            secrets::delete_ssh_password(id).map_err(err)?;
        } else {
            secrets::set_ssh_password(id, &p).map_err(err)?;
        }
    }
    if let Some(p) = ssh_key_passphrase {
        if p.is_empty() {
            secrets::delete_ssh_key_passphrase(id).map_err(err)?;
        } else {
            secrets::set_ssh_key_passphrase(id, &p).map_err(err)?;
        }
    }
    Ok(profile)
}

#[tauri::command]
pub async fn connection_delete(state: State<'_, AppState>, id: Uuid) -> R<()> {
    {
        let mut active = state.active.write().await;
        if let Some(driver) = active.remove(&id) {
            let _ = driver.disconnect().await;
        }
    }
    let _ = secrets::delete_password(id);
    let _ = secrets::delete_ssh_password(id);
    let _ = secrets::delete_ssh_key_passphrase(id);
    state.store.connections().delete(id).await.map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn connection_test(
    draft: ConnectionDraft,
    password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
) -> R<()> {
    let driver = make_driver(&draft.driver)
        .ok_or_else(|| format!("driver desconhecido: {}", draft.driver))?;

    // Constrói um ConnectionConfig efêmero — id nil, sem persistência.
    // Secrets SSH entram direto aqui (não vêm do keyring no teste).
    let mut ssh = draft.ssh_tunnel;
    if let Some(t) = ssh.as_mut() {
        if t.password.is_none() {
            t.password = ssh_password.filter(|s| !s.is_empty());
        }
        if t.private_key_passphrase.is_none() {
            t.private_key_passphrase = ssh_key_passphrase.filter(|s| !s.is_empty());
        }
    }
    let cfg = basemaster_core::ConnectionConfig {
        id: Uuid::nil(),
        name: draft.name,
        color: draft.color,
        host: draft.host,
        port: draft.port,
        user: draft.user,
        password,
        default_database: draft.default_database,
        tls: draft.tls,
        ssh_tunnel: ssh,
    };

    // Se tem túnel SSH, abre antes de conectar o driver; fecha no fim.
    let tunnel = if let Some(ssh) = &cfg.ssh_tunnel {
        Some(
            crate::ssh_tunnel::SshTunnel::open(ssh, &cfg.host, cfg.port)
                .await
                .map_err(err)?,
        )
    } else {
        None
    };
    let effective = effective_config(cfg, tunnel.as_ref());

    let result = driver.connect(&effective).await;
    let ping = if result.is_ok() {
        driver.ping().await
    } else {
        Ok(())
    };
    let _ = driver.disconnect().await;
    if let Some(t) = tunnel {
        t.close().await;
    }
    result.map_err(err)?;
    ping.map_err(err)
}

/// Injeta as senhas SSH (vindas do keyring) no config do túnel, sem
/// sobrescrever valores que já vieram preenchidos.
fn inject_ssh_secrets(
    cfg: &mut basemaster_core::ConnectionConfig,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
) {
    if let Some(ssh) = cfg.ssh_tunnel.as_mut() {
        if ssh.password.is_none() {
            ssh.password = ssh_password.filter(|s| !s.is_empty());
        }
        if ssh.private_key_passphrase.is_none() {
            ssh.private_key_passphrase = ssh_key_passphrase.filter(|s| !s.is_empty());
        }
    }
}

/// Ajusta host/port do cfg pro local forward se há túnel ativo.
fn effective_config(
    mut cfg: basemaster_core::ConnectionConfig,
    tunnel: Option<&crate::ssh_tunnel::SshTunnel>,
) -> basemaster_core::ConnectionConfig {
    if let Some(t) = tunnel {
        cfg.host = "127.0.0.1".into();
        cfg.port = t.local_port;
    }
    cfg
}

#[tauri::command]
pub async fn connection_open(state: State<'_, AppState>, id: Uuid) -> R<()> {
    let profile = state.store.connections().get(id).await.map_err(err)?;
    let password = secrets::get_password(id).map_err(err)?;
    let ssh_pwd = secrets::get_ssh_password(id).map_err(err)?;
    let ssh_key_pass = secrets::get_ssh_key_passphrase(id).map_err(err)?;
    let driver = make_driver(&profile.driver)
        .ok_or_else(|| format!("driver desconhecido: {}", profile.driver))?;

    let mut cfg = profile.clone().into_config(password);
    inject_ssh_secrets(&mut cfg, ssh_pwd, ssh_key_pass);

    // Abre túnel SSH antes (se configurado) e redireciona o host/port.
    let tunnel = if let Some(ssh) = &cfg.ssh_tunnel {
        Some(
            crate::ssh_tunnel::SshTunnel::open(ssh, &cfg.host, cfg.port)
                .await
                .map_err(err)?,
        )
    } else {
        None
    };
    let effective = effective_config(cfg, tunnel.as_ref());

    if let Err(e) = driver.connect(&effective).await {
        // Se falha pós-tunnel, fecha o túnel pra não vazar.
        if let Some(t) = tunnel {
            t.close().await;
        }
        return Err(err(e));
    }

    state.active.write().await.insert(id, driver);
    if let Some(t) = tunnel {
        state.tunnels.write().await.insert(id, t);
    }
    let _ = state.store.connections().touch(id).await;
    Ok(())
}

#[tauri::command]
pub async fn connection_close(state: State<'_, AppState>, id: Uuid) -> R<()> {
    if let Some(driver) = state.active.write().await.remove(&id) {
        let _ = driver.disconnect().await;
    }
    if let Some(tunnel) = state.tunnels.write().await.remove(&id) {
        tunnel.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn connection_active(state: State<'_, AppState>) -> R<Vec<Uuid>> {
    Ok(state.active.read().await.keys().copied().collect())
}

// ---------------------------------------------------------------- introspecção

async fn driver_for(state: &AppState, id: Uuid) -> R<Arc<dyn Driver>> {
    state
        .active
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "conexão não está aberta".to_string())
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> R<Vec<SchemaInfo>> {
    let d = driver_for(&state, connection_id).await?;
    d.list_schemas().await.map_err(err)
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
) -> R<Vec<TableInfo>> {
    let d = driver_for(&state, connection_id).await?;
    d.list_tables(&schema).await.map_err(err)
}

#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
) -> R<Vec<Column>> {
    let d = driver_for(&state, connection_id).await?;
    d.describe_table(&schema, &table).await.map_err(err)
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
) -> R<Vec<IndexInfo>> {
    let d = driver_for(&state, connection_id).await?;
    d.list_indexes(&schema, &table).await.map_err(err)
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
) -> R<Vec<ForeignKeyInfo>> {
    let d = driver_for(&state, connection_id).await?;
    d.list_foreign_keys(&schema, &table).await.map_err(err)
}

#[tauri::command]
pub async fn table_options(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
) -> R<TableOptions> {
    let d = driver_for(&state, connection_id).await?;
    d.table_options(&schema, &table).await.map_err(err)
}

#[tauri::command]
pub async fn schema_prefetch(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
) -> R<SchemaSnapshot> {
    let d = driver_for(&state, connection_id).await?;
    d.snapshot_schema(&schema).await.map_err(err)
}

#[tauri::command]
pub async fn table_count(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
) -> R<u64> {
    let d = driver_for(&state, connection_id).await?;
    d.count_table_rows(&schema, &table).await.map_err(err)
}

/// Duplica uma tabela: CREATE TABLE new LIKE old + INSERT SELECT.
/// Copia estrutura (colunas, indexes, PK) + dados. FKs e triggers NÃO
/// são copiados pelo LIKE — V2 pode expandir via SHOW CREATE.
/// Se `copy_data` for false, só cria a estrutura.
#[tauri::command]
pub async fn duplicate_table(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    source: String,
    target: String,
    copy_data: bool,
) -> R<()> {
    let d = driver_for(&state, connection_id).await?;
    let src = d.quote_ident(&source);
    let tgt = d.quote_ident(&target);
    let create_sql = format!("CREATE TABLE {} LIKE {}", tgt, src);
    d.execute(Some(&schema), &create_sql).await.map_err(err)?;
    if copy_data {
        let insert_sql = format!("INSERT INTO {} SELECT * FROM {}", tgt, src);
        d.execute(Some(&schema), &insert_sql).await.map_err(err)?;
    }
    Ok(())
}

/// Renomeia uma tabela dentro do mesmo schema.
#[tauri::command]
pub async fn rename_table(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    from: String,
    to: String,
) -> R<()> {
    let d = driver_for(&state, connection_id).await?;
    let sch = d.quote_ident(&schema);
    let from_q = d.quote_ident(&from);
    let to_q = d.quote_ident(&to);
    let sql = format!(
        "RENAME TABLE {}.{} TO {}.{}",
        sch, from_q, sch, to_q
    );
    d.execute(Some(&schema), &sql).await.map_err(err)?;
    Ok(())
}

/// Renomeia um schema inteiro: MySQL não tem `RENAME DATABASE`, então
/// simula via CREATE novo → RENAME TABLE de cada objeto → DROP antigo.
/// Emite `schema_rename:progress` + `:done` pra UI mostrar o andamento.
#[tauri::command]
pub async fn rename_schema(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: Uuid,
    from: String,
    to: String,
) -> R<()> {
    #[derive(serde::Serialize, Clone)]
    struct Progress {
        done: u32,
        total: u32,
        current: String,
    }
    let d = driver_for(&state, connection_id).await?;
    // 1. CREATE DATABASE to.
    d.execute(None, &format!("CREATE DATABASE {}", d.quote_ident(&to)))
        .await
        .map_err(err)?;
    // 2. Lista tabelas do schema antigo.
    let tables = d.list_tables(&from).await.map_err(err)?;
    let total = tables.len() as u32;
    for (idx, t) in tables.iter().enumerate() {
        let sql = format!(
            "RENAME TABLE {}.{} TO {}.{}",
            d.quote_ident(&from),
            d.quote_ident(&t.name),
            d.quote_ident(&to),
            d.quote_ident(&t.name),
        );
        d.execute(None, &sql).await.map_err(err)?;
        let _ = app.emit(
            "schema_rename:progress",
            &Progress {
                done: idx as u32 + 1,
                total,
                current: t.name.clone(),
            },
        );
    }
    // 3. DROP DATABASE from.
    d.execute(None, &format!("DROP DATABASE {}", d.quote_ident(&from)))
        .await
        .map_err(err)?;
    let _ = app.emit("schema_rename:done", &());
    Ok(())
}

/// Gera um nome disponível pra duplicata: base_copy, base_copy_1, _copy_2…
/// Testa contra list_tables do schema.
#[tauri::command]
pub async fn find_available_table_name(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    base: String,
) -> R<String> {
    let d = driver_for(&state, connection_id).await?;
    let existing = d
        .list_tables(&schema)
        .await
        .map_err(err)?
        .into_iter()
        .map(|t| t.name)
        .collect::<std::collections::HashSet<_>>();

    let candidate = format!("{}_copy", base);
    if !existing.contains(&candidate) {
        return Ok(candidate);
    }
    for i in 1..1000 {
        let c = format!("{}_copy_{}", base, i);
        if !existing.contains(&c) {
            return Ok(c);
        }
    }
    Err("não foi possível encontrar nome disponível".into())
}

#[tauri::command]
pub async fn table_page(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
    options: PageOptions,
) -> R<QueryResult> {
    let d = driver_for(&state, connection_id).await?;
    d.select_table_page(&schema, &table, &options)
        .await
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PkEntry {
    pub column: String,
    pub value: Value,
}

#[derive(serde::Deserialize)]
pub struct CellEdit {
    /// Identifica a linha — geralmente PK; pra tabelas sem PK pode ser
    /// todas as colunas originais (responsabilidade do caller).
    pub row_pk: Vec<PkEntry>,
    /// Coluna sendo alterada.
    pub column: String,
    /// Novo valor.
    pub new_value: Value,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EditResult {
    Ok { rows_affected: u64 },
    Err { message: String },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InsertResult {
    Ok { last_insert_id: u64 },
    Err { message: String },
}

#[tauri::command]
pub async fn apply_table_edits(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
    edits: Vec<CellEdit>,
) -> R<Vec<EditResult>> {
    let d = driver_for(&state, connection_id).await?;
    let mut out = Vec::with_capacity(edits.len());
    for e in edits {
        let where_cols: Vec<(String, Value)> = e
            .row_pk
            .into_iter()
            .map(|p| (p.column, p.value))
            .collect();
        match d
            .update_cell(&schema, &table, &e.column, &e.new_value, &where_cols)
            .await
        {
            Ok(rows_affected) => out.push(EditResult::Ok { rows_affected }),
            Err(err) => out.push(EditResult::Err {
                message: err.to_string(),
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_table_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
    rows: Vec<Vec<PkEntry>>,
) -> R<Vec<EditResult>> {
    let d = driver_for(&state, connection_id).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let where_cols: Vec<(String, Value)> =
            row.into_iter().map(|p| (p.column, p.value)).collect();
        match d.delete_row(&schema, &table, &where_cols).await {
            Ok(rows_affected) => out.push(EditResult::Ok { rows_affected }),
            Err(err) => out.push(EditResult::Err {
                message: err.to_string(),
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn insert_table_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
    rows: Vec<Vec<PkEntry>>,
) -> R<Vec<InsertResult>> {
    let d = driver_for(&state, connection_id).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let values: Vec<(String, Value)> =
            row.into_iter().map(|p| (p.column, p.value)).collect();
        match d.insert_row(&schema, &table, &values).await {
            Ok(last_insert_id) => out.push(InsertResult::Ok { last_insert_id }),
            Err(err) => out.push(InsertResult::Err {
                message: err.to_string(),
            }),
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- query

/// Resultado de UM statement dentro do batch.
///
/// `Error` é uma variante normal (não interrompe o batch) — o front mostra
/// no Resumo / aba específica e segue exibindo os outros resultados.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryRunResult {
    Select {
        sql: String,
        columns: Vec<String>,
        rows: Vec<Vec<Value>>,
        elapsed_ms: u64,
    },
    Modify {
        sql: String,
        rows_affected: u64,
        last_insert_id: Option<u64>,
        elapsed_ms: u64,
    },
    Error {
        sql: String,
        message: String,
        elapsed_ms: u64,
    },
}

#[derive(Serialize)]
pub struct QueryRunBatch {
    pub results: Vec<QueryRunResult>,
    /// Unix epoch ms da chamada (no servidor).
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
    /// Tempo total medido com Instant (mais preciso que finished-started).
    pub total_ms: u64,
}

fn looks_like_select(sql: &str) -> bool {
    let first = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase();
    matches!(
        first.as_str(),
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "WITH"
    )
}

/// Quebra um buffer SQL em statements individuais respeitando strings,
/// identificadores `quoted` e comentários. Não cobre 100% dos casos
/// (DELIMITER de stored proc, por ex.) — é o "bom o bastante" para o MVP.
fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;

    enum St {
        Code,
        Single,
        Double,
        Backtick,
        LineComment,
        BlockComment,
    }
    let mut st = St::Code;

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied().unwrap_or('\0');

        match st {
            St::LineComment => {
                cur.push(c);
                if c == '\n' {
                    st = St::Code;
                }
                i += 1;
            }
            St::BlockComment => {
                cur.push(c);
                if c == '*' && next == '/' {
                    cur.push(next);
                    st = St::Code;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            St::Single => {
                cur.push(c);
                if c == '\\' && i + 1 < chars.len() {
                    cur.push(next);
                    i += 2;
                } else {
                    if c == '\'' {
                        st = St::Code;
                    }
                    i += 1;
                }
            }
            St::Double => {
                cur.push(c);
                if c == '\\' && i + 1 < chars.len() {
                    cur.push(next);
                    i += 2;
                } else {
                    if c == '"' {
                        st = St::Code;
                    }
                    i += 1;
                }
            }
            St::Backtick => {
                cur.push(c);
                if c == '`' {
                    st = St::Code;
                }
                i += 1;
            }
            St::Code => {
                if c == '-' && next == '-' {
                    cur.push(c);
                    cur.push(next);
                    st = St::LineComment;
                    i += 2;
                } else if c == '/' && next == '*' {
                    cur.push(c);
                    cur.push(next);
                    st = St::BlockComment;
                    i += 2;
                } else if c == '\'' {
                    cur.push(c);
                    st = St::Single;
                    i += 1;
                } else if c == '"' {
                    cur.push(c);
                    st = St::Double;
                    i += 1;
                } else if c == '`' {
                    cur.push(c);
                    st = St::Backtick;
                    i += 1;
                } else if c == ';' {
                    let trimmed = cur.trim().to_string();
                    if !trimmed.is_empty() {
                        out.push(trimmed);
                    }
                    cur.clear();
                    i += 1;
                } else {
                    cur.push(c);
                    i += 1;
                }
            }
        }
    }
    let trimmed = cur.trim().to_string();
    if !trimmed.is_empty() {
        out.push(trimmed);
    }
    out
}

#[tauri::command]
pub async fn query_run(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: Option<String>,
    sql: String,
) -> R<QueryRunBatch> {
    let d = driver_for(&state, connection_id).await?;
    let stmts = split_statements(&sql);
    let started_at_ms = Utc::now().timestamp_millis();
    let total_inst = Instant::now();

    let mut results = Vec::with_capacity(stmts.len());
    for stmt in stmts {
        let stmt_inst = Instant::now();
        let result = if looks_like_select(&stmt) {
            match d.query(schema.as_deref(), &stmt).await {
                Ok(q) => QueryRunResult::Select {
                    sql: stmt,
                    columns: q.columns,
                    rows: q.rows,
                    elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                },
                Err(e) => QueryRunResult::Error {
                    sql: stmt,
                    message: e.to_string(),
                    elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                },
            }
        } else {
            match d.execute(schema.as_deref(), &stmt).await {
                Ok(e) => QueryRunResult::Modify {
                    sql: stmt,
                    rows_affected: e.rows_affected,
                    last_insert_id: e.last_insert_id,
                    elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                },
                Err(e) => QueryRunResult::Error {
                    sql: stmt,
                    message: e.to_string(),
                    elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                },
            }
        };
        results.push(result);
    }

    Ok(QueryRunBatch {
        results,
        started_at_ms,
        finished_at_ms: Utc::now().timestamp_millis(),
        total_ms: total_inst.elapsed().as_millis() as u64,
    })
}

/// Abre uma aba em janela Tauri separada. `url_fragment` é anexado ao
/// index.html (ex: "?detached=table&conn=abc&schema=public&table=users").
/// Se uma janela com o mesmo label já existe, ela é focada em vez de criada.
/// `x` e `y` são coordenadas de TELA (logical pixels) pra posicionar a
/// nova janela — usado no drag-out pra abrir onde o cursor está.
#[tauri::command]
pub async fn open_detached_window(
    app: AppHandle,
    label: String,
    url_fragment: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
) -> R<()> {
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = WebviewUrl::App(url_fragment.into());
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(title)
        .inner_size(1200.0, 800.0);
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Fecha uma WebviewWindow pelo label. Usado no reattach — evita lidar
/// com permissions JS-side pra `WebviewWindow.close()`.
#[tauri::command]
pub async fn close_window(app: AppHandle, label: String) -> R<()> {
    if let Some(w) = app.get_webview_window(&label) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Checa se o servidor tem binlog habilitado. Usado pra decidir o
/// default de `disable_binlog`: se log_bin=OFF, SET SQL_LOG_BIN=0 não
/// tem efeito prático e é seguro ligar. Se ON, provavelmente replicação.
#[tauri::command]
pub async fn check_binlog_enabled(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> R<bool> {
    let d = driver_for(&state, connection_id).await?;
    let q = d
        .query(None, "SHOW VARIABLES LIKE 'log_bin'")
        .await
        .map_err(err)?;
    // Row: [Variable_name, Value]. Value = "ON" ou "OFF".
    let on = q
        .rows
        .first()
        .and_then(|r| r.get(1))
        .map(|v| match v {
            basemaster_core::Value::String(s) => s.eq_ignore_ascii_case("ON"),
            _ => false,
        })
        .unwrap_or(false);
    Ok(on)
}

/// Dispara uma transferência de dados. As duas conexões (source/target)
/// precisam estar abertas (em `AppState::active`). Emite eventos
/// `transfer:progress`, `transfer:table_done`, `transfer:done`.
#[tauri::command]
pub async fn data_transfer_start(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: crate::data_transfer::TransferOptions,
) -> R<crate::data_transfer::TransferDone> {
    let (source, target) = {
        let active = state.active.read().await;
        let src = active
            .get(&opts.source_connection_id)
            .cloned()
            .ok_or_else(|| "conexão de origem não está aberta".to_string())?;
        let tgt = active
            .get(&opts.target_connection_id)
            .cloned()
            .ok_or_else(|| "conexão de destino não está aberta".to_string())?;
        (src, tgt)
    };
    state.transfer_control.reset();
    let control = state.transfer_control.clone();
    crate::data_transfer::run_transfer(app, opts, source, target, control).await
}

#[tauri::command]
pub async fn data_transfer_pause(state: State<'_, AppState>) -> R<()> {
    state.transfer_control.pause();
    Ok(())
}

#[tauri::command]
pub async fn data_transfer_resume(state: State<'_, AppState>) -> R<()> {
    state.transfer_control.resume();
    Ok(())
}

#[tauri::command]
pub async fn data_transfer_stop(state: State<'_, AppState>) -> R<()> {
    state.transfer_control.request_stop();
    Ok(())
}

/// Grava bytes num arquivo arbitrário escolhido pelo usuário (dialog
/// `save()`). Usado pelo export. Quando `append=true`, abre o arquivo
/// em append mode — permite export chunked (fronted envia por partes).
/// Dispara um SQL import (arquivo .sql ou .zip). Reusa `TransferControl`.
#[tauri::command]
pub async fn sql_import_start(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: crate::sql_import::ImportOptions,
) -> R<crate::sql_import::ImportDone> {
    let target = {
        let active = state.active.read().await;
        active
            .get(&opts.target_connection_id)
            .cloned()
            .ok_or_else(|| "conexão de destino não está aberta".to_string())?
    };
    state.transfer_control.reset();
    let control = state.transfer_control.clone();
    crate::sql_import::run_import(app, opts, target, control).await
}

/// Dispara um SQL dump. Reusa o mesmo `TransferControl` — pause/stop
/// do data_transfer valem pro dump também (estado global é 1 operação
/// por vez). Eventos: `sql_dump:progress`, `sql_dump:table_done`,
/// `sql_dump:done`.
#[tauri::command]
pub async fn sql_dump_start(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: crate::sql_dump::DumpOptions,
) -> R<crate::sql_dump::DumpDone> {
    let source = {
        let active = state.active.read().await;
        active
            .get(&opts.source_connection_id)
            .cloned()
            .ok_or_else(|| "conexão de origem não está aberta".to_string())?
    };
    // Rótulo "user@host:port" pro header do dump.
    let profile = state
        .store
        .connections()
        .get(opts.source_connection_id)
        .await
        .map_err(err)?;
    let conn_label = format!(
        "{}@{}:{}",
        profile.user, profile.host, profile.port
    );
    state.transfer_control.reset();
    let control = state.transfer_control.clone();
    crate::sql_dump::run_dump(app, opts, source, conn_label, control).await
}

// -------------------------------------------------------- MCP server

#[derive(Serialize)]
pub struct McpStatus {
    running: bool,
    port: u16,
    token: Option<String>,
}

#[tauri::command]
pub async fn mcp_status(state: State<'_, AppState>) -> R<McpStatus> {
    Ok(McpStatus {
        running: state.mcp.is_running().await,
        port: state.mcp.current_port().await,
        token: state.mcp.current_token().await,
    })
}

#[tauri::command]
pub async fn mcp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    port: Option<u16>,
) -> R<McpStatus> {
    let (token, bound) = state
        .mcp
        .start(app, port.unwrap_or(7424))
        .await
        .map_err(err)?;
    Ok(McpStatus {
        running: true,
        port: bound,
        token: Some(token),
    })
}

#[tauri::command]
pub async fn mcp_stop(state: State<'_, AppState>) -> R<McpStatus> {
    state.mcp.stop().await;
    Ok(McpStatus {
        running: false,
        port: state.mcp.current_port().await,
        token: None,
    })
}

#[tauri::command]
pub async fn connection_reorder(
    state: State<'_, AppState>,
    ordered_ids: Vec<Uuid>,
) -> R<()> {
    let items: Vec<(Uuid, i64)> = ordered_ids
        .into_iter()
        .enumerate()
        .map(|(i, id)| (id, i as i64))
        .collect();
    state
        .store
        .connections()
        .reorder(&items)
        .await
        .map_err(err)
}

// -------------------------------------------------------- Connection portability

#[tauri::command]
pub async fn connections_export(
    state: State<'_, AppState>,
    include_passwords: bool,
) -> R<crate::conn_portability::ExportPayload> {
    use crate::conn_portability::{
        load_secrets_into, ExportedConnection, ExportedFolder, ExportPayload,
    };
    let profiles = state.store.connections().list().await.map_err(err)?;
    let folders = state.store.connection_folders().list().await.map_err(err)?;

    let folder_name_by_id: std::collections::HashMap<Uuid, String> =
        folders.iter().map(|f| (f.id, f.name.clone())).collect();

    let exported_folders: Vec<ExportedFolder> = folders
        .into_iter()
        .map(|f| ExportedFolder {
            name: f.name,
            color: f.color,
        })
        .collect();

    let mut exported_conns = Vec::with_capacity(profiles.len());
    for p in profiles {
        let mut ec = ExportedConnection {
            name: p.name,
            color: p.color,
            driver: p.driver,
            host: p.host,
            port: p.port,
            user: p.user,
            default_database: p.default_database,
            tls: p.tls,
            password: None,
            ssh_tunnel: p.ssh_tunnel,
            ssh_password: None,
            ssh_key_passphrase: None,
            folder_name: p.folder_id.and_then(|id| folder_name_by_id.get(&id).cloned()),
        };
        if include_passwords {
            load_secrets_into(&mut ec, p.id);
        }
        exported_conns.push(ec);
    }

    Ok(ExportPayload {
        version: 1,
        folders: exported_folders,
        connections: exported_conns,
    })
}

#[tauri::command]
pub async fn connections_import_parse(
    path: String,
) -> R<crate::conn_portability::ExportPayload> {
    let content = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    crate::conn_portability::parse_file_content(&content, filename).map_err(err)
}

#[tauri::command]
pub async fn connections_import_apply(
    state: State<'_, AppState>,
    payload: crate::conn_portability::ExportPayload,
) -> R<usize> {
    use basemaster_store::{secrets, ConnectionDraft, ConnectionFolderDraft};

    // Índice de pastas existentes por nome (case-sensitive — igual ao Navicat/UX).
    let existing_folders = state.store.connection_folders().list().await.map_err(err)?;
    let mut folder_by_name: std::collections::HashMap<String, Uuid> = existing_folders
        .into_iter()
        .map(|f| (f.name, f.id))
        .collect();

    // Cria pastas do payload que ainda não existem.
    for f in &payload.folders {
        if !folder_by_name.contains_key(&f.name) {
            let created = state
                .store
                .connection_folders()
                .create(ConnectionFolderDraft {
                    name: f.name.clone(),
                    color: f.color.clone(),
                })
                .await
                .map_err(err)?;
            folder_by_name.insert(created.name, created.id);
        }
    }

    // Cria conexões.
    let mut count = 0;
    for c in &payload.connections {
        let draft = ConnectionDraft {
            name: c.name.clone(),
            color: c.color.clone(),
            driver: c.driver.clone(),
            host: c.host.clone(),
            port: c.port,
            user: c.user.clone(),
            default_database: c.default_database.clone(),
            tls: c.tls.clone(),
            ssh_tunnel: c.ssh_tunnel.clone(),
        };
        let profile = state.store.connections().create(draft).await.map_err(err)?;

        if let Some(folder_name) = &c.folder_name {
            if let Some(fid) = folder_by_name.get(folder_name) {
                let _ = state
                    .store
                    .connection_folders()
                    .move_connection(profile.id, Some(*fid))
                    .await;
            }
        }

        if let Some(pw) = c.password.as_deref().filter(|s| !s.is_empty()) {
            let _ = secrets::set_password(profile.id, pw);
        }
        if let Some(pw) = c.ssh_password.as_deref().filter(|s| !s.is_empty()) {
            let _ = secrets::set_ssh_password(profile.id, pw);
        }
        if let Some(pp) = c.ssh_key_passphrase.as_deref().filter(|s| !s.is_empty()) {
            let _ = secrets::set_ssh_key_passphrase(profile.id, pp);
        }

        count += 1;
    }

    Ok(count)
}

// -------------------------------------------------------- Docker discovery

#[tauri::command]
pub async fn docker_discover_connections(
) -> R<Vec<crate::docker_discovery::DockerCandidate>> {
    crate::docker_discovery::discover().await.map_err(err)
}

#[tauri::command]
pub async fn read_file_bytes(path: String) -> R<Vec<u8>> {
    std::fs::read(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub async fn save_file(
    path: String,
    data: Vec<u8>,
    append: Option<bool>,
) -> R<()> {
    use std::io::Write;
    let mut f = if append.unwrap_or(false) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(err)?
    } else {
        std::fs::File::create(&path).map_err(err)?
    };
    f.write_all(&data).map_err(err)?;
    Ok(())
}

// -------------------------------------------------------- connection folders

#[tauri::command]
pub async fn connection_folders_list(
    state: State<'_, AppState>,
) -> R<Vec<ConnectionFolder>> {
    state.store.connection_folders().list().await.map_err(err)
}

#[tauri::command]
pub async fn connection_folders_create(
    state: State<'_, AppState>,
    draft: ConnectionFolderDraft,
) -> R<ConnectionFolder> {
    state
        .store
        .connection_folders()
        .create(draft)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn connection_folders_rename(
    state: State<'_, AppState>,
    id: Uuid,
    name: String,
) -> R<()> {
    state
        .store
        .connection_folders()
        .rename(id, name)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn connection_folders_delete(
    state: State<'_, AppState>,
    id: Uuid,
) -> R<()> {
    state.store.connection_folders().delete(id).await.map_err(err)
}

#[tauri::command]
pub async fn connection_folders_move(
    state: State<'_, AppState>,
    connection_id: Uuid,
    folder_id: Option<Uuid>,
) -> R<()> {
    state
        .store
        .connection_folders()
        .move_connection(connection_id, folder_id)
        .await
        .map_err(err)
}

// -------------------------------------------------------- query history

#[tauri::command]
pub async fn query_history_list(
    state: State<'_, AppState>,
    connection_id: Uuid,
    limit: Option<i64>,
) -> R<Vec<QueryHistoryEntry>> {
    state
        .store
        .query_history()
        .list(connection_id, limit.unwrap_or(500))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn query_history_insert(
    state: State<'_, AppState>,
    connection_id: Uuid,
    draft: QueryHistoryDraft,
) -> R<QueryHistoryEntry> {
    state
        .store
        .query_history()
        .insert(connection_id, draft)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn query_history_delete(
    state: State<'_, AppState>,
    id: Uuid,
) -> R<()> {
    state.store.query_history().delete(id).await.map_err(err)
}

#[tauri::command]
pub async fn query_history_clear(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> R<u64> {
    state
        .store
        .query_history()
        .clear(connection_id)
        .await
        .map_err(err)
}

// -------------------------------------------------------- saved queries

#[tauri::command]
pub async fn saved_queries_list(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: Option<String>,
) -> R<Vec<SavedQuery>> {
    state
        .store
        .saved_queries()
        .list_by_schema(connection_id, schema.as_deref())
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn saved_queries_list_all(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> R<Vec<SavedQuery>> {
    state
        .store
        .saved_queries()
        .list_by_connection(connection_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn saved_queries_create(
    state: State<'_, AppState>,
    connection_id: Uuid,
    draft: SavedQueryDraft,
) -> R<SavedQuery> {
    state
        .store
        .saved_queries()
        .create(connection_id, draft)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn saved_queries_update(
    state: State<'_, AppState>,
    id: Uuid,
    draft: SavedQueryDraft,
) -> R<SavedQuery> {
    state
        .store
        .saved_queries()
        .update(id, draft)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn saved_queries_delete(
    state: State<'_, AppState>,
    id: Uuid,
) -> R<()> {
    state.store.saved_queries().delete(id).await.map_err(err)
}

/// Controla a barra de progresso do ícone da taskbar (Windows) ou dock
/// (macOS). `progress` em 0..=100. `status`:
///   "none" — some a barra
///   "normal" — azul/verde progredindo
///   "indeterminate" — animação de carregamento (ignora progress)
///   "paused" — amarelo
///   "error" — vermelho
/// Janela alvo: a que chamou (ou "main" se não passada).
#[tauri::command]
pub async fn set_taskbar_progress(
    app: AppHandle,
    status: String,
    progress: Option<u64>,
    label: Option<String>,
) -> R<()> {
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    let status = match status.as_str() {
        "none" => Some(ProgressBarStatus::None),
        "normal" => Some(ProgressBarStatus::Normal),
        "indeterminate" => Some(ProgressBarStatus::Indeterminate),
        "paused" => Some(ProgressBarStatus::Paused),
        "error" => Some(ProgressBarStatus::Error),
        _ => return Err(format!("status inválido: {}", status)),
    };
    let target_label = label.unwrap_or_else(|| "main".to_string());
    let window = app
        .get_webview_window(&target_label)
        .ok_or_else(|| format!("janela '{}' não encontrada", target_label))?;
    window
        .set_progress_bar(ProgressBarState {
            status,
            progress,
        })
        .map_err(err)?;
    Ok(())
}
