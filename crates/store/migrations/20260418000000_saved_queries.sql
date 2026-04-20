-- Queries salvas por conexão + schema. `schema` é opcional:
-- NULL significa "query desse banco inteira, sem schema específico" — raro
-- mas útil em scripts administrativos (ex: SHOW STATUS). O comum é ter schema.
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
