use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{StoreError, StoreResult};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryHistoryEntry {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub schema: Option<String>,
    pub sql: String,
    pub executed_at: i64,
    pub elapsed_ms: i64,
    pub rows_affected: Option<i64>,
    pub success: bool,
    pub error_msg: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryHistoryDraft {
    pub sql: String,
    pub schema: Option<String>,
    pub elapsed_ms: i64,
    pub rows_affected: Option<i64>,
    pub success: bool,
    pub error_msg: Option<String>,
}

pub struct QueryHistoryRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> QueryHistoryRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(
        &self,
        connection_id: Uuid,
        limit: i64,
    ) -> StoreResult<Vec<QueryHistoryEntry>> {
        let rows = sqlx::query_as::<_, Row>(
            "SELECT id, connection_id, schema, sql, executed_at, elapsed_ms,
                    rows_affected, success, error_msg
               FROM query_history
              WHERE connection_id = ?1
              ORDER BY executed_at DESC
              LIMIT ?2",
        )
        .bind(connection_id.to_string())
        .bind(limit)
        .fetch_all(self.pool)
        .await?;
        rows.into_iter().map(QueryHistoryEntry::try_from).collect()
    }

    pub async fn insert(
        &self,
        connection_id: Uuid,
        draft: QueryHistoryDraft,
    ) -> StoreResult<QueryHistoryEntry> {
        let id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO query_history
                (id, connection_id, schema, sql, executed_at, elapsed_ms,
                 rows_affected, success, error_msg)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(id.to_string())
        .bind(connection_id.to_string())
        .bind(draft.schema.as_deref())
        .bind(&draft.sql)
        .bind(now)
        .bind(draft.elapsed_ms)
        .bind(draft.rows_affected)
        .bind(if draft.success { 1i64 } else { 0i64 })
        .bind(draft.error_msg.as_deref())
        .execute(self.pool)
        .await?;
        Ok(QueryHistoryEntry {
            id,
            connection_id,
            schema: draft.schema,
            sql: draft.sql,
            executed_at: now,
            elapsed_ms: draft.elapsed_ms,
            rows_affected: draft.rows_affected,
            success: draft.success,
            error_msg: draft.error_msg,
        })
    }

    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        sqlx::query("DELETE FROM query_history WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        Ok(())
    }

    pub async fn clear(&self, connection_id: Uuid) -> StoreResult<u64> {
        let r = sqlx::query("DELETE FROM query_history WHERE connection_id = ?1")
            .bind(connection_id.to_string())
            .execute(self.pool)
            .await?;
        Ok(r.rows_affected())
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    connection_id: String,
    schema: Option<String>,
    sql: String,
    executed_at: i64,
    elapsed_ms: i64,
    rows_affected: Option<i64>,
    success: i64,
    error_msg: Option<String>,
}

impl TryFrom<Row> for QueryHistoryEntry {
    type Error = StoreError;
    fn try_from(r: Row) -> Result<Self, Self::Error> {
        Ok(QueryHistoryEntry {
            id: Uuid::parse_str(&r.id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            connection_id: Uuid::parse_str(&r.connection_id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            schema: r.schema,
            sql: r.sql,
            executed_at: r.executed_at,
            elapsed_ms: r.elapsed_ms,
            rows_affected: r.rows_affected,
            success: r.success != 0,
            error_msg: r.error_msg,
        })
    }
}
