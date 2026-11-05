-- PULSO · Maestras iniciales: Personal y Catálogo SAP.
-- No importa datos desde Excel, ni reconoce bodegas o códigos no alimentados.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS master_personnel (
  id TEXT PRIMARY KEY NOT NULL,
  document_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  position TEXT NOT NULL CHECK(position IN ('SUPERVISOR','TECNICO')),
  department TEXT NOT NULL CHECK(department IN ('CESAR','LA GUAJIRA','SAN ANDRES')),
  zone TEXT NOT NULL DEFAULT '',
  city_base TEXT NOT NULL DEFAULT '',
  supervisor_id TEXT REFERENCES master_personnel(id) ON DELETE RESTRICT,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  updated_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((position='SUPERVISOR' AND length(trim(zone)) > 0 AND supervisor_id IS NULL)
     OR (position='TECNICO' AND length(trim(city_base)) > 0 AND supervisor_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_master_personnel_supervisor ON master_personnel(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_master_personnel_position ON master_personnel(position, is_active);

CREATE TABLE IF NOT EXISTS master_sap_catalog (
  id TEXT PRIMARY KEY NOT NULL,
  sap_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK(item_type IN ('EQUIPO','MATERIAL')),
  serial_profile TEXT NOT NULL CHECK(serial_profile IN ('CON PERFIL DE SERIE','SIN PERFIL DE SERIE')),
  unit TEXT NOT NULL DEFAULT 'UND',
  family TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  updated_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_master_sap_type ON master_sap_catalog(item_type, is_active);

CREATE TABLE IF NOT EXISTS master_audit (
  id TEXT PRIMARY KEY NOT NULL,
  entity TEXT NOT NULL CHECK(entity IN ('PERSONAL','CATALOGO_SAP')),
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('CREAR','EDITAR','ACTIVAR','DESACTIVAR')),
  actor_id TEXT NOT NULL REFERENCES app_users(id),
  changed_fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_master_audit_entity ON master_audit(entity,record_id,created_at);
