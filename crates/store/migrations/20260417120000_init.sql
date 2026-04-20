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
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_used_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_connection_profiles_name
    ON connection_profiles(name);
