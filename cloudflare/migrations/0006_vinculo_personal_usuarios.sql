-- PULSO: relación explícita entre Personal y Usuarios, sin duplicar las fichas.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS app_personnel_user_links (
  personnel_id TEXT PRIMARY KEY NOT NULL REFERENCES master_personnel(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE RESTRICT,
  linked_by TEXT NOT NULL REFERENCES app_users(id),
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_personnel_user_links_user ON app_personnel_user_links(user_id);
