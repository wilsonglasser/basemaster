use std::collections::HashMap;
use std::sync::Arc;

use basemaster_core::Driver;
use basemaster_driver_mysql::MysqlDriver;
use basemaster_driver_postgres::PostgresDriver;
use basemaster_driver_sqlite::SqliteDriver;
use basemaster_store::Store;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::data_transfer::TransferControl;
use crate::mcp_server::McpServer;
use crate::ssh_tunnel::SshTunnel;

/// Global state held by Tauri.
pub struct AppState {
    pub store: Store,
    pub active: RwLock<HashMap<Uuid, Arc<dyn Driver>>>,
    /// SSH tunnels open per connection. Kept alive while the
    /// respective driver is connected; closed together with the close.
    pub tunnels: RwLock<HashMap<Uuid, SshTunnel>>,
    /// Control for the running transfer (pause/stop). Only one at a
    /// time — if the user starts another while one is running, the old
    /// one loses control on reset().
    pub transfer_control: Arc<TransferControl>,
    /// Local MCP server. Managed via `mcp_*` commands.
    pub mcp: McpServer,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            active: RwLock::new(HashMap::new()),
            tunnels: RwLock::new(HashMap::new()),
            transfer_control: Arc::new(TransferControl::new()),
            mcp: McpServer::new(),
        }
    }
}

/// Driver factory based on the name saved in the profile.
pub fn make_driver(driver: &str) -> Option<Arc<dyn Driver>> {
    match driver {
        // MariaDB reuses the MySQL driver — compatible protocol.
        "mysql" | "mariadb" => Some(Arc::new(MysqlDriver::new())),
        "postgres" => Some(Arc::new(PostgresDriver::new())),
        "sqlite" => Some(Arc::new(SqliteDriver::new())),
        _ => None,
    }
}
