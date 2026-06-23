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

/// AWS SSM Session Manager tunnel config. When set, the DB socket is
/// reached by port-forwarding through an SSM-managed EC2 instance
/// (`instance_id`) instead of SSH: no inbound port 22, no public IP -
/// the SSM agent dials out to AWS and we attach via the
/// `AWS-StartPortForwardingSessionToRemoteHost` document.
///
/// First-iteration implementation shells out to the `aws ssm
/// start-session` CLI, which resolves credentials (profile / SSO / env
/// / IMDS) and spawns `session-manager-plugin` itself. The DB endpoint
/// and port come from the connection's own `host`/`port`; this struct
/// only carries what's needed to reach the SSM instance.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SsmTunnelConfig {
    /// Target EC2 instance id (`i-0123...`) registered with SSM. Must be
    /// able to reach the DB endpoint over the network.
    pub instance_id: String,
    /// AWS region the instance lives in. None → let the CLI resolve it
    /// from the profile / `AWS_REGION` / config default.
    #[serde(default)]
    pub region: Option<String>,
    /// Named AWS CLI profile to authenticate with. None → default
    /// credential chain.
    #[serde(default)]
    pub profile: Option<String>,
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

/// Per-connection MCP guardrail policy. Decides what the local MCP server
/// allows for *this* connection, independent of the global guardrails.
///
/// - `Inherit` (default): fall back to the global `mcp.block_*` settings.
/// - `ReadOnly`: block every write category regardless of the global config.
/// - `Custom`: this connection's own four flags override the global ones.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum McpAccess {
    #[default]
    Inherit,
    ReadOnly,
    Custom {
        block_dml: bool,
        block_ddl: bool,
        block_perms: bool,
        block_tx: bool,
    },
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
    /// Jump hosts traversed in order *before* reaching `ssh_tunnel`.
    /// Empty (default) = direct SSH to the final gateway. Only consulted
    /// when `ssh_tunnel` is Some.
    #[serde(default)]
    pub ssh_jump_hosts: Vec<SshTunnelConfig>,
    #[serde(default)]
    pub http_proxy: Option<HttpProxyConfig>,
    /// AWS SSM port-forward tunnel. Mutually exclusive with SSH / HTTP
    /// proxy: SSH wins, then SSM, then HTTP proxy.
    #[serde(default)]
    pub ssm_tunnel: Option<SsmTunnelConfig>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // The MCP policy crosses the IPC boundary to the TS front, which matches
    // on `mode`. Lock the wire shape so a refactor can't silently break it.
    #[test]
    fn mcp_access_wire_shape() {
        assert_eq!(
            serde_json::to_value(McpAccess::Inherit).unwrap(),
            serde_json::json!({ "mode": "inherit" })
        );
        assert_eq!(
            serde_json::to_value(McpAccess::ReadOnly).unwrap(),
            serde_json::json!({ "mode": "read_only" })
        );
        assert_eq!(
            serde_json::to_value(McpAccess::Custom {
                block_dml: true,
                block_ddl: false,
                block_perms: true,
                block_tx: false,
            })
            .unwrap(),
            serde_json::json!({
                "mode": "custom",
                "block_dml": true,
                "block_ddl": false,
                "block_perms": true,
                "block_tx": false,
            })
        );
    }

    #[test]
    fn mcp_access_default_is_inherit() {
        assert_eq!(McpAccess::default(), McpAccess::Inherit);
    }
}
