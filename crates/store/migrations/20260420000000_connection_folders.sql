-- Pastas pra agrupar conexões na sidebar. 1 nível só — sem nested.
CREATE TABLE IF NOT EXISTS connection_folders (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

-- Conexão pode ficar numa pasta ou no root (folder_id NULL).
ALTER TABLE connection_profiles ADD COLUMN folder_id TEXT
    REFERENCES connection_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_connections_folder
    ON connection_profiles (folder_id);
