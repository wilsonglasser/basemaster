mod commands;
mod conn_portability;
mod data_transfer;
mod docker_discovery;
mod mcp_server;
mod sql_dump;
mod sql_import;
mod sql_translate;
mod ssh_tunnel;
mod state;

use basemaster_store::{AppPaths, Store};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,basemaster=debug".into()),
        )
        .init();

    // Sentry: só ativa se SENTRY_DSN setado. Guard precisa viver até o fim
    // da main — guardamos no escopo da função.
    let _sentry_guard = std::env::var("SENTRY_DSN").ok().map(|dsn| {
        sentry::init(sentry::ClientOptions {
            dsn: dsn.parse().ok(),
            release: sentry::release_name!(),
            attach_stacktrace: true,
            send_default_pii: false,
            ..Default::default()
        })
    });

    // prevent-default: desabilita shortcuts nativos do WebView2 (zoom,
    // reload, find, etc) pra chegarem no JS. `browser_accelerator_keys =
    // false` é o que libera Ctrl+=/-/0 pra nosso handler.
    let prevent_default = tauri_plugin_prevent_default::Builder::new()
        .platform(
            tauri_plugin_prevent_default::PlatformOptions::new()
                .browser_accelerator_keys(false),
        )
        .build();

    tauri::Builder::default()
        .plugin(prevent_default)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let paths = AppPaths::resolve()?;
            tracing::info!(?paths.data_dir, "abrindo SQLite local");
            let store = tauri::async_runtime::block_on(Store::open(&paths.db_path()))?;
            app.manage(state::AppState::new(store));
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
            commands::rename_schema,
            commands::apply_table_edits,
            commands::delete_table_rows,
            commands::insert_table_rows,
            commands::query_run,
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
        .expect("erro ao executar BaseMaster");
}
