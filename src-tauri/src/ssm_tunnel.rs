//! AWS SSM Session Manager port-forward tunnel.
//!
//! Reaches a DB in a private subnet by forwarding through an
//! SSM-managed EC2 instance - no inbound port 22, no public IP. We
//! shell out to the `aws ssm start-session` CLI with the
//! `AWS-StartPortForwardingSessionToRemoteHost` document: the CLI
//! resolves credentials (profile / SSO / env / IMDS), spawns
//! `session-manager-plugin`, and the plugin opens a local listening
//! port that proxies to `remote_host:remote_port` through the
//! instance. The driver then connects to `127.0.0.1:local_port` like
//! any other tunnel.
//!
//! First-iteration design: depends on the full AWS CLI being on PATH.
//! A later iteration can drop that to just `session-manager-plugin` by
//! calling `ssm:StartSession` through the `aws-sdk-ssm` crate and
//! invoking the plugin binary directly (the oryxis pattern), at the
//! cost of pulling the AWS SDK (~100 crates) into the build.

use std::process::Stdio;
use std::time::Duration;

use basemaster_core::SsmTunnelConfig;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};

pub struct SsmTunnel {
    pub local_port: u16,
    /// The `aws ssm start-session` child. Held to keep the forward
    /// alive; killed on close(). `kill_on_drop` is a backstop.
    child: Option<Child>,
}

impl SsmTunnel {
    /// Starts the port-forward and returns once the local port is open.
    /// `remote_host`/`remote_port` are the DB endpoint as seen *from the
    /// SSM instance* (i.e. the connection's own host/port).
    pub async fn open(
        cfg: &SsmTunnelConfig,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<Self, String> {
        if cfg.instance_id.trim().is_empty() {
            return Err("túnel SSM: instance_id vazio".into());
        }

        // localPortNumber=0 → the plugin binds a free ephemeral port and
        // announces it on stdout; we parse it back out.
        let params = format!(
            r#"{{"host":["{remote_host}"],"portNumber":["{remote_port}"],"localPortNumber":["0"]}}"#
        );

        let mut command = Command::new("aws");
        command
            .arg("ssm")
            .arg("start-session")
            .arg("--target")
            .arg(&cfg.instance_id)
            .arg("--document-name")
            .arg("AWS-StartPortForwardingSessionToRemoteHost")
            .arg("--parameters")
            .arg(&params);
        if let Some(region) = cfg.region.as_deref().filter(|s| !s.is_empty()) {
            command.arg("--region").arg(region);
        }
        if let Some(profile) = cfg.profile.as_deref().filter(|s| !s.is_empty()) {
            command.arg("--profile").arg(profile);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Windows: don't flash a console window for the CLI child.
        // `creation_flags` is tokio's inherent method on this platform.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "AWS CLI não encontrado no PATH. Instale o AWS CLI e o \
                 session-manager-plugin para usar o túnel SSM."
                    .to_string()
            } else {
                format!("spawn aws ssm: {e}")
            }
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ssm: sem stdout".to_string())?;

        match tokio::time::timeout(Duration::from_secs(30), read_forward_port(stdout)).await {
            Ok(Ok(local_port)) => Ok(SsmTunnel {
                local_port,
                child: Some(child),
            }),
            Ok(Err(e)) => {
                let _ = child.kill().await;
                Err(stderr_context(&mut child, e).await)
            }
            Err(_) => {
                let _ = child.kill().await;
                Err("ssm: timeout esperando a porta local abrir (30s)".into())
            }
        }
    }

    /// Kills the session. The plugin terminates the SSM session on
    /// SIGTERM; a hard kill is fine - AWS reaps the orphaned session
    /// server-side after its idle timeout.
    pub async fn close(mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

/// Reads the plugin's stdout until the line announcing the opened local
/// port: `Waiting for connections...` is preceded by
/// `Port NNNNN opened for sessionId ...`.
async fn read_forward_port(stdout: tokio::process::ChildStdout) -> Result<u16, String> {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(port) = parse_port_line(&line) {
            return Ok(port);
        }
    }
    Err("ssm: stream encerrou antes de abrir a porta".into())
}

/// Extracts the port from the plugin's `Port NNNNN opened for sessionId`
/// banner. Returns None for any other line.
fn parse_port_line(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("Port ")?;
    let num = rest.split_whitespace().next()?;
    num.parse::<u16>().ok()
}

/// Drains the CLI's stderr so the surfaced error is the real AWS message
/// (bad profile, missing plugin, no `ssm:StartSession` permission)
/// rather than a generic "stream ended".
async fn stderr_context(child: &mut Child, fallback: String) -> String {
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = Vec::new();
        if stderr.read_to_end(&mut buf).await.is_ok() && !buf.is_empty() {
            let msg = String::from_utf8_lossy(&buf);
            let msg = msg.trim();
            if !msg.is_empty() {
                return format!("ssm start-session falhou: {msg}");
            }
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::parse_port_line;

    #[test]
    fn parses_plugin_port_banner() {
        assert_eq!(
            parse_port_line("Port 49817 opened for sessionId abc-123."),
            Some(49817)
        );
        assert_eq!(parse_port_line("  Port 5432 opened  "), Some(5432));
    }

    #[test]
    fn ignores_other_lines() {
        assert_eq!(parse_port_line("Starting session with SessionId: x"), None);
        assert_eq!(parse_port_line("Waiting for connections..."), None);
        assert_eq!(parse_port_line("Port abc opened"), None);
        assert_eq!(parse_port_line(""), None);
    }
}
