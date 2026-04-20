//! SSH tunnel (local forward) via russh. V1: suporta password-auth.
//! Key auth vem na próxima iteração.
//!
//! Uso:
//!   let tunnel = SshTunnel::open(&ssh_cfg, target_host, target_port).await?;
//!   // conecte MySQL em 127.0.0.1:tunnel.local_port
//!   // ...
//!   tunnel.close().await;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use basemaster_core::SshTunnelConfig;
use russh::client::{self, Config, Handle};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

/// Handler que aceita qualquer host key. TODO futura: "known hosts" like.
struct AcceptAllHostKeys;

impl client::Handler for AcceptAllHostKeys {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct SshTunnel {
    pub local_port: u16,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
    session: Arc<Mutex<Handle<AcceptAllHostKeys>>>,
}

impl SshTunnel {
    /// Abre o túnel em uma porta local livre. Retorna a porta alocada.
    /// `target_host:target_port` é o endereço DESTINO (do lado servidor do SSH).
    pub async fn open(
        ssh: &SshTunnelConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<Self, String> {
        // 1. Conecta SSH
        let config = Arc::new(Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            ..Config::default()
        });
        let addr = format!("{}:{}", ssh.host, ssh.port);
        let mut session = client::connect(config, addr, AcceptAllHostKeys)
            .await
            .map_err(|e| format!("ssh connect: {}", e))?;

        // 2. Auth — tenta private key primeiro (se configurada),
        // fallback pra password. Pelo menos um deve estar presente.
        let mut tried = false;
        let mut last_err: Option<String> = None;

        if let Some(key_path) = ssh.private_key_path.as_deref().filter(|s| !s.is_empty()) {
            tried = true;
            match load_secret_key(
                key_path,
                ssh.private_key_passphrase.as_deref(),
            ) {
                Ok(key) => {
                    let hash = session
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|e| format!("best rsa hash: {}", e))?
                        .flatten();
                    let signer = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
                    match session
                        .authenticate_publickey(ssh.user.clone(), signer)
                        .await
                    {
                        Ok(r) if r.success() => {
                            // autenticado com sucesso
                        }
                        Ok(_) => {
                            last_err = Some("chave privada rejeitada pelo servidor".into());
                        }
                        Err(e) => last_err = Some(format!("ssh key auth: {}", e)),
                    }
                }
                Err(e) => {
                    last_err = Some(format!("load key: {}", e));
                }
            }
        }

        // Se ainda não autenticou e tem password, tenta.
        let authed_via_key = tried && last_err.is_none();
        if !authed_via_key {
            if let Some(pwd) = ssh.password.as_deref().filter(|s| !s.is_empty()) {
                tried = true;
                match session.authenticate_password(ssh.user.clone(), pwd).await {
                    Ok(r) if r.success() => {
                        last_err = None;
                    }
                    Ok(_) => {
                        last_err = Some("credenciais SSH inválidas".into());
                    }
                    Err(e) => last_err = Some(format!("ssh password auth: {}", e)),
                }
            }
        }

        if !tried {
            return Err("ssh: nenhum método de auth fornecido (senha ou chave)".into());
        }
        if let Some(e) = last_err {
            return Err(e);
        }

        // 3. Listener local em porta livre (0 = sistema escolhe)
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind local tunnel: {}", e))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| format!("local_addr: {}", e))?
            .port();

        // 4. Task que aceita conexões locais e faz forward
        let session = Arc::new(Mutex::new(session));
        let session_for_task = session.clone();
        let target_host = target_host.to_string();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    accept = listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                let session = session_for_task.clone();
                                let host = target_host.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = forward_connection(
                                        session,
                                        stream,
                                        addr,
                                        &host,
                                        target_port,
                                    ).await {
                                        eprintln!("ssh forward error: {}", e);
                                    }
                                });
                            }
                            Err(e) => {
                                eprintln!("ssh listener accept error: {}", e);
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
            session,
        })
    }

    /// Para o listener e fecha a sessão SSH.
    pub async fn close(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        let session = self.session.lock().await;
        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

/// Pipe bidirecional entre uma conexão TCP local e um canal direct-tcpip SSH.
async fn forward_connection(
    session: Arc<Mutex<Handle<AcceptAllHostKeys>>>,
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
            .map_err(|e| format!("open direct-tcpip: {}", e))?
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
                            .map_err(|e| format!("ch data: {}", e))?;
                    }
                    Err(e) => return Err(format!("read local: {}", e)),
                }
            }
            Some(msg) = channel.wait() => {
                match msg {
                    ChannelMsg::Data { ref data } => {
                        stream
                            .write_all(data)
                            .await
                            .map_err(|e| format!("write local: {}", e))?;
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
