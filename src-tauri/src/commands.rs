//! Tauri commands — IPC interface between the frontend and the backend.
//!
//! Errors are serialized as `String` to simplify consumption on the
//! frontend. A richer structure can be introduced later without
//! changing the commands' signatures.

use std::sync::Arc;

use std::time::Instant;

use basemaster_core::{
    Column, Driver, FilterNode, ForeignKeyInfo, IndexInfo, PageOptions, QueryResult,
    SchemaInfo, SchemaSnapshot, TableInfo, TableOptions, Value,
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

use crate::state::{make_driver, AppState, Tunnel};

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- smoke test

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

// ---------------------------------------------------------------- connections

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

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn connection_create(
    state: State<'_, AppState>,
    draft: ConnectionDraft,
    password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
    ssh_jumps_secrets: Option<String>,
    http_proxy_password: Option<String>,
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
    if let Some(blob) = ssh_jumps_secrets.filter(|s| !s.is_empty()) {
        secrets::set_ssh_jumps_secrets(profile.id, &blob).map_err(err)?;
    }
    if let Some(p) = http_proxy_password.filter(|s| !s.is_empty()) {
        secrets::set_http_proxy_password(profile.id, &p).map_err(err)?;
    }
    Ok(profile)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn connection_update(
    state: State<'_, AppState>,
    id: Uuid,
    draft: ConnectionDraft,
    password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
    ssh_jumps_secrets: Option<String>,
    http_proxy_password: Option<String>,
) -> R<ConnectionProfile> {
    let profile = state
        .store
        .connections()
        .update(id, draft)
        .await
        .map_err(err)?;
    // Convention: Some("") clears, None keeps as-is, Some(value) overwrites.
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
    if let Some(blob) = ssh_jumps_secrets {
        if blob.is_empty() {
            secrets::delete_ssh_jumps_secrets(id).map_err(err)?;
        } else {
            secrets::set_ssh_jumps_secrets(id, &blob).map_err(err)?;
        }
    }
    if let Some(p) = http_proxy_password {
        if p.is_empty() {
            secrets::delete_http_proxy_password(id).map_err(err)?;
        } else {
            secrets::set_http_proxy_password(id, &p).map_err(err)?;
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
    let _ = secrets::delete_ssh_jumps_secrets(id);
    let _ = secrets::delete_http_proxy_password(id);
    state.store.connections().delete(id).await.map_err(err)?;
    Ok(())
}

// Tauri command — params come from the frontend ipc.connections.test
// signature; refactoring into a struct would change the IPC contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn connection_test(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: ConnectionDraft,
    password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
    ssh_jumps_secrets: Option<String>,
    http_proxy_password: Option<String>,
) -> R<()> {
    let driver = make_driver(&draft.driver)
        .ok_or_else(|| format!("driver desconhecido: {}", draft.driver))?;

    // Build an ephemeral ConnectionConfig — nil id, no persistence.
    // SSH/proxy secrets come in directly (not fetched from keyring).
    let mut ssh = draft.ssh_tunnel;
    if let Some(t) = ssh.as_mut() {
        if t.password.is_none() {
            t.password = ssh_password.filter(|s| !s.is_empty());
        }
        if t.private_key_passphrase.is_none() {
            t.private_key_passphrase = ssh_key_passphrase.filter(|s| !s.is_empty());
        }
    }
    let mut ssh_jump_hosts = draft.ssh_jump_hosts;
    if let Some(blob) = ssh_jumps_secrets.as_deref().filter(|s| !s.is_empty()) {
        if let Ok(secrets) = serde_json::from_str::<Vec<JumpHopSecrets>>(blob) {
            for (hop, sec) in ssh_jump_hosts.iter_mut().zip(secrets) {
                if hop.password.is_none() {
                    hop.password = sec.password.filter(|s| !s.is_empty());
                }
                if hop.private_key_passphrase.is_none() {
                    hop.private_key_passphrase =
                        sec.key_passphrase.filter(|s| !s.is_empty());
                }
            }
        }
    }
    let mut http_proxy = draft.http_proxy;
    if let Some(p) = http_proxy.as_mut() {
        if p.password.is_none() {
            p.password = http_proxy_password.filter(|s| !s.is_empty());
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
        ssh_jump_hosts,
        http_proxy,
    };

    let ctx = crate::ssh_tunnel::HostKeyPromptCtx {
        app: app.clone(),
        known_hosts: state.known_hosts.clone(),
        prompts: state.ssh_key_prompts.clone(),
    };
    let tunnel = open_tunnel(&cfg, ctx).await?;
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

/// Injects the SSH + HTTP proxy passwords (from the keyring) into the
/// config, without overwriting values that already came populated.
/// Jump-host secrets arrive as a JSON blob aligned to `ssh_jump_hosts`.
fn inject_ssh_secrets(
    cfg: &mut basemaster_core::ConnectionConfig,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
    ssh_jumps_blob: Option<String>,
    http_proxy_password: Option<String>,
) {
    if let Some(ssh) = cfg.ssh_tunnel.as_mut() {
        if ssh.password.is_none() {
            ssh.password = ssh_password.filter(|s| !s.is_empty());
        }
        if ssh.private_key_passphrase.is_none() {
            ssh.private_key_passphrase = ssh_key_passphrase.filter(|s| !s.is_empty());
        }
    }
    if let Some(blob) = ssh_jumps_blob.filter(|s| !s.is_empty()) {
        if let Ok(secrets) = serde_json::from_str::<Vec<JumpHopSecrets>>(&blob) {
            for (hop, sec) in cfg.ssh_jump_hosts.iter_mut().zip(secrets) {
                if hop.password.is_none() {
                    hop.password = sec.password.filter(|s| !s.is_empty());
                }
                if hop.private_key_passphrase.is_none() {
                    hop.private_key_passphrase =
                        sec.key_passphrase.filter(|s| !s.is_empty());
                }
            }
        }
    }
    if let Some(p) = cfg.http_proxy.as_mut() {
        if p.password.is_none() {
            p.password = http_proxy_password.filter(|s| !s.is_empty());
        }
    }
}

#[derive(serde::Deserialize, serde::Serialize, Default)]
struct JumpHopSecrets {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    key_passphrase: Option<String>,
}

/// Opens the configured tunnel (SSH has precedence over HTTP proxy if
/// both are set — the UI already prevents both, this is defense in
/// depth). Returns None when neither is configured.
async fn open_tunnel(
    cfg: &basemaster_core::ConnectionConfig,
    ctx: crate::ssh_tunnel::HostKeyPromptCtx,
) -> R<Option<Tunnel>> {
    if let Some(ssh) = &cfg.ssh_tunnel {
        return Ok(Some(Tunnel::Ssh(
            crate::ssh_tunnel::SshTunnel::open(
                &cfg.ssh_jump_hosts,
                ssh,
                &cfg.host,
                cfg.port,
                ctx,
            )
            .await
            .map_err(err)?,
        )));
    }
    if let Some(proxy) = &cfg.http_proxy {
        return Ok(Some(Tunnel::HttpProxy(
            crate::http_proxy_tunnel::HttpProxyTunnel::open(proxy, &cfg.host, cfg.port)
                .await
                .map_err(err)?,
        )));
    }
    Ok(None)
}

/// Adjusts the cfg's host/port to the local forward if a tunnel is active.
fn effective_config(
    mut cfg: basemaster_core::ConnectionConfig,
    tunnel: Option<&Tunnel>,
) -> basemaster_core::ConnectionConfig {
    if let Some(t) = tunnel {
        cfg.host = "127.0.0.1".into();
        cfg.port = t.local_port();
    }
    cfg
}

#[tauri::command]
pub async fn connection_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
) -> R<()> {
    let profile = state.store.connections().get(id).await.map_err(err)?;
    let password = secrets::get_password(id).map_err(err)?;
    let ssh_pwd = secrets::get_ssh_password(id).map_err(err)?;
    let ssh_key_pass = secrets::get_ssh_key_passphrase(id).map_err(err)?;
    let ssh_jumps_blob = secrets::get_ssh_jumps_secrets(id).map_err(err)?;
    let proxy_pwd = secrets::get_http_proxy_password(id).map_err(err)?;
    let driver = make_driver(&profile.driver)
        .ok_or_else(|| format!("driver desconhecido: {}", profile.driver))?;

    let mut cfg = profile.clone().into_config(password);
    inject_ssh_secrets(&mut cfg, ssh_pwd, ssh_key_pass, ssh_jumps_blob, proxy_pwd);

    let ctx = crate::ssh_tunnel::HostKeyPromptCtx {
        app: app.clone(),
        known_hosts: state.known_hosts.clone(),
        prompts: state.ssh_key_prompts.clone(),
    };
    let tunnel = open_tunnel(&cfg, ctx).await?;
    let effective = effective_config(cfg, tunnel.as_ref());

    if let Err(e) = driver.connect(&effective).await {
        // If it fails after the tunnel is up, close the tunnel so it doesn't leak.
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
pub async fn ssh_host_key_respond(
    state: State<'_, AppState>,
    request_id: Uuid,
    accept: bool,
) -> R<bool> {
    let tx = state.ssh_key_prompts.write().await.remove(&request_id);
    match tx {
        Some(sender) => {
            let _ = sender.send(accept);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn ssh_known_hosts_list(
    state: State<'_, AppState>,
) -> R<Vec<crate::ssh_known_hosts::KnownHostEntry>> {
    Ok(state.known_hosts.list())
}

#[tauri::command]
pub async fn ssh_known_hosts_remove(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    fingerprint_sha256: String,
) -> R<()> {
    state
        .known_hosts
        .remove(&host, port, &fingerprint_sha256)
        .await
        .map_err(err)?;
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

/// Reveal a stored secret from the OS keyring. Returns None when no
/// secret was stored for that kind. Single command (kind-dispatched)
/// keeps the IPC surface small.
#[tauri::command]
pub async fn connection_reveal_secret(id: Uuid, kind: String) -> R<Option<String>> {
    let result = match kind.as_str() {
        "password" => secrets::get_password(id),
        "ssh_password" => secrets::get_ssh_password(id),
        "ssh_key_passphrase" => secrets::get_ssh_key_passphrase(id),
        "http_proxy_password" => secrets::get_http_proxy_password(id),
        other => return Err(format!("kind desconhecido: {other}")),
    };
    result.map_err(err)
}

// ---------------------------------------------------------------- introspection

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
    filter_tree: Option<FilterNode>,
) -> R<u64> {
    let d = driver_for(&state, connection_id).await?;
    d.count_table_rows(&schema, &table, filter_tree.as_ref())
        .await
        .map_err(err)
}

/// Duplicates a table: CREATE TABLE new LIKE old + INSERT SELECT.
/// Copies structure (columns, indexes, PK) + data. FKs and triggers are
/// NOT copied by LIKE — V2 could expand this via SHOW CREATE.
/// If `copy_data` is false, only the structure is created.
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

/// Renames a table within the same schema.
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

/// Per-table result for batch operations (drop/truncate/empty).
/// Successes come without `error`; failures come with the driver's message.
#[derive(serde::Serialize)]
pub struct TableOpResult {
    pub table: String,
    pub error: Option<String>,
}

/// Driver string for the connection (no trait needed — comes from the profile).
async fn driver_kind(state: &AppState, id: Uuid) -> R<String> {
    let p = state.store.connections().get(id).await.map_err(err)?;
    Ok(p.driver)
}

/// Batch DROP TABLE. Continues to the next if one fails — returns
/// a vector with success/error per table.
#[tauri::command]
pub async fn drop_tables(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    tables: Vec<String>,
) -> R<Vec<TableOpResult>> {
    let d = driver_for(&state, connection_id).await?;
    let mut out = Vec::with_capacity(tables.len());
    for t in tables {
        let sql = format!("DROP TABLE {}", d.quote_ident(&t));
        let res = d.execute(Some(&schema), &sql).await;
        out.push(TableOpResult {
            table: t,
            error: res.err().map(|e| e.to_string()),
        });
    }
    Ok(out)
}

/// Batch TRUNCATE TABLE. SQLite doesn't support TRUNCATE — uses
/// `DELETE FROM` + reset of `sqlite_sequence`. Postgres adds
/// `RESTART IDENTITY CASCADE` to reset sequences and propagate FKs.
#[tauri::command]
pub async fn truncate_tables(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    tables: Vec<String>,
) -> R<Vec<TableOpResult>> {
    let d = driver_for(&state, connection_id).await?;
    let kind = driver_kind(&state, connection_id).await?;
    let mut out = Vec::with_capacity(tables.len());
    for t in tables {
        let qi = d.quote_ident(&t);
        let res = match kind.as_str() {
            "sqlite" => {
                // SQLite: DELETE + reset of the AUTOINCREMENT counter.
                // sqlite_sequence only exists if the table uses AUTOINCREMENT;
                // the second statement is silent when it doesn't exist.
                let r1 = d
                    .execute(Some(&schema), &format!("DELETE FROM {}", qi))
                    .await;
                if let Err(e) = r1 {
                    Err(e)
                } else {
                    // Try resetting the counter; ignore error (table without rowid/AI).
                    let _ = d
                        .execute(
                            Some(&schema),
                            &format!(
                                "DELETE FROM sqlite_sequence WHERE name = '{}'",
                                t.replace('\'', "''")
                            ),
                        )
                        .await;
                    Ok(())
                }
            }
            "postgres" => {
                d.execute(
                    Some(&schema),
                    &format!("TRUNCATE TABLE {} RESTART IDENTITY CASCADE", qi),
                )
                .await
                .map(|_| ())
            }
            _ => d
                .execute(Some(&schema), &format!("TRUNCATE TABLE {}", qi))
                .await
                .map(|_| ()),
        };
        out.push(TableOpResult {
            table: t,
            error: res.err().map(|e| e.to_string()),
        });
    }
    Ok(out)
}

/// Batch `DELETE FROM` — wipes all rows but fires triggers and doesn't
/// reset auto-increment. Works on all dialects.
#[tauri::command]
pub async fn empty_tables(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    tables: Vec<String>,
) -> R<Vec<TableOpResult>> {
    let d = driver_for(&state, connection_id).await?;
    let mut out = Vec::with_capacity(tables.len());
    for t in tables {
        let sql = format!("DELETE FROM {}", d.quote_ident(&t));
        let res = d.execute(Some(&schema), &sql).await;
        out.push(TableOpResult {
            table: t,
            error: res.err().map(|e| e.to_string()),
        });
    }
    Ok(out)
}

/// Renames an entire schema: MySQL has no `RENAME DATABASE`, so we
/// simulate via CREATE new → RENAME TABLE of each object → DROP old.
/// Emits `schema_rename:progress` + `:done` for the UI to show progress.
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
    // 2. List tables from the old schema.
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

/// Generates an available name for a duplicate: base_copy, base_copy_1, _copy_2…
/// Tested against list_tables on the schema.
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
    /// Identifies the row — usually PK; for tables without PK it can be
    /// all original columns (caller's responsibility).
    pub row_pk: Vec<PkEntry>,
    /// Column being changed.
    pub column: String,
    /// New value.
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

/// Result of ONE statement inside the batch.
///
/// `Error` is a normal variant (doesn't interrupt the batch) — the frontend
/// shows it in the Summary / dedicated tab and keeps displaying the other results.
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
    /// Unix epoch ms of the call (on the server).
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
    /// Total time measured with Instant (more precise than finished-started).
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

/// Splits an SQL buffer into individual statements respecting strings,
/// `quoted` identifiers and comments. Doesn't cover 100% of cases
/// (stored-proc DELIMITER, for example) — it's the "good enough" for the MVP.
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
    request_id: Option<Uuid>,
) -> R<QueryRunBatch> {
    let d = driver_for(&state, connection_id).await?;
    let stmts = split_statements(&sql);
    let started_at_ms = Utc::now().timestamp_millis();
    let total_inst = Instant::now();

    // Register a cancel channel. When signaled, we'll fire KILL QUERY /
    // pg_cancel_backend via a side connection — the statement's SQL
    // carries a unique comment marker (`/* bm-cancel-<uuid> */`) that
    // the driver matches against PROCESSLIST / pg_stat_activity.
    let cancel_rx = if let Some(rid) = request_id {
        let (tx, rx) = tokio::sync::watch::channel(false);
        state.running_queries.write().await.insert(rid, tx);
        Some(rx)
    } else {
        None
    };

    let mut results = Vec::with_capacity(stmts.len());
    for stmt in stmts {
        let stmt_inst = Instant::now();
        let is_select = looks_like_select(&stmt);

        // Per-statement marker so cancel targets only THIS statement,
        // not a previous one that's still in processlist for any reason.
        let marker = request_id.map(|rid| {
            format!("bm-cancel-{}-{}", rid, stmt_inst.elapsed().as_nanos())
        });
        let stmt_with_marker = match &marker {
            Some(m) => format!("/* {} */ {}", m, stmt),
            None => stmt.clone(),
        };

        // Spawn a watcher that issues KILL when cancel is signaled.
        // Aborted when the query completes naturally.
        let watcher_handle = match (cancel_rx.clone(), marker.clone()) {
            (Some(mut rx), Some(m)) => {
                let driver = d.clone();
                Some(tokio::spawn(async move {
                    loop {
                        if *rx.borrow() {
                            break;
                        }
                        if rx.changed().await.is_err() {
                            return;
                        }
                    }
                    // Small delay gives the server time to register the
                    // query in PROCESSLIST before we look it up.
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let _ = driver.cancel_by_marker(&m).await;
                }))
            }
            _ => None,
        };

        // Strip the marker prefix from any error text the DB echoes.
        let scrub = |msg: String| -> String {
            match &marker {
                Some(m) => msg
                    .replace(&format!("/* {} */ ", m), "")
                    .replace(&format!("/* {} */", m), ""),
                None => msg,
            }
        };

        let result = if is_select {
            match d.query(schema.as_deref(), &stmt_with_marker).await {
                Ok(q) => QueryRunResult::Select {
                    sql: stmt,
                    columns: q.columns,
                    rows: q.rows,
                    elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                },
                Err(e) => {
                    let was_cancelled = cancel_rx
                        .as_ref()
                        .map(|rx| *rx.borrow())
                        .unwrap_or(false);
                    QueryRunResult::Error {
                        sql: stmt,
                        message: if was_cancelled {
                            "cancelled by user".into()
                        } else {
                            scrub(e.to_string())
                        },
                        elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                    }
                }
            }
        } else {
            match d.execute(schema.as_deref(), &stmt_with_marker).await {
                Ok(e) => QueryRunResult::Modify {
                    sql: stmt,
                    rows_affected: e.rows_affected,
                    last_insert_id: e.last_insert_id,
                    elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                },
                Err(e) => {
                    let was_cancelled = cancel_rx
                        .as_ref()
                        .map(|rx| *rx.borrow())
                        .unwrap_or(false);
                    QueryRunResult::Error {
                        sql: stmt,
                        message: if was_cancelled {
                            "cancelled by user".into()
                        } else {
                            scrub(e.to_string())
                        },
                        elapsed_ms: stmt_inst.elapsed().as_millis() as u64,
                    }
                }
            }
        };

        // Query completed (success or error) — stop watching.
        if let Some(h) = watcher_handle {
            h.abort();
        }

        let was_cancelled = matches!(
            &result,
            QueryRunResult::Error { message, .. } if message == "cancelled by user"
        );
        results.push(result);
        if was_cancelled {
            break;
        }
    }

    if let Some(rid) = request_id {
        state.running_queries.write().await.remove(&rid);
    }

    Ok(QueryRunBatch {
        results,
        started_at_ms,
        finished_at_ms: Utc::now().timestamp_millis(),
        total_ms: total_inst.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn query_cancel(
    state: State<'_, AppState>,
    request_id: Uuid,
) -> R<bool> {
    let reg = state.running_queries.read().await;
    if let Some(tx) = reg.get(&request_id) {
        let _ = tx.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Opens a tab in a separate Tauri window. `url_fragment` is appended to
/// index.html (e.g., "?detached=table&conn=abc&schema=public&table=users").
/// If a window with the same label already exists, it's focused instead of created.
/// `x` and `y` are SCREEN coordinates (logical pixels) to position the
/// new window — used on drag-out to open where the cursor is.
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

/// Closes a WebviewWindow by label. Used on reattach — avoids dealing
/// with JS-side permissions for `WebviewWindow.close()`.
#[tauri::command]
pub async fn close_window(app: AppHandle, label: String) -> R<()> {
    if let Some(w) = app.get_webview_window(&label) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Checks whether the server has binlog enabled. Used to decide the
/// default for `disable_binlog`: if log_bin=OFF, SET SQL_LOG_BIN=0 has
/// no practical effect and is safe to turn on. If ON, probably replication.
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
    // Row: [Variable_name, Value]. Value = "ON" or "OFF".
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

/// Kicks off a data transfer. Both connections (source/target) need
/// to be open (in `AppState::active`). Emits events
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

/// Writes bytes to an arbitrary file chosen by the user (save dialog).
/// Used by export. When `append=true`, opens the file in append mode —
/// allows chunked export (frontend sends in parts).
/// Kicks off an SQL import (.sql or .zip file). Reuses `TransferControl`.
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

/// Kicks off an SQL dump. Reuses the same `TransferControl` — pause/stop
/// from data_transfer apply to dump too (global state is 1 operation
/// at a time). Events: `sql_dump:progress`, `sql_dump:table_done`,
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
    // Label "user@host:port" for the dump header.
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
            ssh_jump_hosts: p.ssh_jump_hosts,
            ssh_jumps_secrets: None,
            http_proxy: p.http_proxy,
            http_proxy_password: None,
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

    // Index of existing folders by name (case-sensitive — matches Navicat/UX).
    let existing_folders = state.store.connection_folders().list().await.map_err(err)?;
    let mut folder_by_name: std::collections::HashMap<String, Uuid> = existing_folders
        .into_iter()
        .map(|f| (f.name, f.id))
        .collect();

    // Create payload folders that don't yet exist.
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

    // Create connections.
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
            ssh_jump_hosts: c.ssh_jump_hosts.clone(),
            http_proxy: c.http_proxy.clone(),
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
        if let Some(blob) = c.ssh_jumps_secrets.as_deref().filter(|s| !s.is_empty()) {
            let _ = secrets::set_ssh_jumps_secrets(profile.id, blob);
        }
        if let Some(pp) = c.http_proxy_password.as_deref().filter(|s| !s.is_empty()) {
            let _ = secrets::set_http_proxy_password(profile.id, pp);
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

/// Controls the progress bar on the taskbar icon (Windows) or dock
/// (macOS). `progress` in 0..=100. `status`:
///   "none" — hides the bar
///   "normal" — blue/green progressing
///   "indeterminate" — loading animation (ignores progress)
///   "paused" — yellow
///   "error" — red
/// Target window: the caller's (or "main" if not passed).
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
