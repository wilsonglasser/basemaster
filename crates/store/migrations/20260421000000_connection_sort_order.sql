-- Sort order global das conexões. Default NULL deixa a UI cair no
-- fallback alfabético (ordem pré-existente). Ao dragar, a UI preenche
-- valores sequenciais.
ALTER TABLE connection_profiles ADD COLUMN sort_order INTEGER;
CREATE INDEX IF NOT EXISTS idx_connections_sort ON connection_profiles (sort_order);
