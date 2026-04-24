use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TlsMode {
    Disabled,
    #[default]
    Preferred,
    Required,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SshTunnelConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub private_key_passphrase: Option<String>,
}

/// HTTP CONNECT proxy config. When set on a connection, the DB socket
/// is tunneled through `proxy_host:proxy_port` via the HTTP CONNECT
/// method (RFC 7231 §4.3.6). Mutually exclusive with SSH tunnel: if
/// both are set, SSH wins and the proxy is ignored.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HttpProxyConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionConfig {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub name: String,
    /// Hex color (#RRGGBB) for the connection's visual identification.
    #[serde(default)]
    pub color: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub default_database: Option<String>,
    #[serde(default)]
    pub tls: TlsMode,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
    #[serde(default)]
    pub http_proxy: Option<HttpProxyConfig>,
}
