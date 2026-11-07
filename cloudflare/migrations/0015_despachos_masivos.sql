-- PULSO 0015: registro idempotente de confirmaciones masivas de despachos.
-- Cada lote se confirma como una sola transacción D1 o no se modifica inventario.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS dispatch_mass_batches (
 id TEXT PRIMARY KEY NOT NULL,
 content_sha TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS dispatch_mass_batch_documents (
 batch_id TEXT NOT NULL REFERENCES dispatch_mass_batches(id),
 dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatch_documents(id),
 PRIMARY KEY(batch_id,dispatch_id)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_mass_documents_batch ON dispatch_mass_batch_documents(batch_id);
