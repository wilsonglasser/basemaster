//! `basemaster-cli` ships as a Tauri sidecar next to the app binary, so the
//! installer and the updater carry it. These commands tell the UI where it
//! landed and put it on the user's PATH so scripts can call it by name.

use std::path::{Path, PathBuf};

use serde::Serialize;

const BIN_NAME: &str = if cfg!(windows) {
    "basemaster-cli.exe"
} else {
    "basemaster-cli"
};

#[derive(Serialize)]
pub struct CliInfo {
    /// Absolute path of the bundled binary; `None` when the build has no sidecar.
    pub path: Option<String>,
    /// `basemaster-cli` resolves on this process's PATH (or through the
    /// symlink we create on Unix).
    pub on_path: bool,
    /// Where `cli_add_to_path` links/points to, for the hint in the UI.
    pub link_dir: String,
}

fn bundled_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(BIN_NAME);
    candidate.exists().then_some(candidate)
}

#[cfg(unix)]
fn link_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".local")
        .join("bin")
}

#[cfg(windows)]
fn link_dir() -> PathBuf {
    bundled_path()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

fn on_path(bundled: Option<&Path>) -> bool {
    let Some(bundled) = bundled else {
        return false;
    };
    let dir = bundled.parent();
    let in_env = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p).any(|d| Some(d.as_path()) == dir || d.join(BIN_NAME).exists())
        })
        .unwrap_or(false);
    #[cfg(unix)]
    {
        in_env || link_dir().join(BIN_NAME).exists()
    }
    #[cfg(windows)]
    {
        in_env || user_path_contains(dir.unwrap_or(bundled))
    }
}

fn info() -> CliInfo {
    let bundled = bundled_path();
    CliInfo {
        on_path: on_path(bundled.as_deref()),
        path: bundled.map(|p| p.to_string_lossy().into_owned()),
        link_dir: link_dir().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn cli_info() -> CliInfo {
    info()
}

#[tauri::command]
pub fn cli_add_to_path() -> Result<CliInfo, String> {
    let bundled = bundled_path().ok_or_else(|| {
        "basemaster-cli is not bundled with this build (run from an installed package)".to_string()
    })?;
    add_to_path(&bundled)?;
    Ok(info())
}

#[cfg(unix)]
fn add_to_path(bundled: &Path) -> Result<(), String> {
    let dir = link_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let link = dir.join(BIN_NAME);
    if link.exists() || link.symlink_metadata().is_ok() {
        std::fs::remove_file(&link).map_err(|e| format!("replace {}: {e}", link.display()))?;
    }
    std::os::unix::fs::symlink(bundled, &link)
        .map_err(|e| format!("symlink {}: {e}", link.display()))
}

/// Appends the install dir to the per-user PATH through PowerShell's
/// `[Environment]::SetEnvironmentVariable`, which writes the registry and
/// broadcasts WM_SETTINGCHANGE so new shells see it. `setx` is avoided:
/// it truncates PATH at 1024 characters.
#[cfg(windows)]
fn add_to_path(bundled: &Path) -> Result<(), String> {
    let dir = bundled
        .parent()
        .ok_or_else(|| "no parent dir".to_string())?
        .to_string_lossy()
        .replace('\'', "''");
    let script = format!(
        "$d = '{dir}'; \
         $p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
         if ($null -eq $p) {{ $p = '' }}; \
         if (($p -split ';' | Where-Object {{ $_ }}) -notcontains $d) {{ \
           [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d).TrimStart(';'), 'User') \
         }}"
    );
    let out = powershell(&script)?;
    if !out.status.success() {
        return Err(format!(
            "PowerShell failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn user_path_contains(dir: &Path) -> bool {
    let want = dir.to_string_lossy().to_ascii_lowercase();
    let script = "[Environment]::GetEnvironmentVariable('Path', 'User')";
    match powershell(script) {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .split(';')
            .any(|p| p.trim().trim_end_matches('\\').eq_ignore_ascii_case(want.trim_end_matches('\\'))),
        _ => false,
    }
}

#[cfg(windows)]
fn powershell(script: &str) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("run powershell: {e}"))
}
