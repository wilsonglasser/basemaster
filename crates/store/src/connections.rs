use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use basemaster_core::{ConnectionConfig, HttpProxyConfig, SshTunnelConfig, TlsMode};

use crate::{StoreError, StoreResult};

/// Connection profile as stored in SQLite (never contains the password).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub default_database: Option<String>,
    pub tls: TlsMode,
    pub ssh_tunnel: Option<SshTunnelConfig>,
    #[serde(default)]
    pub http_proxy: Option<HttpProxyConfig>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub folder_id: Option<Uuid>,
}

impl ConnectionProfile {
    /// Combines the profile with the password from the keyring to build the
    /// `ConnectionConfig` the driver consumes.
    pub fn into_config(self, password: Option<String>) -> ConnectionConfig {
        ConnectionConfig {
            id: self.id,
            name: self.name,
            color: self.color,
            host: self.host,
            port: self.port,
            user: self.user,
            password,
            default_database: self.default_database,
            tls: self.tls,
            ssh_tunnel: self.ssh_tunnel,
            http_proxy: self.http_proxy,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionDraft {
    pub name: String,
    pub color: Option<String>,
    #[serde(default = "default_driver")]
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub default_database: Option<String>,
    #[serde(default)]
    pub tls: TlsMode,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
    #[serde(default)]
    pub http_proxy: Option<HttpProxyConfig>,
}

fn default_driver() -> String {
    "mysql".to_string()
}

pub struct ConnectionRepo<'a> {
    pool: &'a SqlitePool,
}

impl<'a> ConnectionRepo<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> StoreResult<Vec<ConnectionProfile>> {
        let rows = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, color, driver, host, port, user, default_database,
                    tls, ssh_tunnel, http_proxy, created_at, updated_at, last_used_at, folder_id
               FROM connection_profiles
              ORDER BY COALESCE(sort_order, 2147483647), name COLLATE NOCASE",
        )
        .fetch_all(self.pool)
        .await?;

        rows.into_iter().map(ConnectionRow::into_profile).collect()
    }

    /// Updates sort_order in a batch. Pass (id, order) — the UI generates
    /// the final sequence after the drop.
    pub async fn reorder(&self, items: &[(Uuid, i64)]) -> StoreResult<()> {
        let mut tx = self.pool.begin().await?;
        for (id, order) in items {
            sqlx::query("UPDATE connection_profiles SET sort_order = ?1 WHERE id = ?2")
                .bind(order)
                .bind(id.to_string())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn get(&self, id: Uuid) -> StoreResult<ConnectionProfile> {
        let row = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, color, driver, host, port, user, default_database,
                    tls, ssh_tunnel, http_proxy, created_at, updated_at, last_used_at, folder_id
               FROM connection_profiles WHERE id = ?1",
        )
        .bind(id.to_string())
        .fetch_optional(self.pool)
        .await?;

        match row {
            Some(r) => r.into_profile(),
            None => Err(StoreError::NotFound(format!("conexão {id}"))),
        }
    }

    pub async fn create(&self, draft: ConnectionDraft) -> StoreResult<ConnectionProfile> {
        let now = Utc::now().timestamp();
        let id = Uuid::new_v4();
        let tls = serde_tls(&draft.tls);
        let ssh = match &draft.ssh_tunnel {
            Some(s) => Some(serde_json::to_string(&strip_ssh_secrets(s))?),
            None => None,
        };
        let proxy = match &draft.http_proxy {
            Some(p) => Some(serde_json::to_string(&strip_proxy_secrets(p))?),
            None => None,
        };

        sqlx::query(
            "INSERT INTO connection_profiles
                (id, name, color, driver, host, port, user, default_database,
                 tls, ssh_tunnel, http_proxy, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        )
        .bind(id.to_string())
        .bind(&draft.name)
        .bind(draft.color.as_deref())
        .bind(&draft.driver)
        .bind(&draft.host)
        .bind(draft.port as i64)
        .bind(&draft.user)
        .bind(draft.default_database.as_deref())
        .bind(tls)
        .bind(ssh.as_deref())
        .bind(proxy.as_deref())
        .bind(now)
        .execute(self.pool)
        .await?;

        self.get(id).await
    }

    pub async fn update(
        &self,
        id: Uuid,
        draft: ConnectionDraft,
    ) -> StoreResult<ConnectionProfile> {
        let now = Utc::now().timestamp();
        let tls = serde_tls(&draft.tls);
        let ssh = match &draft.ssh_tunnel {
            Some(s) => Some(serde_json::to_string(&strip_ssh_secrets(s))?),
            None => None,
        };
        let proxy = match &draft.http_proxy {
            Some(p) => Some(serde_json::to_string(&strip_proxy_secrets(p))?),
            None => None,
        };

        let res = sqlx::query(
            "UPDATE connection_profiles
                SET name = ?2,
                    color = ?3,
                    driver = ?4,
                    host = ?5,
                    port = ?6,
                    user = ?7,
                    default_database = ?8,
                    tls = ?9,
                    ssh_tunnel = ?10,
                    http_proxy = ?11,
                    updated_at = ?12
              WHERE id = ?1",
        )
        .bind(id.to_string())
        .bind(&draft.name)
        .bind(draft.color.as_deref())
        .bind(&draft.driver)
        .bind(&draft.host)
        .bind(draft.port as i64)
        .bind(&draft.user)
        .bind(draft.default_database.as_deref())
        .bind(tls)
        .bind(ssh.as_deref())
        .bind(proxy.as_deref())
        .bind(now)
        .execute(self.pool)
        .await?;

        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("conexão {id}")));
        }

        self.get(id).await
    }

    pub async fn delete(&self, id: Uuid) -> StoreResult<()> {
        let res = sqlx::query("DELETE FROM connection_profiles WHERE id = ?1")
            .bind(id.to_string())
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound(format!("conexão {id}")));
        }
        Ok(())
    }

    pub async fn touch(&self, id: Uuid) -> StoreResult<()> {
        let now = Utc::now().timestamp();
        sqlx::query("UPDATE connection_profiles SET last_used_at = ?2 WHERE id = ?1")
            .bind(id.to_string())
            .bind(now)
            .execute(self.pool)
            .await?;
        Ok(())
    }
}

fn serde_tls(tls: &TlsMode) -> &'static str {
    match tls {
        TlsMode::Disabled => "disabled",
        TlsMode::Preferred => "preferred",
        TlsMode::Required => "required",
    }
}

fn parse_tls(raw: &str) -> TlsMode {
    match raw {
        "disabled" => TlsMode::Disabled,
        "required" => TlsMode::Required,
        _ => TlsMode::Preferred,
    }
}

/// Removes password and passphrase from SshTunnelConfig before serializing
/// to SQLite — those secrets go to the keyring in separate entries.
fn strip_ssh_secrets(s: &SshTunnelConfig) -> SshTunnelConfig {
    SshTunnelConfig {
        host: s.host.clone(),
        port: s.port,
        user: s.user.clone(),
        password: None,
        private_key_path: s.private_key_path.clone(),
        private_key_passphrase: None,
    }
}

fn strip_proxy_secrets(p: &HttpProxyConfig) -> HttpProxyConfig {
    HttpProxyConfig {
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        password: None,
    }
}

#[derive(sqlx::FromRow)]
struct ConnectionRow {
    id: String,
    name: String,
    color: Option<String>,
    driver: String,
    host: String,
    port: i64,
    user: String,
    default_database: Option<String>,
    tls: String,
    ssh_tunnel: Option<String>,
    http_proxy: Option<String>,
    created_at: i64,
    updated_at: i64,
    last_used_at: Option<i64>,
    folder_id: Option<String>,
}

impl ConnectionRow {
    fn into_profile(self) -> StoreResult<ConnectionProfile> {
        let id = Uuid::parse_str(&self.id)
            .map_err(|e| StoreError::NotFound(format!("uuid inválido: {e}")))?;
        let ssh = match self.ssh_tunnel {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        };
        let http_proxy = match self.http_proxy {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        };
        let folder_id = match self.folder_id {
            Some(s) => Some(
                Uuid::parse_str(&s)
                    .map_err(|e| StoreError::NotFound(format!("uuid: {e}")))?,
            ),
            None => None,
        };
        Ok(ConnectionProfile {
            id,
            name: self.name,
            color: self.color,
            driver: self.driver,
            host: self.host,
            port: self.port as u16,
            user: self.user,
            default_database: self.default_database,
            tls: parse_tls(&self.tls),
            ssh_tunnel: ssh,
            http_proxy,
            created_at: self.created_at,
            updated_at: self.updated_at,
            last_used_at: self.last_used_at,
            folder_id,
        })
    }
}
