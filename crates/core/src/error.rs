use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("erro de conexão: {0}")]
    Connection(String),

    #[error("erro de autenticação")]
    Auth,

    #[error("erro de SQL: {0}")]
    Sql(String),

    #[error("recurso não encontrado: {0}")]
    NotFound(String),

    #[error("funcionalidade não suportada pelo driver: {0}")]
    Unsupported(String),

    #[error("erro de tunel SSH: {0}")]
    SshTunnel(String),

    #[error("operação cancelada")]
    Cancelled,

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}
