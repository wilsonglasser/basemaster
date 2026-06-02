//! Headless backup entry. The OS scheduler fires this binary as
//! `<exe> schedule run <id>`; we run that schedule without a window and exit,
//! so the GUI binary is the program the scheduler invokes (no separate CLI to
//! deploy on the user's machine).
//!
//! Connections are opened fresh from the local store + keyring, reusing the
//! GUI's tunnel-aware connect path ([`crate::commands::open_driver_with_tunnel`])
//! so SSH-tunnelled connections work in scheduled runs too. With no UI to
//! prompt, an unknown SSH host key fails safe (rejected) — the key must already
//! be trusted from a prior interactive connect.

use std::collections::HashMap;
use std::sync::Arc;

use basemaster_backup::dump::{NoProgress, Progress};
use basemaster_backup::schedule::{dump_schedule, record_result};
use basemaster_store::{AppPaths, Store};
use tauri::AppHandle;
use tokio::sync::{oneshot, RwLock};
use uuid::Uuid;

use crate::ssh_known_hosts::KnownHosts;
use crate::ssh_tunnel::HostKeyPolicy;

type Prompts = Arc<RwLock<HashMap<Uuid, oneshot::Sender<bool>>>>;

struct StderrProgress;
impl Progress for StderrProgress {
    fn table_started(&self, table: &str, total: u64) {
        eprintln!("  {table}: {total} rows…");
    }
    fn table_done(&self, table: &str, rows: u64) {
        eprintln!("  {table}: done ({rows} rows)");
    }
}

/// Run a schedule: open the connection (tunnel-aware), dump, record the run.
/// `policy` decides what happens on an unknown SSH host key (prompt in the GUI,
/// auto-accept with `--accept-ssh-hosts`, or reject).
pub async fn run_schedule(
    store: &Store,
    known_hosts: Arc<KnownHosts>,
    prompts: Prompts,
    policy: HostKeyPolicy,
    id: Uuid,
    progress: &dyn Progress,
) -> Result<String, String> {
    let sched = store
        .scheduled_backups()
        .get(id)
        .await
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now();

    let result: anyhow::Result<String> = async {
        let (driver, tunnel, cfg) =
            crate::commands::open_driver_with_tunnel(store, known_hosts, prompts, policy, id)
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
        let r = dump_schedule(
            &sched,
            driver.as_ref(),
            cfg.default_database.as_deref(),
            now,
            progress,
        )
        .await;
        let _ = driver.disconnect().await;
        if let Some(t) = tunnel {
            t.close().await;
        }
        r
    }
    .await;

    record_result(store, &sched, now, result)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// If invoked as `<exe> schedule run <id> [--accept-ssh-hosts]`, run that backup
/// and exit. Returns normally only when the args don't match (GUI launch).
/// `--accept-ssh-hosts` opts into TOFU for an unknown SSH host key (otherwise a
/// scheduled run against an untrusted host fails safe).
pub fn maybe_run_and_exit() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() >= 3 && args[0] == "schedule" && args[1] == "run" {
        let accept = args[3..].iter().any(|a| a == "--accept-ssh-hosts");
        let policy = if accept {
            HostKeyPolicy::AcceptNew
        } else {
            HostKeyPolicy::Reject
        };
        let code = run_one(&args[2], policy);
        std::process::exit(code);
    }
}

fn run_one(id: &str, policy: HostKeyPolicy) -> i32 {
    tauri::async_runtime::block_on(async {
        let uuid: Uuid = match id.parse() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("invalid schedule id '{id}': {e}");
                return 1;
            }
        };
        let paths = match AppPaths::resolve() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("resolve app paths: {e}");
                return 1;
            }
        };
        let store = match Store::open(&paths.db_path()).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("open store: {e}");
                return 1;
            }
        };
        // Same known_hosts file the GUI uses; no UI → no prompt ctx (app: None).
        let known_hosts = Arc::new(KnownHosts::load(paths.data_dir.join("ssh_known_hosts")).await);
        let prompts: Prompts = Arc::new(RwLock::new(HashMap::new()));
        match run_schedule(&store, known_hosts, prompts, policy, uuid, &StderrProgress).await {
            Ok(file) => {
                eprintln!("backup done: {file}");
                0
            }
            Err(e) => {
                eprintln!("backup failed: {e}");
                1
            }
        }
    })
}

/// Shared entry for the GUI "run now" command: prompts are available (`app`),
/// progress is discarded.
pub async fn run_now(
    store: &Store,
    known_hosts: Arc<KnownHosts>,
    prompts: Prompts,
    app: AppHandle,
    id: Uuid,
) -> Result<String, String> {
    run_schedule(
        store,
        known_hosts,
        prompts,
        HostKeyPolicy::Prompt(app),
        id,
        &NoProgress,
    )
    .await
}
