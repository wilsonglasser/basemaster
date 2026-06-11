-- Saved data-transfer presets. Global (not bound to a connection) since a
-- transfer spans two connections; the full config (endpoints + schema jobs +
-- options) is serialized as JSON in `config`.
CREATE TABLE saved_transfers (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    config     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
