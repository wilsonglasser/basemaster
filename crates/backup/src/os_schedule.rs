//! Register/unregister a recurring task with the host OS scheduler, pointed at
//! a program + args (e.g. `basemaster-cli schedule run <id>`, or the GUI binary
//! self-invoking the same headless path). The OS just fires it on a cadence;
//! one stable task per schedule keeps the registered task immutable across
//! config edits (only the store row changes).
//!
//! Backends: Windows Task Scheduler (`schtasks`), Linux systemd user timers,
//! macOS launchd (`launchctl`). Only the host platform's path is compiled in.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};

/// When to fire. Kept deliberately small: interval and daily cover the common
/// backup cadences and map cleanly to every OS scheduler.
#[derive(Clone, Copy, Debug)]
pub enum Cadence {
    EveryMinutes(u32),
    DailyAt { hour: u32, minute: u32 },
}

/// Map a stored `(schedule_kind, schedule_expr)` to a cadence. Returns None for
/// `cron` (or anything unrecognized): the OS scheduler isn't driven from here.
pub fn cadence_from(kind: &str, expr: &str) -> Option<Cadence> {
    match kind {
        "interval" => {
            let secs: i64 = expr.parse().ok()?;
            Some(Cadence::EveryMinutes((secs.max(60) / 60) as u32))
        }
        "daily" => {
            let (h, m) = expr.split_once(':')?;
            Some(Cadence::DailyAt {
                hour: h.trim().parse().ok()?,
                minute: m.trim().parse().ok()?,
            })
        }
        _ => None,
    }
}

pub struct TaskSpec {
    /// Schedule id (used to name the OS task deterministically).
    pub id: String,
    /// Absolute path to the program the scheduler runs.
    pub program: PathBuf,
    /// Arguments passed to `program` (e.g. `["schedule", "run", "<id>"]`).
    pub args: Vec<String>,
    pub cadence: Cadence,
}

#[cfg(target_os = "windows")]
fn windows_task_name(id: &str) -> String {
    format!("BaseMaster\\backup-{id}")
}

#[cfg(target_os = "linux")]
fn unix_unit(id: &str) -> String {
    format!("basemaster-backup-{id}")
}

#[cfg(target_os = "macos")]
fn macos_label(id: &str) -> String {
    format!("com.basemaster.backup.{id}")
}

/// Register (or replace) the task. When `dry_run`, prints what it would do.
pub fn register(spec: &TaskSpec, dry_run: bool) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        register_windows(spec, dry_run)
    }
    #[cfg(target_os = "linux")]
    {
        register_systemd(spec, dry_run)
    }
    #[cfg(target_os = "macos")]
    {
        register_launchd(spec, dry_run)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (spec, dry_run);
        bail!("OS scheduler registration not supported on this platform")
    }
}

pub fn unregister(id: &str, dry_run: bool) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let name = windows_task_name(id);
        run_or_print(
            Command::new("schtasks").args(["/Delete", "/F", "/TN", &name]),
            dry_run,
        )
    }
    #[cfg(target_os = "linux")]
    {
        let unit = unix_unit(id);
        if dry_run {
            println!("systemctl --user disable --now {unit}.timer");
            return Ok(());
        }
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", &format!("{unit}.timer")])
            .status();
        if let Some(dir) = systemd_user_dir() {
            let _ = std::fs::remove_file(dir.join(format!("{unit}.timer")));
            let _ = std::fs::remove_file(dir.join(format!("{unit}.service")));
        }
        let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).status();
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let label = macos_label(id);
        if let Some(p) = launchd_plist_path(&label) {
            if dry_run {
                println!("launchctl unload {}", p.display());
                return Ok(());
            }
            let _ = Command::new("launchctl").arg("unload").arg(&p).status();
            let _ = std::fs::remove_file(&p);
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (id, dry_run);
        bail!("OS scheduler not supported on this platform")
    }
}

/// Whether an OS task for this schedule currently exists. Best-effort: used to
/// show registration state in the GUI, never to gate behaviour.
pub fn is_registered(id: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("schtasks")
            .args(["/Query", "/TN", &windows_task_name(id)])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        systemd_user_dir()
            .map(|d| d.join(format!("{}.timer", unix_unit(id))).exists())
            .unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        launchd_plist_path(&macos_label(id))
            .map(|p| p.exists())
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = id;
        false
    }
}

#[allow(dead_code)]
fn run_or_print(cmd: &mut Command, dry_run: bool) -> Result<()> {
    if dry_run {
        println!("{cmd:?}");
        return Ok(());
    }
    let status = cmd.status().context("spawn OS scheduler command")?;
    if !status.success() {
        bail!("scheduler command failed with status {status}");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn register_windows(spec: &TaskSpec, dry_run: bool) -> Result<()> {
    // /TR must be a single string; quote the program path.
    let tr = format!("\"{}\" {}", spec.program.display(), spec.args.join(" "));
    let mut cmd = Command::new("schtasks");
    cmd.args(["/Create", "/F", "/TN", &windows_task_name(&spec.id), "/TR", &tr]);
    match spec.cadence {
        Cadence::EveryMinutes(m) => {
            cmd.args(["/SC", "MINUTE", "/MO", &m.to_string()]);
        }
        Cadence::DailyAt { hour, minute } => {
            cmd.args(["/SC", "DAILY", "/ST", &format!("{hour:02}:{minute:02}")]);
        }
    }
    run_or_print(&mut cmd, dry_run)
}

#[cfg(target_os = "linux")]
fn systemd_user_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/systemd/user"))
}

#[cfg(target_os = "linux")]
fn register_systemd(spec: &TaskSpec, dry_run: bool) -> Result<()> {
    let unit = unix_unit(&spec.id);
    let on_calendar = match spec.cadence {
        Cadence::EveryMinutes(m) => format!("*:0/{m}"),
        Cadence::DailyAt { hour, minute } => format!("*-*-* {hour:02}:{minute:02}:00"),
    };
    let exec = format!("{} {}", spec.program.display(), spec.args.join(" "));
    let service = format!(
        "[Unit]\nDescription=BaseMaster backup {id}\n\n[Service]\nType=oneshot\nExecStart={exec}\n",
        id = spec.id,
    );
    let timer = format!(
        "[Unit]\nDescription=BaseMaster backup timer {id}\n\n[Timer]\nOnCalendar={cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n",
        id = spec.id,
        cal = on_calendar
    );

    if dry_run {
        println!("# {unit}.service\n{service}\n# {unit}.timer\n{timer}");
        println!("systemctl --user daemon-reload && systemctl --user enable --now {unit}.timer");
        return Ok(());
    }
    let dir = systemd_user_dir().context("resolve systemd user dir")?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{unit}.service")), service)?;
    std::fs::write(dir.join(format!("{unit}.timer")), timer)?;
    run_or_print(Command::new("systemctl").args(["--user", "daemon-reload"]), false)?;
    run_or_print(
        Command::new("systemctl").args(["--user", "enable", "--now", &format!("{unit}.timer")]),
        false,
    )
}

#[cfg(target_os = "macos")]
fn launchd_plist_path(label: &str) -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/LaunchAgents").join(format!("{label}.plist")))
}

#[cfg(target_os = "macos")]
fn register_launchd(spec: &TaskSpec, dry_run: bool) -> Result<()> {
    let label = macos_label(&spec.id);
    let interval_block = match spec.cadence {
        Cadence::EveryMinutes(m) => format!(
            "  <key>StartInterval</key>\n  <integer>{}</integer>",
            (m as i64) * 60
        ),
        Cadence::DailyAt { hour, minute } => format!(
            "  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key><integer>{hour}</integer>\n    <key>Minute</key><integer>{minute}</integer>\n  </dict>"
        ),
    };
    let arg_strings: String = std::iter::once(spec.program.display().to_string())
        .chain(spec.args.iter().cloned())
        .map(|a| format!("    <string>{a}</string>\n"))
        .collect();
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{label}</string>\n  <key>ProgramArguments</key>\n  <array>\n{arg_strings}  </array>\n{interval_block}\n</dict>\n</plist>\n",
    );
    let path = launchd_plist_path(&label).context("resolve LaunchAgents dir")?;
    if dry_run {
        println!("# {}\n{plist}", path.display());
        println!("launchctl load {}", path.display());
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, plist)?;
    run_or_print(Command::new("launchctl").arg("load").arg(&path), false)
}
