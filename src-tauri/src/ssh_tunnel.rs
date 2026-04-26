//! SSH tunnel (local forward) via russh. Supports:
//!  - password or private-key auth at every hop
//!  - N-hop jump chain: each hop routes direct-tcpip to the next hop's
//!    SSH port, the next session runs over that channel's stream
//!  - final hop opens direct-tcpip to the target DB
//!
//! Usage:
//!   let tunnel = SshTunnel::open(&jumps, &final_cfg, target_host, target_port).await?;
//!   // driver connects to 127.0.0.1:tunnel.local_port
//!   tunnel.close().await;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use std::collections::HashMap;
use std::time::Duration as StdDuration;

use basemaster_core::SshTunnelConfig;
use russh::client::{self, Config, Handle};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex, RwLock as TokioRwLock};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::ssh_known_hosts::{fingerprint_sha256, KnownHosts, Verdict};

/// Shared context threaded into every SSH hop handler so a prompt can
/// reach the frontend and get a response back.
#[derive(Clone)]
pub struct HostKeyPromptCtx {
    pub app: AppHandle,
    pub known_hosts: Arc<KnownHosts>,
    pub prompts: Arc<TokioRwLock<HashMap<Uuid, oneshot::Sender<bool>>>>,
}

/// Event payload — matches the `SshHostKeyPrompt` type in `src/lib/types.ts`.
#[derive(Serialize, Clone)]
struct HostKeyPromptEvent<'a> {
    request_id: Uuid,
    host: &'a str,
    port: u16,
    algorithm: String,
    fingerprint_sha256: String,
}

/// Verifies the server's public key against our stored `known_hosts`.
///  * `Match`    → accept immediately.
///  * `Mismatch` → reject (russh aborts the handshake; the caller
///    translates that into a clear MITM-style error).
///  * `Unknown`  → emit `ssh-host-key-prompt` to the frontend and wait
///    for the user to accept or reject. Times out after 2 minutes with
///    rejection so a dead UI doesn't leave the server hanging.
struct VerifyingHostKeys {
    host: String,
    port: u16,
    ctx: HostKeyPromptCtx,
}

impl client::Handler for VerifyingHostKeys {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match self
            .ctx
            .known_hosts
            .verify(&self.host, self.port, server_public_key)
        {
            Verdict::Match => Ok(true),
            Verdict::Mismatch => Ok(false),
            Verdict::Unknown => {
                let request_id = Uuid::new_v4();
                let (tx, rx) = oneshot::channel();
                self.ctx
                    .prompts
                    .write()
                    .await
                    .insert(request_id, tx);

                let algorithm =
                    server_public_key.algorithm().as_str().to_string();
                let fingerprint = fingerprint_sha256(server_public_key);
                let payload = HostKeyPromptEvent {
                    request_id,
                    host: &self.host,
                    port: self.port,
                    algorithm,
                    fingerprint_sha256: fingerprint,
                };
                if let Err(e) = self.ctx.app.emit("ssh-host-key-prompt", payload) {
                    tracing::warn!("emit ssh-host-key-prompt: {e}");
                    // Can't prompt the user → fail safe (reject).
                    self.ctx.prompts.write().await.remove(&request_id);
                    return Ok(false);
                }

                let accepted = match tokio::time::timeout(
                    StdDuration::from_secs(120),
                    rx,
                )
                .await
                {
                    Ok(Ok(b)) => b,
                    _ => {
                        self.ctx.prompts.write().await.remove(&request_id);
                        false
                    }
                };

                if accepted {
                    if let Err(e) = self
                        .ctx
                        .known_hosts
                        .add(&self.host, self.port, server_public_key.clone())
                        .await
                    {
                        tracing::warn!(
                            host = %self.host,
                            port = self.port,
                            "persist accepted SSH host key: {e}"
                        );
                    }
                }
                Ok(accepted)
            }
        }
    }
}

pub struct SshTunnel {
    pub local_port: u16,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
    /// All sessions in the chain (jumps + final), in order. Held to keep
    /// them alive; dropped together on close(). Final session is last.
    sessions: Vec<Arc<Mutex<Handle<VerifyingHostKeys>>>>,
}

impl SshTunnel {
    /// Opens the tunnel on a free local port.
    ///
    /// `jumps` are traversed in order; each hop's SSH session opens a
    /// direct-tcpip channel to the next hop's SSH port. The `final_cfg`
    /// hop is where the local forward to `target_host:target_port`
    /// originates.
    pub async fn open(
        jumps: &[SshTunnelConfig],
        final_cfg: &SshTunnelConfig,
        target_host: &str,
        target_port: u16,
        ctx: HostKeyPromptCtx,
    ) -> Result<Self, String> {
        let config = Arc::new(Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            ..Config::default()
        });

        // Walk the chain. Each iteration authenticates a session and, if
        // there's a next hop, opens a direct-tcpip channel to it, turns
        // it into a stream, and feeds it to the next `connect_stream`.
        let mut sessions: Vec<Arc<Mutex<Handle<VerifyingHostKeys>>>> =
            Vec::with_capacity(jumps.len() + 1);

        let all_hops: Vec<&SshTunnelConfig> =
            jumps.iter().chain(std::iter::once(final_cfg)).collect();

        let make_handler = |cfg: &SshTunnelConfig| VerifyingHostKeys {
            host: cfg.host.clone(),
            port: cfg.port,
            ctx: ctx.clone(),
        };
        let host_key_err = |host: &str, e: russh::Error| -> String {
            match &e {
                russh::Error::UnknownKey => format!(
                    "SSH host key mismatch for {host}: the server's key differs from the \
                     one stored in known_hosts. This may indicate a MITM attack, or the \
                     server's key legitimately changed. Remove the stored entry from \
                     <app-data>/ssh_known_hosts and reconnect to accept the new key."
                ),
                _ => format!("ssh connect {host}: {e}"),
            }
        };

        // Hop 0: plain TcpStream.
        let first = all_hops[0];
        let addr = format!("{}:{}", first.host, first.port);
        let mut session = client::connect(config.clone(), addr, make_handler(first))
            .await
            .map_err(|e| host_key_err(&first.host, e))?;
        authenticate(&mut session, first).await?;
        let mut current: Arc<Mutex<Handle<VerifyingHostKeys>>> =
            Arc::new(Mutex::new(session));
        sessions.push(current.clone());

        // Subsequent hops: open direct-tcpip from the current session
        // to the next hop's SSH port, and connect through the channel.
        for next in &all_hops[1..] {
            let channel = {
                let sess = current.lock().await;
                sess.channel_open_direct_tcpip(
                    next.host.clone(),
                    next.port as u32,
                    "127.0.0.1".to_string(),
                    0,
                )
                .await
                .map_err(|e| format!("ssh jump open to {}: {e}", next.host))?
            };
            let stream = channel.into_stream();
            let mut next_session =
                client::connect_stream(config.clone(), stream, make_handler(next))
                    .await
                    .map_err(|e| host_key_err(&next.host, e))?;
            authenticate(&mut next_session, next).await?;
            current = Arc::new(Mutex::new(next_session));
            sessions.push(current.clone());
        }

        // Local listener on a free port.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind local tunnel: {e}"))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| format!("local_addr: {e}"))?
            .port();

        // Task that accepts local connections and forwards each one
        // through the final session as direct-tcpip to the DB.
        let final_session = current.clone();
        let target_host = target_host.to_string();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    accept = listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                let session = final_session.clone();
                                let host = target_host.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = forward_connection(
                                        session, stream, addr, &host, target_port,
                                    ).await {
                                        eprintln!("ssh forward error: {e}");
                                    }
                                });
                            }
                            Err(e) => {
                                eprintln!("ssh listener accept error: {e}");
                                break;
                            }
                        }
                    }
                }
            }
        });

        Ok(SshTunnel {
            local_port,
            stop_tx: Some(stop_tx),
            task: Some(task),
            sessions,
        })
    }

    /// Stops the listener and closes every session in the chain, from
    /// final back to first.
    pub async fn close(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        // Close from the end towards the first hop so inner sessions see
        // EOF from outer sessions in the right order.
        while let Some(sess) = self.sessions.pop() {
            let sess = sess.lock().await;
            let _ = sess
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
}

/// Attempts private-key auth first, then password. Mirrors the former
/// single-hop logic. One of the two must succeed or we return Err.
async fn authenticate(
    session: &mut Handle<VerifyingHostKeys>,
    cfg: &SshTunnelConfig,
) -> Result<(), String> {
    let mut tried = false;
    let mut last_err: Option<String> = None;

    if let Some(key_path) = cfg.private_key_path.as_deref().filter(|s| !s.is_empty()) {
        tried = true;
        match load_secret_key(key_path, cfg.private_key_passphrase.as_deref()) {
            Ok(key) => {
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| format!("best rsa hash: {e}"))?
                    .flatten();
                let signer = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
                match session.authenticate_publickey(cfg.user.clone(), signer).await {
                    Ok(r) if r.success() => {}
                    Ok(_) => {
                        last_err = Some(format!(
                            "chave privada rejeitada pelo servidor ({})",
                            cfg.host
                        ));
                    }
                    Err(e) => last_err = Some(format!("ssh key auth ({}): {e}", cfg.host)),
                }
            }
            Err(e) => last_err = Some(format!("load key: {e}")),
        }
    }

    let authed_via_key = tried && last_err.is_none();
    if !authed_via_key {
        if let Some(pwd) = cfg.password.as_deref().filter(|s| !s.is_empty()) {
            tried = true;
            match session.authenticate_password(cfg.user.clone(), pwd).await {
                Ok(r) if r.success() => {
                    last_err = None;
                }
                Ok(_) => {
                    last_err = Some(format!("credenciais SSH inválidas ({})", cfg.host));
                }
                Err(e) => last_err = Some(format!("ssh password auth ({}): {e}", cfg.host)),
            }
        }
    }

    if !tried {
        return Err(format!(
            "ssh: nenhum método de auth fornecido (hop {})",
            cfg.host
        ));
    }
    match last_err {
        None => Ok(()),
        Some(e) => Err(e),
    }
}

/// Bidirectional pipe between a local TCP connection and an SSH
/// direct-tcpip channel opened on `session`.
async fn forward_connection(
    session: Arc<Mutex<Handle<VerifyingHostKeys>>>,
    mut stream: TcpStream,
    originator: SocketAddr,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
    let mut channel = {
        let session = session.lock().await;
        session
            .channel_open_direct_tcpip(
                target_host.to_string(),
                target_port as u32,
                originator.ip().to_string(),
                originator.port() as u32,
            )
            .await
            .map_err(|e| format!("open direct-tcpip: {e}"))?
    };

    let mut stream_closed = false;
    let mut buf = vec![0u8; 65536];
    loop {
        tokio::select! {
            r = stream.read(&mut buf), if !stream_closed => {
                match r {
                    Ok(0) => {
                        stream_closed = true;
                        let _ = channel.eof().await;
                    }
                    Ok(n) => {
                        channel
                            .data(&buf[..n])
                            .await
                            .map_err(|e| format!("ch data: {e}"))?;
                    }
                    Err(e) => return Err(format!("read local: {e}")),
                }
            }
            Some(msg) = channel.wait() => {
                match msg {
                    ChannelMsg::Data { ref data } => {
                        stream
                            .write_all(data)
                            .await
                            .map_err(|e| format!("write local: {e}"))?;
                    }
                    ChannelMsg::Eof => {
                        if !stream_closed {
                            let _ = channel.eof().await;
                        }
                        break;
                    }
                    ChannelMsg::WindowAdjusted { .. } => {}
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

