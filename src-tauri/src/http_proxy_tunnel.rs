//! HTTP CONNECT proxy tunnel.
//!
//! Mirrors `ssh_tunnel.rs`: exposes a local listener on 127.0.0.1 that,
//! for every accepted TCP connection, opens a new TCP connection to the
//! configured HTTP proxy, issues a `CONNECT host:port HTTP/1.1` request
//! (RFC 7231 §4.3.6) and, on a 2xx response, splices the two sockets
//! together. The DB driver then connects to the local port as if it
//! were the remote DB.
//!
//! Basic proxy auth is supported via `Proxy-Authorization: Basic <b64>`.
//! No NTLM / Kerberos — those are corporate-specific and out of scope.

use std::net::SocketAddr;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use basemaster_core::HttpProxyConfig;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

pub struct HttpProxyTunnel {
    pub local_port: u16,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl HttpProxyTunnel {
    pub async fn open(
        proxy: &HttpProxyConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<Self, String> {
        // Probe the proxy once so the user gets a clear error at connection
        // time rather than a cryptic "driver timed out" later.
        probe(proxy, target_host, target_port).await?;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind local proxy tunnel: {e}"))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| format!("local_addr: {e}"))?
            .port();

        let proxy = proxy.clone();
        let target_host = target_host.to_string();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    accept = listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                let proxy = proxy.clone();
                                let host = target_host.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = forward_connection(
                                        stream, addr, &proxy, &host, target_port,
                                    ).await {
                                        eprintln!("http proxy forward error: {e}");
                                    }
                                });
                            }
                            Err(e) => {
                                eprintln!("http proxy listener accept error: {e}");
                                break;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            local_port,
            stop_tx: Some(stop_tx),
            task: Some(task),
        })
    }

    pub async fn close(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

/// Performs a single CONNECT handshake end-to-end and drops both sockets.
/// Used at `open()` time as a fail-fast check.
async fn probe(
    proxy: &HttpProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
    let mut sock = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|e| format!("connect proxy {}:{}: {e}", proxy.host, proxy.port))?;
    write_connect(&mut sock, proxy, target_host, target_port).await?;
    read_connect_response(&mut sock).await?;
    Ok(())
}

async fn forward_connection(
    mut client: TcpStream,
    _originator: SocketAddr,
    proxy: &HttpProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
    let mut proxy_sock = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|e| format!("connect proxy: {e}"))?;
    write_connect(&mut proxy_sock, proxy, target_host, target_port).await?;
    read_connect_response(&mut proxy_sock).await?;

    tokio::io::copy_bidirectional(&mut client, &mut proxy_sock)
        .await
        .map(|_| ())
        .map_err(|e| format!("splice: {e}"))
}

async fn write_connect(
    sock: &mut TcpStream,
    proxy: &HttpProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
    let auth_line = match (proxy.user.as_deref(), proxy.password.as_deref()) {
        (Some(u), _) if !u.is_empty() => {
            let raw = format!("{}:{}", u, proxy.password.as_deref().unwrap_or(""));
            format!(
                "Proxy-Authorization: Basic {}\r\n",
                B64.encode(raw.as_bytes())
            )
        }
        _ => String::new(),
    };
    let req = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\n\
         Host: {host}:{port}\r\n\
         Proxy-Connection: Keep-Alive\r\n\
         User-Agent: BaseMaster\r\n\
         {auth}\r\n",
        host = target_host,
        port = target_port,
        auth = auth_line,
    );
    sock.write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write CONNECT: {e}"))
}

/// Reads the status line + headers up to the first empty line and decides
/// whether the tunnel is established. Returns Ok(()) on 2xx; Err with a
/// human-readable message otherwise.
///
/// Byte-at-a-time on purpose: a BufReader would read-ahead into an
/// internal buffer and lose the first bytes of the actual tunneled
/// payload when we hand the TcpStream off to `copy_bidirectional`.
/// CONNECT responses are ~100 bytes so the syscall overhead is a
/// rounding error.
async fn read_connect_response(sock: &mut TcpStream) -> Result<(), String> {
    let raw = read_until_double_crlf(sock).await?;
    let status_line = raw.lines().next().unwrap_or("");
    let code = parse_status_code(status_line)?;
    if (200..300).contains(&code) {
        Ok(())
    } else {
        Err(format!("proxy refused CONNECT: {status_line}"))
    }
}

fn parse_status_code(status_line: &str) -> Result<u16, String> {
    // "HTTP/1.1 200 Connection established"
    let mut parts = status_line.splitn(3, ' ');
    let _version = parts
        .next()
        .ok_or_else(|| format!("invalid status line: {status_line}"))?;
    let code = parts
        .next()
        .ok_or_else(|| format!("invalid status line: {status_line}"))?;
    code.parse::<u16>()
        .map_err(|_| format!("invalid status code in: {status_line}"))
}

async fn read_until_double_crlf(sock: &mut TcpStream) -> Result<String, String> {
    let mut out = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = sock
            .read(&mut byte)
            .await
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err("proxy closed connection before CONNECT response".into());
        }
        out.push(byte[0]);
        if out.ends_with(b"\r\n\r\n") {
            break;
        }
        if out.len() > 64 * 1024 {
            return Err("CONNECT response too large".into());
        }
    }
    String::from_utf8(out).map_err(|e| format!("utf8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn parse_status_ok() {
        assert_eq!(
            parse_status_code("HTTP/1.1 200 Connection established").unwrap(),
            200
        );
    }

    #[test]
    fn parse_status_407() {
        assert_eq!(
            parse_status_code("HTTP/1.1 407 Proxy Authentication Required").unwrap(),
            407
        );
    }

    #[test]
    fn parse_status_rejects_garbage() {
        assert!(parse_status_code("not a status line").is_err());
    }

    /// Spins up a fake proxy that accepts the CONNECT and sends a 200.
    /// Verifies the probe path succeeds.
    #[tokio::test]
    async fn probe_succeeds_on_200() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            // Read request headers until double CRLF.
            let mut total = 0;
            while total < buf.len() {
                let n = s.read(&mut buf[total..]).await.unwrap();
                if n == 0 {
                    break;
                }
                total += n;
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let _ = s.shutdown().await;
        });

        let cfg = HttpProxyConfig {
            host: "127.0.0.1".into(),
            port,
            user: None,
            password: None,
        };
        probe(&cfg, "db.example.com", 3306).await.unwrap();
    }

    #[tokio::test]
    async fn probe_fails_on_407() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let mut total = 0;
            while total < buf.len() {
                let n = s.read(&mut buf[total..]).await.unwrap();
                if n == 0 {
                    break;
                }
                total += n;
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            s.write_all(
                b"HTTP/1.1 407 Proxy Authentication Required\r\n\
                  Proxy-Authenticate: Basic realm=\"corp\"\r\n\r\n",
            )
            .await
            .unwrap();
            let _ = s.shutdown().await;
        });

        let cfg = HttpProxyConfig {
            host: "127.0.0.1".into(),
            port,
            user: None,
            password: None,
        };
        let err = probe(&cfg, "db.example.com", 3306).await.unwrap_err();
        assert!(err.contains("407"), "got: {err}");
    }

    /// Exercises the basic-auth header encoding.
    #[tokio::test]
    async fn basic_auth_header_is_sent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let captured = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<u8>::new()));
        let captured2 = captured.clone();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let mut total = 0;
            while total < buf.len() {
                let n = s.read(&mut buf[total..]).await.unwrap();
                if n == 0 {
                    break;
                }
                total += n;
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            captured2.lock().await.extend_from_slice(&buf[..total]);
            s.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
            let _ = s.shutdown().await;
        });

        let cfg = HttpProxyConfig {
            host: "127.0.0.1".into(),
            port,
            user: Some("alice".into()),
            password: Some("s3cret".into()),
        };
        probe(&cfg, "db.example.com", 3306).await.unwrap();

        let got = captured.lock().await;
        let s = String::from_utf8_lossy(&got);
        // base64("alice:s3cret") = "YWxpY2U6czNjcmV0"
        assert!(
            s.contains("Proxy-Authorization: Basic YWxpY2U6czNjcmV0"),
            "headers: {s}"
        );
        assert!(s.starts_with("CONNECT db.example.com:3306 HTTP/1.1\r\n"));
    }
}
