-- Histórico de queries executadas pelo usuário no query editor.
-- Uma linha por execução (não por statement). `sql` guarda o texto
-- completo pro re-run; `error_msg` fica NULL em sucesso.
CREATE TABLE IF NOT EXISTS query_history (
    id             TEXT PRIMARY KEY NOT NULL,
    connection_id  TEXT NOT NULL,
    schema         TEXT,
    sql            TEXT NOT NULL,
    executed_at    INTEGER NOT NULL,
    elapsed_ms     INTEGER NOT NULL,
    rows_affected  INTEGER,
    success        INTEGER NOT NULL DEFAULT 1,
    error_msg      TEXT,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_query_history_conn_time
    ON query_history (connection_id, executed_at DESC);
