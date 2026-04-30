use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{StoreError, StoreResult};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchemaFolder {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchemaFolderAssignment {
    pub connection_id: Uuid,
    pub schema_name: String,
    pub folder_id: Uuid,
}

pub struct SchemaFolderRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> SchemaFolderRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self, connection_id: Uuid) -> StoreResult<Vec<SchemaFolder>> {
        let rows = sqlx::query_as::<_, FolderRow>(
            "SELECT id, connection_id, name, sort_order, created_at
               FROM schema_folders
              WHERE connection_id = ?1
              ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
        )
        .bind(connection_id.to_string())
        .fetch_all(self.pool)
        .await?;
        rows.into_iter().map(SchemaFolder::try_from).collect()
    }

    pub async fn create(
        &self,
        connection_id: Uuid,
        name: String,
    ) -> StoreResult<SchemaFolder> {
        let id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        let next_sort: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sort_order), -1) + 1
               FROM schema_folders WHERE connection_id = ?1",
        )
        .bind(connection_id.to_string())
        .fetch_one(self.pool)
        .await
        .unwrap_or(0);
        sqlx::query(
            "INSERT INTO schema_folders (id, connection_id, name, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(id.to_string())
        .bind(connection_id.to_string())
        .bind(&name)
        .bind(next_sort)
        .bind(now)
        .execute(self.pool)
        .await?;
        Ok(SchemaFolder {
            id,
            connection_id,
            name,
            sort_order: next_sort,
            created_at: now,
        })
    }

    pub async fn rename(&self, id: Uuid, name: String) -> StoreResult<()> {
        let res = sqlx::query("UPDATE schema_folders SET name = ?2 WHERE id = ?1")
            .bind(id.to_string())
            .bind(name)
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("schema_folder {}", id)));
        }
        Ok(())
    }

    /// Deleting a folder cascades the assignment rows, so member schemas
    /// implicitly go back to "root".
    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        sqlx::query("DELETE FROM schema_folders WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        Ok(())
    }

    /// Move a schema into a folder, or to root (folder_id=None).
    pub async fn move_schema(
        &self,
        connection_id: Uuid,
        schema_name: &str,
        folder_id: Option<Uuid>,
    ) -> StoreResult<()> {
        match folder_id {
            Some(fid) => {
                sqlx::query(
                    "INSERT INTO schema_folder_items (connection_id, schema_name, folder_id)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(connection_id, schema_name) DO UPDATE SET folder_id = excluded.folder_id",
                )
                .bind(connection_id.to_string())
                .bind(schema_name)
                .bind(fid.to_string())
                .execute(self.pool)
                .await?;
            }
            None => {
                sqlx::query(
                    "DELETE FROM schema_folder_items WHERE connection_id = ?1 AND schema_name = ?2",
                )
                .bind(connection_id.to_string())
                .bind(schema_name)
                .execute(self.pool)
                .await?;
            }
        }
        Ok(())
    }

    /// All assignments for a connection — mapping schema_name -> folder_id.
    pub async fn assignments(
        &self,
        connection_id: Uuid,
    ) -> StoreResult<Vec<SchemaFolderAssignment>> {
        let rows = sqlx::query_as::<_, AssignmentRow>(
            "SELECT connection_id, schema_name, folder_id
               FROM schema_folder_items WHERE connection_id = ?1",
        )
        .bind(connection_id.to_string())
        .fetch_all(self.pool)
        .await?;
        rows.into_iter()
            .map(SchemaFolderAssignment::try_from)
            .collect()
    }
}

#[derive(sqlx::FromRow)]
struct FolderRow {
    id: String,
    connection_id: String,
    name: String,
    sort_order: i64,
    created_at: i64,
}

impl TryFrom<FolderRow> for SchemaFolder {
    type Error = StoreError;
    fn try_from(r: FolderRow) -> Result<Self, Self::Error> {
        Ok(SchemaFolder {
            id: Uuid::parse_str(&r.id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            connection_id: Uuid::parse_str(&r.connection_id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            name: r.name,
            sort_order: r.sort_order,
            created_at: r.created_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct AssignmentRow {
    connection_id: String,
    schema_name: String,
    folder_id: String,
}

impl TryFrom<AssignmentRow> for SchemaFolderAssignment {
    type Error = StoreError;
    fn try_from(r: AssignmentRow) -> Result<Self, Self::Error> {
        Ok(SchemaFolderAssignment {
            connection_id: Uuid::parse_str(&r.connection_id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            schema_name: r.schema_name,
            folder_id: Uuid::parse_str(&r.folder_id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
        })
    }
}
