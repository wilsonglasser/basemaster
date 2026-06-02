//! Shared "run one scheduled backup" logic: resolve the connection, dump to a
//! timestamped file in `dest_dir`, apply retention, record the run. Reused by
//! the headless CLI and the GUI binary (self-invoked by the OS scheduler, plus
//! the "run now" command), so both behave identically.
//!
//! The concrete driver set lives in the caller (the GUI/CLI binaries), so the
//! connection is built through a `make_driver` closure to keep this crate free
//! of the driver implementations.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use basemaster_core::schema::TableKind;
use basemaster_core::Driver;
use basemaster_store::{ScheduledBackup, Store};

use crate::dump::{dump_tables_to_bmbak, DumpToBmbakOptions, Progress};

/// Builds a driver instance for a driver-kind string ("mysql"/"postgres"/…).
pub type DriverFactory<'a> = dyn Fn(&str) -> Option<Arc<dyn Driver>> + Send + Sync + 'a;

/// Compute the next display run timestamp. For interval schedules this is exact;
/// for daily/cron the OS scheduler is the real trigger, so advance ~1 day.
pub fn next_run(sched: &ScheduledBackup, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
    match sched.schedule_kind.as_str() {
        "interval" => sched
            .schedule_expr
            .parse::<i64>()
            .ok()
            .map(|secs| now.timestamp() + secs),
        _ => Some(now.timestamp() + 86_400),
    }
}

/// Fetch the schedule, run it (opening a fresh connection via `make_driver`),
/// and persist `last_run_at`/`last_status`. Connections that use an SSH tunnel
/// are rejected here — callers with tunnel support (the GUI binary) dump via
/// [`dump_schedule`] against an already-connected driver instead.
pub async fn run_and_record(
    store: &Store,
    id: uuid::Uuid,
    make_driver: &DriverFactory<'_>,
    progress: &dyn Progress,
) -> Result<String> {
    let sched = store.scheduled_backups().get(id).await?;
    let now = chrono::Utc::now();
    let result = connect_and_dump_local(store, &sched, now, make_driver, progress).await;
    record_result(store, &sched, now, result).await
}

/// Persist a finished run's status (`"ok"` / `"error: <msg>"`) + next_run, then
/// return the original result. Lets every caller share the status convention.
pub async fn record_result(
    store: &Store,
    sched: &ScheduledBackup,
    now: chrono::DateTime<chrono::Utc>,
    result: Result<String>,
) -> Result<String> {
    let (status, next) = match &result {
        Ok(_) => ("ok".to_string(), next_run(sched, now)),
        Err(e) => (format!("error: {e:#}"), next_run(sched, now)),
    };
    store
        .scheduled_backups()
        .record_run(sched.id, now.timestamp(), &status, next)
        .await?;
    result
}

/// Open a direct (non-tunnel) connection and dump. Used by the headless CLI.
async fn connect_and_dump_local(
    store: &Store,
    sched: &ScheduledBackup,
    now: chrono::DateTime<chrono::Utc>,
    make_driver: &DriverFactory<'_>,
    progress: &dyn Progress,
) -> Result<String> {
    let profile = store.connections().get(sched.connection_id).await?;
    if profile.ssh_tunnel.is_some() {
        bail!("connection uses an SSH tunnel; run this schedule from the BaseMaster GUI binary, which supports tunnels");
    }
    let driver = make_driver(&profile.driver)
        .ok_or_else(|| anyhow!("unknown driver '{}'", profile.driver))?;
    let password = basemaster_store::secrets::get_password(profile.id).ok().flatten();
    let config = profile.into_config(password);
    driver
        .connect(&config)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;
    let result = dump_schedule(
        sched,
        driver.as_ref(),
        config.default_database.as_deref(),
        now,
        progress,
    )
    .await;
    let _ = driver.disconnect().await;
    result
}

/// Dump one schedule against an already-connected `driver`: resolve the scope's
/// schema/tables, write a timestamped file in `dest_dir`, apply retention.
/// Returns the written file path. Connection setup (incl. SSH tunnels) is the
/// caller's job, so this is reusable from the GUI's tunnel-aware path.
pub async fn dump_schedule(
    sched: &ScheduledBackup,
    driver: &dyn Driver,
    default_db: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
    progress: &dyn Progress,
) -> Result<String> {
    // scopes_json: [{ schema, tables[] }]. Use the first scope.
    let scopes: serde_json::Value = serde_json::from_str(&sched.scopes_json).unwrap_or_default();
    let scope0 = scopes.get(0).cloned().unwrap_or_default();
    let schema = scope0
        .get("schema")
        .and_then(|v| v.as_str())
        .or(default_db)
        .ok_or_else(|| anyhow!("schedule has no schema"))?
        .to_string();
    let tables: Vec<String> = scope0
        .get("tables")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let tables = if tables.is_empty() {
        driver
            .list_tables(&schema)
            .await
            .map_err(|e| anyhow!("list tables: {e}"))?
            .into_iter()
            .filter(|t| t.kind == TableKind::Table)
            .map(|t| t.name)
            .collect()
    } else {
        tables
    };

    std::fs::create_dir_all(&sched.dest_dir)
        .with_context(|| format!("create dest dir {}", sched.dest_dir))?;
    let stamp = now.format("%Y%m%d-%H%M%S");
    let ext = if sched.format == "sql" { "sql" } else { "bmbak" };
    let filename = format!("{}-{}.{}", sanitize(&sched.name), stamp, ext);
    let out_path = std::path::Path::new(&sched.dest_dir).join(&filename);

    let opts = DumpToBmbakOptions {
        created_at: now.to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        level: sched.compression_level as i32,
        chunk_size: 1000,
    };
    let file = std::fs::File::create(&out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    dump_tables_to_bmbak(driver, &schema, &tables, &opts, file, progress, None).await?;

    apply_retention(sched, now.timestamp())?;
    Ok(out_path.to_string_lossy().to_string())
}

/// Filesystem-safe schedule name used as the backup filename prefix.
pub fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn apply_retention(sched: &ScheduledBackup, now: i64) -> Result<()> {
    use crate::retention::{files_to_delete, BackupFile, RetentionPolicy};
    let policy = RetentionPolicy {
        keep_n: sched.retention_keep_n.map(|n| n as u32),
        max_age_days: sched.retention_days.map(|n| n as u32),
    };
    if policy.is_noop() {
        return Ok(());
    }
    let prefix = format!("{}-", sanitize(&sched.name));
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&sched.dest_dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        files.push(BackupFile {
            path: entry.path().to_string_lossy().to_string(),
            mtime,
        });
    }
    for doomed in files_to_delete(&files, policy, now) {
        let _ = std::fs::remove_file(&doomed);
    }
    Ok(())
}
