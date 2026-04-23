//! Detects Docker containers running mysql/mariadb/percona/postgres
//! and extracts host:port + credentials (via env vars) to suggest new
//! connections. Runs `docker ps --format json` + `docker inspect`.
//!
//! Windows: tries `docker` (Docker Desktop exposes it on PATH). If it
//! fails with "not found", tries `wsl docker` — in case the user only
//! runs docker inside WSL.

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Serialize, Debug, Clone)]
pub struct DockerCandidate {
    pub id: String,
    pub container_name: String,
    pub image: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub default_database: Option<String>,
    pub running: bool,
    /// Via `docker` or via `wsl docker`.
    pub via_wsl: bool,
}

#[derive(Deserialize)]
struct PsRow {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names")]
    names: String,
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "State")]
    state: String,
}

#[derive(Deserialize)]
struct InspectRow {
    #[serde(rename = "Config")]
    config: InspectConfig,
    #[serde(rename = "NetworkSettings")]
    network_settings: InspectNetwork,
}

#[derive(Deserialize)]
struct InspectConfig {
    #[serde(rename = "Env")]
    env: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct InspectNetwork {
    #[serde(rename = "Ports")]
    ports: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Attempt order: (program, args-prefix, via_wsl).
fn base_commands() -> Vec<(&'static str, Vec<&'static str>, bool)> {
    if cfg!(target_os = "windows") {
        vec![
            ("docker", vec![], false),
            ("wsl", vec!["-e", "docker"], true),
        ]
    } else {
        vec![("docker", vec![], false)]
    }
}

async fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows: hide the child process's console window.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().await.map_err(|e| format!("{program}: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{program} falhou (exit={:?}): {}",
            out.status.code(),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn image_driver(image: &str) -> Option<&'static str> {
    let i = image.to_ascii_lowercase();
    // Separate repository from tag to match names like "library/mysql:8".
    let repo = i.split(':').next().unwrap_or(&i);
    let last = repo.rsplit('/').next().unwrap_or(repo);
    if last == "mysql"
        || last == "mariadb"
        || last == "percona"
        || last == "percona-server"
        || last.starts_with("mysql-")
        || last.starts_with("mariadb-")
    {
        return Some("mysql");
    }
    if last == "postgres"
        || last == "postgis"
        || last == "pgvector"
        || last == "timescale"
        || last == "timescaledb"
        || last.starts_with("postgres-")
        || last.starts_with("timescale")
        || last.starts_with("pgvector")
    {
        return Some("postgres");
    }
    None
}

fn container_port_for(driver: &str) -> &'static str {
    match driver {
        "mysql" => "3306/tcp",
        "postgres" => "5432/tcp",
        _ => "",
    }
}

fn host_port_for(inspect: &InspectRow, container_port: &str) -> Option<u16> {
    let ports = inspect.network_settings.ports.as_ref()?;
    let bindings = ports.get(container_port)?;
    let arr = bindings.as_array()?;
    let first = arr.first()?;
    let hp = first.get("HostPort")?.as_str()?;
    hp.parse().ok()
}

fn env_get<'a>(envs: &'a [String], keys: &[&str]) -> Option<&'a str> {
    for e in envs {
        if let Some(eq) = e.find('=') {
            let (k, v) = e.split_at(eq);
            let v = &v[1..];
            if keys.iter().any(|target| target.eq_ignore_ascii_case(k)) {
                return Some(v);
            }
        }
    }
    None
}

fn credentials_from_env(
    envs: &[String],
    driver: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    match driver {
        "mysql" => {
            let user = env_get(envs, &["MYSQL_USER", "MARIADB_USER"])
                .map(|s| s.to_string())
                .or_else(|| Some("root".to_string()));
            // If MYSQL_USER is defined, use MYSQL_PASSWORD; otherwise ROOT_PASSWORD.
            let password = if env_get(envs, &["MYSQL_USER", "MARIADB_USER"]).is_some() {
                env_get(
                    envs,
                    &["MYSQL_PASSWORD", "MARIADB_PASSWORD"],
                )
                .map(|s| s.to_string())
            } else {
                env_get(
                    envs,
                    &[
                        "MYSQL_ROOT_PASSWORD",
                        "MARIADB_ROOT_PASSWORD",
                        "MYSQL_RANDOM_ROOT_PASSWORD",
                    ],
                )
                .map(|s| s.to_string())
            };
            let db = env_get(envs, &["MYSQL_DATABASE", "MARIADB_DATABASE"])
                .map(|s| s.to_string());
            (user, password, db)
        }
        "postgres" => {
            let user = env_get(envs, &["POSTGRES_USER"])
                .map(|s| s.to_string())
                .or_else(|| Some("postgres".to_string()));
            let password = env_get(envs, &["POSTGRES_PASSWORD"]).map(|s| s.to_string());
            let db = env_get(envs, &["POSTGRES_DB"]).map(|s| s.to_string());
            (user, password, db)
        }
        _ => (None, None, None),
    }
}

async fn list_containers(
    program: &str,
    base_args: &[&str],
) -> Result<Vec<PsRow>, String> {
    let mut args = base_args.to_vec();
    args.extend_from_slice(&["ps", "-a", "--format", "{{json .}}", "--no-trunc"]);
    let out = run(program, &args).await?;
    let mut rows = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<PsRow>(line) {
            Ok(r) => rows.push(r),
            Err(e) => tracing::warn!(%e, "linha docker ps inválida"),
        }
    }
    Ok(rows)
}

async fn inspect(
    program: &str,
    base_args: &[&str],
    id: &str,
) -> Result<InspectRow, String> {
    let mut args = base_args.to_vec();
    args.extend_from_slice(&["inspect", id]);
    let out = run(program, &args).await?;
    let arr: Vec<InspectRow> =
        serde_json::from_str(&out).map_err(|e| format!("inspect parse: {e}"))?;
    arr.into_iter()
        .next()
        .ok_or_else(|| "inspect vazio".to_string())
}

/// Try the CLI variants until one works.
pub async fn discover() -> Result<Vec<DockerCandidate>, String> {
    let variants = base_commands();
    let mut last_err = String::new();

    for (program, base_args, via_wsl) in variants {
        match list_containers(program, &base_args).await {
            Ok(rows) => {
                let mut out = Vec::new();
                for row in rows {
                    let driver = match image_driver(&row.image) {
                        Some(d) => d,
                        None => continue,
                    };
                    let running = row.state == "running";
                    let info = match inspect(program, &base_args, &row.id).await {
                        Ok(i) => i,
                        Err(e) => {
                            tracing::warn!(%e, container = %row.id, "docker inspect falhou");
                            continue;
                        }
                    };
                    let cport = container_port_for(driver);
                    let host_port = host_port_for(&info, cport);
                    let envs = info.config.env.unwrap_or_default();
                    let (user, password, db) = credentials_from_env(&envs, driver);

                    // Containers without port mapping aren't useful (we
                    // connect via host; the user may only expose to
                    // other pods). Skip.
                    let port = match host_port {
                        Some(p) => p,
                        None => continue,
                    };

                    out.push(DockerCandidate {
                        id: row.id,
                        container_name: row.names.trim_start_matches('/').to_string(),
                        image: row.image,
                        driver: driver.to_string(),
                        host: "127.0.0.1".to_string(),
                        port,
                        user,
                        password,
                        default_database: db,
                        running,
                        via_wsl,
                    });
                }
                // Running first, then alphabetical.
                out.sort_by(|a, b| {
                    b.running
                        .cmp(&a.running)
                        .then(a.container_name.cmp(&b.container_name))
                });
                return Ok(out);
            }
            Err(e) => {
                last_err = e;
            }
        }
    }

    Err(format!(
        "Docker não encontrado. Última tentativa: {last_err}"
    ))
}
