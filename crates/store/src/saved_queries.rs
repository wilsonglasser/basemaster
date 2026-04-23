use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{StoreError, StoreResult};

/// Query saved for a connection. `schema` optional: `None` means
/// there's no specific schema (e.g., server-level queries like
/// `SHOW STATUS`). The common case is having schema filled in.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub schema: Option<String>,
    pub name: String,
    pub sql: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Payload to create/update. `name` and `sql` are required;
/// `schema` comes from the context where the user saved it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedQueryDraft {
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub schema: Option<String>,
}

pub struct SavedQueryRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> SavedQueryRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    /// Lists all queries of a connection — includes all schemas.
    pub async fn list_by_connection(
        &self,
        connection_id: Uuid,
    ) -> StoreResult<Vec<SavedQuery>> {
        let rows = sqlx::query_as::<_, SavedQueryRow>(
            "SELECT id, connection_id, schema, name, sql, created_at, updated_at
               FROM saved_queries
              WHERE connection_id = ?1
              ORDER BY name COLLATE NOCASE ASC",
        )
        .bind(connection_id.to_string())
        .fetch_all(self.pool)
        .await?;
        rows.into_iter().map(SavedQuery::try_from).collect()
    }

    /// Lists queries belonging to `(connection_id, schema)`. Also includes
    /// those with `schema IS NULL` ("global" queries of that connection) so
    /// they show up in any schema.
    pub async fn list_by_schema(
        &self,
        connection_id: Uuid,
        schema: Option<&str>,
    ) -> StoreResult<Vec<SavedQuery>> {
        let rows = match schema {
            Some(s) => {
                sqlx::query_as::<_, SavedQueryRow>(
                    "SELECT id, connection_id, schema, name, sql, created_at, updated_at
                       FROM saved_queries
                      WHERE connection_id = ?1
                        AND (schema = ?2 OR schema IS NULL)
                      ORDER BY name COLLATE NOCASE ASC",
                )
                .bind(connection_id.to_string())
                .bind(s)
                .fetch_all(self.pool)
                .await?
            }
            None => {
                sqlx::query_as::<_, SavedQueryRow>(
                    "SELECT id, connection_id, schema, name, sql, created_at, updated_at
                       FROM saved_queries
                      WHERE connection_id = ?1 AND schema IS NULL
                      ORDER BY name COLLATE NOCASE ASC",
                )
                .bind(connection_id.to_string())
                .fetch_all(self.pool)
                .await?
            }
        };
        rows.into_iter().map(SavedQuery::try_from).collect()
    }

    pub async fn get(&self, id: Uuid) -> StoreResult<SavedQuery> {
        let row = sqlx::query_as::<_, SavedQueryRow>(
            "SELECT id, connection_id, schema, name, sql, created_at, updated_at
               FROM saved_queries WHERE id = ?1",
        )
        .bind(id.to_string())
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("saved_query {}", id)))?;
        SavedQuery::try_from(row)
    }

    pub async fn create(
        &self,
        connection_id: Uuid,
        draft: SavedQueryDraft,
    ) -> StoreResult<SavedQuery> {
        let id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO saved_queries
                (id, connection_id, schema, name, sql, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        )
        .bind(id.to_string())
        .bind(connection_id.to_string())
        .bind(draft.schema.as_deref())
        .bind(&draft.name)
        .bind(&draft.sql)
        .bind(now)
        .execute(self.pool)
        .await?;
        self.get(id).await
    }

    pub async fn update(
        &self,
        id: Uuid,
        draft: SavedQueryDraft,
    ) -> StoreResult<SavedQuery> {
        let now = Utc::now().timestamp();
        let res = sqlx::query(
            "UPDATE saved_queries
                SET name = ?2, sql = ?3, schema = ?4, updated_at = ?5
              WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(&draft.name)
        .bind(&draft.sql)
        .bind(draft.schema.as_deref())
        .bind(now)
        .execute(self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("saved_query {}", id)));
        }
        self.get(id).await
    }

    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        let res = sqlx::query("DELETE FROM saved_queries WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("saved_query {}", id)));
        }
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct SavedQueryRow {
    id: String,
    connection_id: String,
    schema: Option<String>,
    name: String,
    sql: String,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<SavedQueryRow> for SavedQuery {
    type Error = StoreError;
    fn try_from(r: SavedQueryRow) -> Result<Self, Self::Error> {
        Ok(SavedQuery {
            id: Uuid::parse_str(&r.id)
                .map_err(|e| StoreError::NotFound(format!("uuid inválido: {}", e)))?,
            connection_id: Uuid::parse_str(&r.connection_id)
                .map_err(|e| StoreError::NotFound(format!("uuid inválido: {}", e)))?,
            schema: r.schema,
            name: r.name,
            sql: r.sql,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
    }
}
