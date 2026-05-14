-- Key/value store para preferências não-secretas do app (autostart do
-- MCP, última porta usada, etc). Segredos continuam no keyring — aqui
-- só entra config sem valor sensível.
CREATE TABLE IF NOT EXISTS app_settings (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);
