-- Backups agendados. Cada linha = uma rotina de backup pra uma conexão.
-- O scheduler (in-process no GUI, ou tarefa do SO chamando o CLI) lê estas
-- linhas, roda o dump no formato/escopo configurado e grava em dest_dir.
-- Segredos (senha da conexão) continuam no keyring via connection_id.
CREATE TABLE IF NOT EXISTS scheduled_backups (
    id                 TEXT PRIMARY KEY NOT NULL,
    connection_id      TEXT NOT NULL,
    name               TEXT NOT NULL,
    -- 'interval' (schedule_expr = segundos) ou 'cron' (expr = cron string)
    schedule_kind      TEXT NOT NULL,
    schedule_expr      TEXT NOT NULL,
    dest_dir           TEXT NOT NULL,
    -- 'bmbak' | 'sql' | 'zip'
    format             TEXT NOT NULL,
    -- 'stored' | 'deflate' | 'zstd'
    compression        TEXT NOT NULL DEFAULT 'zstd',
    compression_level  INTEGER NOT NULL DEFAULT 5,
    -- 'structure' | 'data' | 'both'
    content            TEXT NOT NULL DEFAULT 'both',
    -- JSON: [{ "schema": "...", "tables": ["..."] }]. Vazio = tudo.
    scopes_json        TEXT NOT NULL DEFAULT '[]',
    -- retenção: manter últimos N e/ou apagar mais velhos que X dias. NULL = off.
    retention_keep_n   INTEGER,
    retention_days     INTEGER,
    enabled            INTEGER NOT NULL DEFAULT 1,
    last_run_at        INTEGER,
    last_status        TEXT,
    next_run_at        INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_backups_conn
    ON scheduled_backups (connection_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_backups_enabled
    ON scheduled_backups (enabled);
