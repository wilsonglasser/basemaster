use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{StoreError, StoreResult};

/// A saved data-transfer preset. `config` is the opaque JSON blob produced by
/// the frontend (endpoints + schema jobs + options) — the store doesn't parse
/// it, just round-trips it. Global: not bound to a connection, since a
/// transfer spans two of them.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedTransfer {
    pub id: Uuid,
    pub name: String,
    pub config: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedTransferDraft {
    pub name: String,
    pub config: String,
}

pub struct SavedTransferRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> SavedTransferRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> StoreResult<Vec<SavedTransfer>> {
        let rows = sqlx::query_as::<_, SavedTransferRow>(
            "SELECT id, name, config, created_at, updated_at
               FROM saved_transfers
              ORDER BY name COLLATE NOCASE ASC",
        )
        .fetch_all(self.pool)
        .await?;
        rows.into_iter().map(SavedTransfer::try_from).collect()
    }

    pub async fn get(&self, id: Uuid) -> StoreResult<SavedTransfer> {
        let row = sqlx::query_as::<_, SavedTransferRow>(
            "SELECT id, name, config, created_at, updated_at
               FROM saved_transfers WHERE id = ?1",
        )
        .bind(id.to_string())
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("saved_transfer {}", id)))?;
        SavedTransfer::try_from(row)
    }

    pub async fn create(
        &self,
        draft: SavedTransferDraft,
    ) -> StoreResult<SavedTransfer> {
        let id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO saved_transfers (id, name, config, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
        )
        .bind(id.to_string())
        .bind(&draft.name)
        .bind(&draft.config)
        .bind(now)
        .execute(self.pool)
        .await?;
        self.get(id).await
    }

    pub async fn update(
        &self,
        id: Uuid,
        draft: SavedTransferDraft,
    ) -> StoreResult<SavedTransfer> {
        let now = Utc::now().timestamp();
        let res = sqlx::query(
            "UPDATE saved_transfers
                SET name = ?2, config = ?3, updated_at = ?4
              WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(&draft.name)
        .bind(&draft.config)
        .bind(now)
        .execute(self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("saved_transfer {}", id)));
        }
        self.get(id).await
    }

    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        let res = sqlx::query("DELETE FROM saved_transfers WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("saved_transfer {}", id)));
        }
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct SavedTransferRow {
    id: String,
    name: String,
    config: String,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<SavedTransferRow> for SavedTransfer {
    type Error = StoreError;
    fn try_from(r: SavedTransferRow) -> Result<Self, Self::Error> {
        Ok(SavedTransfer {
            id: Uuid::parse_str(&r.id)
                .map_err(|e| StoreError::NotFound(format!("uuid inválido: {}", e)))?,
            name: r.name,
            config: r.config,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
    }
}
