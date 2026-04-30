-- UI-only grouping: schemas and tables live remotely, so we keep folder
-- assignments locally indexed by the remote name. Deleting a folder
-- cascades the items rows away, so members "go back to root".

-- Pastas de schema dentro de uma conexão.
CREATE TABLE IF NOT EXISTS schema_folders (
    id             TEXT PRIMARY KEY NOT NULL,
    connection_id  TEXT NOT NULL,
    name           TEXT NOT NULL,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schema_folders_conn
    ON schema_folders (connection_id);

-- Assignment: 1 schema -> 0..1 folder.
CREATE TABLE IF NOT EXISTS schema_folder_items (
    connection_id  TEXT NOT NULL,
    schema_name    TEXT NOT NULL,
    folder_id      TEXT NOT NULL,
    PRIMARY KEY (connection_id, schema_name),
    FOREIGN KEY (folder_id) REFERENCES schema_folders(id) ON DELETE CASCADE,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schema_folder_items_folder
    ON schema_folder_items (folder_id);

-- Pastas de tabela dentro de um schema (de uma conexão).
CREATE TABLE IF NOT EXISTS table_folders (
    id             TEXT PRIMARY KEY NOT NULL,
    connection_id  TEXT NOT NULL,
    schema_name    TEXT NOT NULL,
    name           TEXT NOT NULL,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_table_folders_scope
    ON table_folders (connection_id, schema_name);

-- Assignment: 1 tabela -> 0..1 folder.
CREATE TABLE IF NOT EXISTS table_folder_items (
    connection_id  TEXT NOT NULL,
    schema_name    TEXT NOT NULL,
    table_name     TEXT NOT NULL,
    folder_id      TEXT NOT NULL,
    PRIMARY KEY (connection_id, schema_name, table_name),
    FOREIGN KEY (folder_id) REFERENCES table_folders(id) ON DELETE CASCADE,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_table_folder_items_folder
    ON table_folder_items (folder_id);
