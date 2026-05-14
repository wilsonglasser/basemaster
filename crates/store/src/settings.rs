//! App settings — key/value store em SQLite pra preferências não-secretas.
//!
//! Segredos (senhas, token do MCP) ficam no keyring via [`crate::secrets`].
//! Aqui só entra config sem valor sensível: flags, última porta usada, etc.

use sqlx::SqlitePool;

use crate::StoreResult;

pub struct SettingsRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> SettingsRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self, key: &str) -> StoreResult<Option<String>> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM app_settings WHERE key = ?1")
                .bind(key)
                .fetch_optional(self.pool)
                .await?;
        Ok(row.map(|(v,)| v))
    }

    pub async fn set(&self, key: &str, value: &str) -> StoreResult<()> {
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_bool(&self, key: &str, default: bool) -> StoreResult<bool> {
        Ok(self
            .get(key)
            .await?
            .map(|v| v == "true")
            .unwrap_or(default))
    }
}
