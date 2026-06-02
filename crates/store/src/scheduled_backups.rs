use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{StoreError, StoreResult};

/// A configured backup routine for a connection.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduledBackup {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub name: String,
    /// "interval" (expr = seconds) or "cron" (expr = cron string).
    pub schedule_kind: String,
    pub schedule_expr: String,
    pub dest_dir: String,
    /// "bmbak" | "sql" | "zip".
    pub format: String,
    /// "stored" | "deflate" | "zstd".
    pub compression: String,
    pub compression_level: i64,
    /// "structure" | "data" | "both".
    pub content: String,
    /// JSON array of `{ schema, tables[] }`. Empty array = everything.
    pub scopes_json: String,
    pub retention_keep_n: Option<i64>,
    pub retention_days: Option<i64>,
    pub enabled: bool,
    /// Headless runs auto-accept an unknown SSH host key (TOFU) when true.
    pub accept_ssh_hosts: bool,
    pub last_run_at: Option<i64>,
    pub last_status: Option<String>,
    pub next_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduledBackupDraft {
    pub name: String,
    pub schedule_kind: String,
    pub schedule_expr: String,
    pub dest_dir: String,
    pub format: String,
    #[serde(default = "default_compression")]
    pub compression: String,
    #[serde(default = "default_level")]
    pub compression_level: i64,
    #[serde(default = "default_content")]
    pub content: String,
    #[serde(default = "default_scopes")]
    pub scopes_json: String,
    #[serde(default)]
    pub retention_keep_n: Option<i64>,
    #[serde(default)]
    pub retention_days: Option<i64>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub accept_ssh_hosts: bool,
    /// First scheduled run; the scheduler advances it after each run.
    #[serde(default)]
    pub next_run_at: Option<i64>,
}

fn default_compression() -> String {
    "zstd".into()
}
fn default_level() -> i64 {
    5
}
fn default_content() -> String {
    "both".into()
}
fn default_scopes() -> String {
    "[]".into()
}
fn default_enabled() -> bool {
    true
}

pub struct ScheduledBackupRepo<'a> {
    pool: &'a SqlitePool,
}

const COLS: &str = "id, connection_id, name, schedule_kind, schedule_expr, dest_dir, \
    format, compression, compression_level, content, scopes_json, retention_keep_n, \
    retention_days, enabled, accept_ssh_hosts, last_run_at, last_status, next_run_at, \
    created_at, updated_at";

impl<'a> ScheduledBackupRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list_all(&self) -> StoreResult<Vec<ScheduledBackup>> {
        let sql = format!(
            "SELECT {COLS} FROM scheduled_backups ORDER BY name COLLATE NOCASE ASC"
        );
        let rows = sqlx::query_as::<_, ScheduledBackupRow>(&sql)
            .fetch_all(self.pool)
            .await?;
        rows.into_iter().map(ScheduledBackup::try_from).collect()
    }

    pub async fn list_by_connection(
        &self,
        connection_id: Uuid,
    ) -> StoreResult<Vec<ScheduledBackup>> {
        let sql = format!(
            "SELECT {COLS} FROM scheduled_backups WHERE connection_id = ?1 \
             ORDER BY name COLLATE NOCASE ASC"
        );
        let rows = sqlx::query_as::<_, ScheduledBackupRow>(&sql)
            .bind(connection_id.to_string())
            .fetch_all(self.pool)
            .await?;
        rows.into_iter().map(ScheduledBackup::try_from).collect()
    }

    /// Enabled routines whose `next_run_at` is due (<= now). Drives the
    /// in-process scheduler tick.
    pub async fn list_due(&self, now: i64) -> StoreResult<Vec<ScheduledBackup>> {
        let sql = format!(
            "SELECT {COLS} FROM scheduled_backups \
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1 \
             ORDER BY next_run_at ASC"
        );
        let rows = sqlx::query_as::<_, ScheduledBackupRow>(&sql)
            .bind(now)
            .fetch_all(self.pool)
            .await?;
        rows.into_iter().map(ScheduledBackup::try_from).collect()
    }

    pub async fn get(&self, id: Uuid) -> StoreResult<ScheduledBackup> {
        let sql = format!("SELECT {COLS} FROM scheduled_backups WHERE id = ?1");
        let row = sqlx::query_as::<_, ScheduledBackupRow>(&sql)
            .bind(id.to_string())
            .fetch_optional(self.pool)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("scheduled_backup {}", id)))?;
        ScheduledBackup::try_from(row)
    }

    pub async fn create(
        &self,
        connection_id: Uuid,
        draft: ScheduledBackupDraft,
    ) -> StoreResult<ScheduledBackup> {
        let id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO scheduled_backups
                (id, connection_id, name, schedule_kind, schedule_expr, dest_dir,
                 format, compression, compression_level, content, scopes_json,
                 retention_keep_n, retention_days, enabled, accept_ssh_hosts,
                 next_run_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)",
        )
        .bind(id.to_string())
        .bind(connection_id.to_string())
        .bind(&draft.name)
        .bind(&draft.schedule_kind)
        .bind(&draft.schedule_expr)
        .bind(&draft.dest_dir)
        .bind(&draft.format)
        .bind(&draft.compression)
        .bind(draft.compression_level)
        .bind(&draft.content)
        .bind(&draft.scopes_json)
        .bind(draft.retention_keep_n)
        .bind(draft.retention_days)
        .bind(draft.enabled as i64)
        .bind(draft.accept_ssh_hosts as i64)
        .bind(draft.next_run_at)
        .bind(now)
        .execute(self.pool)
        .await?;
        self.get(id).await
    }

    pub async fn update(
        &self,
        id: Uuid,
        draft: ScheduledBackupDraft,
    ) -> StoreResult<ScheduledBackup> {
        let now = Utc::now().timestamp();
        let res = sqlx::query(
            "UPDATE scheduled_backups SET
                name = ?2, schedule_kind = ?3, schedule_expr = ?4, dest_dir = ?5,
                format = ?6, compression = ?7, compression_level = ?8, content = ?9,
                scopes_json = ?10, retention_keep_n = ?11, retention_days = ?12,
                enabled = ?13, accept_ssh_hosts = ?14, next_run_at = ?15,
                updated_at = ?16
             WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(&draft.name)
        .bind(&draft.schedule_kind)
        .bind(&draft.schedule_expr)
        .bind(&draft.dest_dir)
        .bind(&draft.format)
        .bind(&draft.compression)
        .bind(draft.compression_level)
        .bind(&draft.content)
        .bind(&draft.scopes_json)
        .bind(draft.retention_keep_n)
        .bind(draft.retention_days)
        .bind(draft.enabled as i64)
        .bind(draft.accept_ssh_hosts as i64)
        .bind(draft.next_run_at)
        .bind(now)
        .execute(self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("scheduled_backup {}", id)));
        }
        self.get(id).await
    }

    /// Record the outcome of a run and the next scheduled time.
    pub async fn record_run(
        &self,
        id: Uuid,
        ran_at: i64,
        status: &str,
        next_run_at: Option<i64>,
    ) -> StoreResult<()> {
        let res = sqlx::query(
            "UPDATE scheduled_backups
                SET last_run_at = ?2, last_status = ?3, next_run_at = ?4, updated_at = ?2
              WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(ran_at)
        .bind(status)
        .bind(next_run_at)
        .execute(self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("scheduled_backup {}", id)));
        }
        Ok(())
    }

    pub async fn set_enabled(&self, id: Uuid, enabled: bool) -> StoreResult<()> {
        let now = Utc::now().timestamp();
        sqlx::query(
            "UPDATE scheduled_backups SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(enabled as i64)
        .bind(now)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        let res = sqlx::query("DELETE FROM scheduled_backups WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("scheduled_backup {}", id)));
        }
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct ScheduledBackupRow {
    id: String,
    connection_id: String,
    name: String,
    schedule_kind: String,
    schedule_expr: String,
    dest_dir: String,
    format: String,
    compression: String,
    compression_level: i64,
    content: String,
    scopes_json: String,
    retention_keep_n: Option<i64>,
    retention_days: Option<i64>,
    enabled: i64,
    accept_ssh_hosts: i64,
    last_run_at: Option<i64>,
    last_status: Option<String>,
    next_run_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<ScheduledBackupRow> for ScheduledBackup {
    type Error = StoreError;
    fn try_from(r: ScheduledBackupRow) -> Result<Self, Self::Error> {
        let parse = |s: &str| {
            Uuid::parse_str(s)
                .map_err(|e| StoreError::NotFound(format!("uuid inválido: {}", e)))
        };
        Ok(ScheduledBackup {
            id: parse(&r.id)?,
            connection_id: parse(&r.connection_id)?,
            name: r.name,
            schedule_kind: r.schedule_kind,
            schedule_expr: r.schedule_expr,
            dest_dir: r.dest_dir,
            format: r.format,
            compression: r.compression,
            compression_level: r.compression_level,
            content: r.content,
            scopes_json: r.scopes_json,
            retention_keep_n: r.retention_keep_n,
            retention_days: r.retention_days,
            enabled: r.enabled != 0,
            accept_ssh_hosts: r.accept_ssh_hosts != 0,
            last_run_at: r.last_run_at,
            last_status: r.last_status,
            next_run_at: r.next_run_at,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
    }
}
