//! basemaster-store
//!
//! SQLite local que guarda perfis de conexão, settings e (no futuro)
//! histórico de queries e cache de schema. Senhas vão pro keyring do SO
//! via [`secrets`].

use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

pub mod connection_folders;
pub mod connections;
pub mod query_history;
pub mod saved_queries;
pub mod secrets;

pub use connection_folders::{
    ConnectionFolder, ConnectionFolderDraft, ConnectionFolderRepo,
};
pub use connections::{ConnectionDraft, ConnectionProfile, ConnectionRepo};
pub use query_history::{
    QueryHistoryDraft, QueryHistoryEntry, QueryHistoryRepo,
};
pub use saved_queries::{SavedQuery, SavedQueryDraft, SavedQueryRepo};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("erro de IO: {0}")]
    Io(#[from] std::io::Error),

    #[error("erro de SQLite: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("erro de migrations: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("não foi possível resolver os diretórios do app")]
    NoProjectDirs,

    #[error("erro de keyring: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("erro de serialização: {0}")]
    Json(#[from] serde_json::Error),

    #[error("registro não encontrado: {0}")]
    NotFound(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

/// Caminhos padrão do app por SO (segue convenções `directories`).
#[derive(Clone, Debug)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> StoreResult<Self> {
        // Convenções por SO:
        //   Windows: %APPDATA%\BaseMaster\data
        //   macOS:   ~/Library/Application Support/BaseMaster
        //   Linux:   ~/.local/share/basemaster
        let pd = ProjectDirs::from("", "", "BaseMaster").ok_or(StoreError::NoProjectDirs)?;
        Ok(Self {
            data_dir: pd.data_dir().to_path_buf(),
            config_dir: pd.config_dir().to_path_buf(),
            cache_dir: pd.cache_dir().to_path_buf(),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("basemaster.db")
    }
}

/// Handle do SQLite local. Compartilhe via `Arc<Store>` no estado do Tauri.
#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    /// Abre o banco no caminho dado, cria pastas, roda migrations.
    pub async fn open(db_path: &Path) -> StoreResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let opts = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub fn connections(&self) -> ConnectionRepo<'_> {
        ConnectionRepo::new(&self.pool)
    }

    pub fn saved_queries(&self) -> SavedQueryRepo<'_> {
        SavedQueryRepo::new(&self.pool)
    }

    pub fn query_history(&self) -> QueryHistoryRepo<'_> {
        QueryHistoryRepo::new(&self.pool)
    }

    pub fn connection_folders(&self) -> ConnectionFolderRepo<'_> {
        ConnectionFolderRepo::new(&self.pool)
    }
}
