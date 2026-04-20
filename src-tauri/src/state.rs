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

/// Estado global mantido pelo Tauri.
pub struct AppState {
    pub store: Store,
    pub active: RwLock<HashMap<Uuid, Arc<dyn Driver>>>,
    /// Túneis SSH abertos por conexão. São mantidos vivos enquanto o
    /// driver respectivo tá conectado; fechados junto com o close.
    pub tunnels: RwLock<HashMap<Uuid, SshTunnel>>,
    /// Controle da transferência em execução (pause/stop). Um único por
    /// vez — se o usuário disparar outra com uma rodando, a antiga perde
    /// o controle ao reset().
    pub transfer_control: Arc<TransferControl>,
    /// Servidor MCP local. Gerenciado via commands `mcp_*`.
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

/// Fábrica do driver de acordo com o nome guardado no perfil.
pub fn make_driver(driver: &str) -> Option<Arc<dyn Driver>> {
    match driver {
        // MariaDB reutiliza o driver MySQL — protocolo compatível.
        "mysql" | "mariadb" => Some(Arc::new(MysqlDriver::new())),
        "postgres" => Some(Arc::new(PostgresDriver::new())),
        "sqlite" => Some(Arc::new(SqliteDriver::new())),
        _ => None,
    }
}
