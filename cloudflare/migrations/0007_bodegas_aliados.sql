-- PULSO: Maestra de Bodegas y Aliados. Base vacía, sin preasignaciones.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS master_warehouses (
 id TEXT PRIMARY KEY NOT NULL,
 centro TEXT NOT NULL COLLATE NOCASE,
 almacen TEXT NOT NULL COLLATE NOCASE,
 description TEXT NOT NULL,
 administration TEXT NOT NULL CHECK (administration IN ('PROPIA','ALIADO')),
 department TEXT NOT NULL CHECK (department IN ('CESAR','LA GUAJIRA','SAN ANDRES')),
 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
 created_by TEXT NOT NULL REFERENCES app_users(id),
 updated_by TEXT NOT NULL REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(centro,almacen)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_admin_active ON master_warehouses(administration,is_active);
CREATE TABLE IF NOT EXISTS master_warehouse_audit (
 id TEXT PRIMARY KEY NOT NULL,
 warehouse_id TEXT NOT NULL REFERENCES master_warehouses(id),
 action TEXT NOT NULL CHECK (action IN ('CREAR','EDITAR','ACTIVAR','DESACTIVAR')),
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 changed_fields TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_warehouse_audit ON master_warehouse_audit(warehouse_id,created_at);
