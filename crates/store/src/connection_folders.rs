use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{StoreError, StoreResult};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionFolder {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionFolderDraft {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

pub struct ConnectionFolderRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> ConnectionFolderRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> StoreResult<Vec<ConnectionFolder>> {
        let rows = sqlx::query_as::<_, Row>(
            "SELECT id, name, color, sort_order, created_at
               FROM connection_folders
              ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
        )
        .fetch_all(self.pool)
        .await?;
        rows.into_iter().map(ConnectionFolder::try_from).collect()
    }

    pub async fn create(
        &self,
        draft: ConnectionFolderDraft,
    ) -> StoreResult<ConnectionFolder> {
        let id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        // New ones go to the end of the list by order.
        let next_sort: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM connection_folders",
        )
        .fetch_one(self.pool)
        .await
        .unwrap_or(0);
        sqlx::query(
            "INSERT INTO connection_folders (id, name, color, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(id.to_string())
        .bind(&draft.name)
        .bind(draft.color.as_deref())
        .bind(next_sort)
        .bind(now)
        .execute(self.pool)
        .await?;
        Ok(ConnectionFolder {
            id,
            name: draft.name,
            color: draft.color,
            sort_order: next_sort,
            created_at: now,
        })
    }

    pub async fn rename(&self, id: Uuid, name: String) -> StoreResult<()> {
        let res = sqlx::query(
            "UPDATE connection_folders SET name = ?2 WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(name)
        .execute(self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("folder {}", id)));
        }
        Ok(())
    }

    pub async fn set_color(&self, id: Uuid, color: Option<String>) -> StoreResult<()> {
        sqlx::query(
            "UPDATE connection_folders SET color = ?2 WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(color.as_deref())
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        // FK with ON DELETE SET NULL already moves connections to the root.
        sqlx::query("DELETE FROM connection_folders WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        Ok(())
    }

    /// Moves a connection to a folder (or to the root if `folder_id=None`).
    pub async fn move_connection(
        &self,
        connection_id: Uuid,
        folder_id: Option<Uuid>,
    ) -> StoreResult<()> {
        sqlx::query(
            "UPDATE connection_profiles SET folder_id = ?2 WHERE id = ?1",
        )
        .bind(connection_id.to_string())
        .bind(folder_id.map(|id| id.to_string()))
        .execute(self.pool)
        .await?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    name: String,
    color: Option<String>,
    sort_order: i64,
    created_at: i64,
}

impl TryFrom<Row> for ConnectionFolder {
    type Error = StoreError;
    fn try_from(r: Row) -> Result<Self, Self::Error> {
        Ok(ConnectionFolder {
            id: Uuid::parse_str(&r.id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            name: r.name,
            color: r.color,
            sort_order: r.sort_order,
            created_at: r.created_at,
        })
    }
}
