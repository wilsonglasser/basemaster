-- Pastas pra agrupar conexões na sidebar. 1 nível só — sem nested.
CREATE TABLE IF NOT EXISTS connection_folders (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

-- Perfis de conexão (MySQL/Postgres/SQLite/MariaDB). Senhas ficam no
-- keyring do SO, referenciadas pelo `id` — nunca aqui.
CREATE TABLE IF NOT EXISTS connection_profiles (
    id                TEXT PRIMARY KEY NOT NULL,
    name              TEXT NOT NULL,
    color             TEXT,
    driver            TEXT NOT NULL,
    host              TEXT NOT NULL,
    port              INTEGER NOT NULL,
    user              TEXT NOT NULL,
    default_database  TEXT,
    tls               TEXT NOT NULL DEFAULT 'preferred',
    ssh_tunnel        TEXT,
    folder_id         TEXT REFERENCES connection_folders(id) ON DELETE SET NULL,
    sort_order        INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_used_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_connection_profiles_name
    ON connection_profiles (name);
CREATE INDEX IF NOT EXISTS idx_connections_folder
    ON connection_profiles (folder_id);
CREATE INDEX IF NOT EXISTS idx_connections_sort
    ON connection_profiles (sort_order);

-- Queries salvas por conexão + schema. `schema` é opcional: NULL =
-- "query do banco inteira, sem schema" (raro, mas útil em scripts
-- administrativos tipo SHOW STATUS). O comum é ter schema.
CREATE TABLE IF NOT EXISTS saved_queries (
    id              TEXT PRIMARY KEY NOT NULL,
    connection_id   TEXT NOT NULL,
    schema          TEXT,
    name            TEXT NOT NULL,
    sql             TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_conn_schema
    ON saved_queries (connection_id, schema);

-- Histórico de queries executadas pelo usuário no editor. Uma linha
-- por execução (não por statement). `sql` guarda texto pro re-run;
-- `error_msg` é NULL em sucesso.
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
