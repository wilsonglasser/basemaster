use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{StoreError, StoreResult};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TableFolder {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub schema_name: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TableFolderAssignment {
    pub connection_id: Uuid,
    pub schema_name: String,
    pub table_name: String,
    pub folder_id: Uuid,
}

pub struct TableFolderRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> TableFolderRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(
        &self,
        connection_id: Uuid,
        schema_name: &str,
    ) -> StoreResult<Vec<TableFolder>> {
        let rows = sqlx::query_as::<_, FolderRow>(
            "SELECT id, connection_id, schema_name, name, sort_order, created_at
               FROM table_folders
              WHERE connection_id = ?1 AND schema_name = ?2
              ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
        )
        .bind(connection_id.to_string())
        .bind(schema_name)
        .fetch_all(self.pool)
        .await?;
        rows.into_iter().map(TableFolder::try_from).collect()
    }

    pub async fn create(
        &self,
        connection_id: Uuid,
        schema_name: String,
        name: String,
    ) -> StoreResult<TableFolder> {
        let id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        let next_sort: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sort_order), -1) + 1
               FROM table_folders
              WHERE connection_id = ?1 AND schema_name = ?2",
        )
        .bind(connection_id.to_string())
        .bind(&schema_name)
        .fetch_one(self.pool)
        .await
        .unwrap_or(0);
        sqlx::query(
            "INSERT INTO table_folders (id, connection_id, schema_name, name, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(id.to_string())
        .bind(connection_id.to_string())
        .bind(&schema_name)
        .bind(&name)
        .bind(next_sort)
        .bind(now)
        .execute(self.pool)
        .await?;
        Ok(TableFolder {
            id,
            connection_id,
            schema_name,
            name,
            sort_order: next_sort,
            created_at: now,
        })
    }

    pub async fn rename(&self, id: Uuid, name: String) -> StoreResult<()> {
        let res = sqlx::query("UPDATE table_folders SET name = ?2 WHERE id = ?1")
            .bind(id.to_string())
            .bind(name)
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("table_folder {}", id)));
        }
        Ok(())
    }

    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        sqlx::query("DELETE FROM table_folders WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        Ok(())
    }

    /// Move a table into a folder, or to root (folder_id=None).
    pub async fn move_table(
        &self,
        connection_id: Uuid,
        schema_name: &str,
        table_name: &str,
        folder_id: Option<Uuid>,
    ) -> StoreResult<()> {
        match folder_id {
            Some(fid) => {
                sqlx::query(
                    "INSERT INTO table_folder_items (connection_id, schema_name, table_name, folder_id)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(connection_id, schema_name, table_name) DO UPDATE SET folder_id = excluded.folder_id",
                )
                .bind(connection_id.to_string())
                .bind(schema_name)
                .bind(table_name)
                .bind(fid.to_string())
                .execute(self.pool)
                .await?;
            }
            None => {
                sqlx::query(
                    "DELETE FROM table_folder_items
                       WHERE connection_id = ?1 AND schema_name = ?2 AND table_name = ?3",
                )
                .bind(connection_id.to_string())
                .bind(schema_name)
                .bind(table_name)
                .execute(self.pool)
                .await?;
            }
        }
        Ok(())
    }

    pub async fn assignments(
        &self,
        connection_id: Uuid,
        schema_name: &str,
    ) -> StoreResult<Vec<TableFolderAssignment>> {
        let rows = sqlx::query_as::<_, AssignmentRow>(
            "SELECT connection_id, schema_name, table_name, folder_id
               FROM table_folder_items
              WHERE connection_id = ?1 AND schema_name = ?2",
        )
        .bind(connection_id.to_string())
        .bind(schema_name)
        .fetch_all(self.pool)
        .await?;
        rows.into_iter()
            .map(TableFolderAssignment::try_from)
            .collect()
    }
}

#[derive(sqlx::FromRow)]
struct FolderRow {
    id: String,
    connection_id: String,
    schema_name: String,
    name: String,
    sort_order: i64,
    created_at: i64,
}

impl TryFrom<FolderRow> for TableFolder {
    type Error = StoreError;
    fn try_from(r: FolderRow) -> Result<Self, Self::Error> {
        Ok(TableFolder {
            id: Uuid::parse_str(&r.id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            connection_id: Uuid::parse_str(&r.connection_id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            schema_name: r.schema_name,
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
    table_name: String,
    folder_id: String,
}

impl TryFrom<AssignmentRow> for TableFolderAssignment {
    type Error = StoreError;
    fn try_from(r: AssignmentRow) -> Result<Self, Self::Error> {
        Ok(TableFolderAssignment {
            connection_id: Uuid::parse_str(&r.connection_id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
            schema_name: r.schema_name,
            table_name: r.table_name,
            folder_id: Uuid::parse_str(&r.folder_id)
                .map_err(|e| StoreError::NotFound(format!("uuid: {}", e)))?,
        })
    }
}
