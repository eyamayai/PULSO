-- PULSO 0008: aliados en cualquier departamento de Colombia y Bogotá D.C.
-- Conserva todas las bodegas, sus claves, estados, usuarios, fechas y auditorías.
-- La tabla heredada master_warehouses permanece intacta.
PRAGMA foreign_keys=ON;
CREATE TABLE master_logistics_locations_expanded (
 id TEXT PRIMARY KEY NOT NULL,
 centro TEXT NOT NULL COLLATE NOCASE,
 almacen TEXT NOT NULL COLLATE NOCASE,
 description TEXT NOT NULL,
 administration TEXT NOT NULL CHECK(administration IN ('PROPIA','ALIADO')),
 department TEXT NOT NULL CHECK (
   (administration='PROPIA' AND department IN ('CESAR','LA GUAJIRA','SAN ANDRES'))
   OR (administration='ALIADO' AND department IN ('AMAZONAS','ANTIOQUIA','ARAUCA','ATLANTICO','BOLIVAR','BOYACA','CALDAS','CAQUETA','CASANARE','CAUCA','CESAR','CHOCO','CORDOBA','CUNDINAMARCA','GUAINIA','GUAVIARE','HUILA','LA GUAJIRA','MAGDALENA','META','NARINO','NORTE DE SANTANDER','PUTUMAYO','QUINDIO','RISARALDA','SAN ANDRES','SANTANDER','SUCRE','TOLIMA','VALLE DEL CAUCA','VAUPES','VICHADA','BOGOTA D.C.'))
 ),
 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
 created_by TEXT NOT NULL REFERENCES app_users(id),
 updated_by TEXT NOT NULL REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(centro,almacen)
);
INSERT INTO master_logistics_locations_expanded
 (id,centro,almacen,description,administration,department,is_active,created_by,updated_by,created_at,updated_at)
 SELECT id,centro,almacen,description,administration,department,is_active,created_by,updated_by,created_at,updated_at
 FROM master_logistics_locations;
CREATE TABLE master_warehouse_audit_expanded (
 id TEXT PRIMARY KEY NOT NULL,
 warehouse_id TEXT NOT NULL REFERENCES master_logistics_locations_expanded(id),
 action TEXT NOT NULL CHECK(action IN ('CREAR','EDITAR','ACTIVAR','DESACTIVAR')),
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 changed_fields TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO master_warehouse_audit_expanded
 (id,warehouse_id,action,actor_id,changed_fields,created_at)
 SELECT id,warehouse_id,action,actor_id,changed_fields,created_at
 FROM master_warehouse_audit;
DROP TABLE master_warehouse_audit;
DROP TABLE master_logistics_locations;
ALTER TABLE master_logistics_locations_expanded RENAME TO master_logistics_locations;
ALTER TABLE master_warehouse_audit_expanded RENAME TO master_warehouse_audit;
CREATE INDEX idx_warehouse_admin_active ON master_logistics_locations(administration,is_active);
CREATE INDEX idx_warehouse_audit ON master_warehouse_audit(warehouse_id,created_at);
PRAGMA foreign_key_check;
