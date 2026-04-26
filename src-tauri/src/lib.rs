mod commands;
mod conn_portability;
mod data_transfer;
mod docker_discovery;
mod http_proxy_tunnel;
mod mcp_server;
mod sql_dump;
mod sql_import;
mod sql_translate;
mod ssh_known_hosts;
mod ssh_tunnel;
mod state;

use basemaster_store::{AppPaths, Store};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,basemaster=debug".into()),
        )
        .init();

    // Sentry: only activates if SENTRY_DSN is set and NOT empty. Empty string
    // (secret without value in CI) falls into the same path as "not set".
    let _sentry_guard = std::env::var("SENTRY_DSN")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|dsn| {
            sentry::init(sentry::ClientOptions {
                dsn: dsn.parse().ok(),
                release: sentry::release_name!(),
                attach_stacktrace: true,
                send_default_pii: false,
                ..Default::default()
            })
        });

    // prevent-default: disables native WebView2 shortcuts (zoom,
    // reload, find, etc) so they reach JS. `browser_accelerator_keys =
    // false` only exists on Windows — the crate's API is gated by target_os.
    let prevent_default_builder = tauri_plugin_prevent_default::Builder::new();
    #[cfg(target_os = "windows")]
    let prevent_default_builder = prevent_default_builder.platform(
        tauri_plugin_prevent_default::PlatformOptions::new().browser_accelerator_keys(false),
    );
    let prevent_default = prevent_default_builder.build();

    tauri::Builder::default()
        .plugin(prevent_default)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let paths = AppPaths::resolve()?;
            tracing::info!(?paths.data_dir, "abrindo SQLite local");
            let store = match tauri::async_runtime::block_on(Store::open(&paths.db_path())) {
                Ok(s) => s,
                Err(basemaster_store::StoreError::Migrate(e)) => {
                    let msg = format!(
                        "Banco SQLite local está incompatível com esta versão:\n{e}\n\n\
                         O arquivo foi criado por outra build do BaseMaster\n\
                         (tipicamente dev vs release). Delete o diretório\n\
                         {} e reabra o app.",
                        paths.data_dir.display()
                    );
                    write_setup_error(&msg);
                    return Err(msg.into());
                }
                Err(e) => return Err(Box::new(e)),
            };
            let known_hosts_path = paths.data_dir.join("ssh_known_hosts");
            let known_hosts = tauri::async_runtime::block_on(
                ssh_known_hosts::KnownHosts::load(known_hosts_path),
            );
            app.manage(state::AppState::new(store, std::sync::Arc::new(known_hosts)));

            // Safety net: the window starts invisible (visible:false in
            // tauri.conf.json) and main.tsx calls show() as soon as it mounts.
            // If for some reason the bundle doesn't load within 5s, force
            // show() here so we don't leave the window invisible forever.
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    if let Ok(visible) = w.is_visible() {
                        if !visible {
                            tracing::warn!("frontend didn't show() in 5s — forcing");
                            let _ = w.show();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::connection_list,
            commands::connection_get,
            commands::connection_create,
            commands::connection_update,
            commands::connection_delete,
            commands::connection_test,
            commands::connection_open,
            commands::connection_close,
            commands::connection_active,
            commands::list_schemas,
            commands::list_tables,
            commands::describe_table,
            commands::list_indexes,
            commands::list_foreign_keys,
            commands::table_options,
            commands::schema_prefetch,
            commands::table_count,
            commands::table_page,
            commands::duplicate_table,
            commands::find_available_table_name,
            commands::rename_table,
            commands::drop_tables,
            commands::truncate_tables,
            commands::empty_tables,
            commands::rename_schema,
            commands::apply_table_edits,
            commands::delete_table_rows,
            commands::insert_table_rows,
            commands::query_run,
            commands::query_cancel,
            commands::ssh_host_key_respond,
            commands::ssh_known_hosts_list,
            commands::ssh_known_hosts_remove,
            commands::open_detached_window,
            commands::close_window,
            commands::data_transfer_start,
            commands::data_transfer_pause,
            commands::data_transfer_resume,
            commands::data_transfer_stop,
            commands::set_taskbar_progress,
            commands::save_file,
            commands::read_file_bytes,
            commands::sql_dump_start,
            commands::sql_import_start,
            commands::check_binlog_enabled,
            commands::saved_queries_list,
            commands::saved_queries_list_all,
            commands::saved_queries_create,
            commands::saved_queries_update,
            commands::saved_queries_delete,
            commands::query_history_list,
            commands::query_history_insert,
            commands::query_history_delete,
            commands::query_history_clear,
            commands::connection_folders_list,
            commands::connection_folders_create,
            commands::connection_folders_rename,
            commands::connection_folders_delete,
            commands::connection_folders_move,
            commands::mcp_status,
            commands::mcp_start,
            commands::mcp_stop,
            commands::docker_discover_connections,
            commands::connections_export,
            commands::connections_import_parse,
            commands::connections_import_apply,
            commands::connection_reorder,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Instead of panicking (which becomes 0xc0000409 on Windows
            // with no visible stderr), write the message to the error log
            // and exit with a non-zero code.
            let msg = format!("Falha ao iniciar o BaseMaster: {e}");
            write_setup_error(&msg);
            eprintln!("{msg}");
            std::process::exit(1);
        });
}

/// Writes a setup error message to `panic.log` (same location used
/// by the panic hook). Useful for errors we'd rather NOT turn into
/// a panic (e.g., migration mismatch, which has a known solution).
fn write_setup_error(msg: &str) {
    let dir = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(basemaster_store::AppPaths::project_name());
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("panic.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
    {
        use std::io::Write;
        let entry = format!(
            "[{}] SETUP ERROR\n{}\n\n",
            chrono::Utc::now().to_rfc3339(),
            msg,
        );
        let _ = f.write_all(entry.as_bytes());
    }
}

/// Captures panics in release to a file at `%LOCALAPPDATA%\BaseMaster\panic.log`
/// (or `$TEMP/basemaster-panic.log` as fallback). Necessary because the
/// release build runs with windows_subsystem="windows" and `panic=abort`, so
/// stderr is detached and the crash shows up as just `0xc0000409` in Event Viewer
/// with no context.
fn install_panic_hook() {
    // Backtrace only prints if this env is set; force it on before any panic.
    if std::env::var_os("RUST_BACKTRACE").is_none() {
        std::env::set_var("RUST_BACKTRACE", "1");
    }

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = payload_to_string(info.payload());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let backtrace = std::backtrace::Backtrace::force_capture();

        let log = format!(
            "[{}] PANIC at {}\n{}\n\nBacktrace:\n{}\n\n",
            chrono::Utc::now().to_rfc3339(),
            location,
            msg,
            backtrace,
        );

        let dir = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(basemaster_store::AppPaths::project_name());
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("panic.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
        {
            use std::io::Write;
            let _ = f.write_all(log.as_bytes());
        }

        // In dev (stderr attached) we also want to see it in the terminal.
        default_hook(info);
    }));
}

fn payload_to_string(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic payload não-string".to_string()
    }
}
