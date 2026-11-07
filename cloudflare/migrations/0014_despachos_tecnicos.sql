-- PULSO 0014: despacho de equipos de bodega PROPIA a técnico activo.
-- Ningún ingreso histórico se modifica. Los seriales conservan su referencia
-- de recepción y quedan ocupados en dispatch_serial_assignments.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS dispatch_documents (
 id TEXT PRIMARY KEY NOT NULL,
 reference TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'BORRADOR' CHECK(status IN ('BORRADOR','DESPACHADO')),
 technician_id TEXT REFERENCES master_personnel(id),
 warehouse_id TEXT REFERENCES master_logistics_locations(id),
 dispatch_date TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=500),
 created_by TEXT NOT NULL REFERENCES app_users(id),
 updated_by TEXT NOT NULL REFERENCES app_users(id),
 confirmed_by TEXT REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatch_date ON dispatch_documents(status,created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_technician ON dispatch_documents(technician_id,created_at);

CREATE TABLE IF NOT EXISTS dispatch_items (
 id TEXT PRIMARY KEY NOT NULL,
 dispatch_id TEXT NOT NULL REFERENCES dispatch_documents(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 sap_code TEXT NOT NULL DEFAULT '',
 serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
 quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity BETWEEN 0 AND 1000000),
 notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=240),
 UNIQUE(dispatch_id,position),
 CHECK(length(sap_code)<=50 AND length(serial)<=100)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_items ON dispatch_items(dispatch_id,position);

-- Cada serial puede estar en poder de un único técnico a la vez.
-- Una devolución futura puede cerrar la asignación sin modificar el ingreso.
CREATE TABLE IF NOT EXISTS dispatch_serial_assignments (
 serial TEXT PRIMARY KEY NOT NULL COLLATE NOCASE REFERENCES inventory_serials(serial),
 dispatch_id TEXT NOT NULL REFERENCES dispatch_documents(id),
 dispatch_item_id TEXT NOT NULL UNIQUE REFERENCES dispatch_items(id),
 technician_id TEXT NOT NULL REFERENCES master_personnel(id),
 assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dispatch_serial_technician ON dispatch_serial_assignments(technician_id);

CREATE TABLE IF NOT EXISTS dispatch_movements (
 id TEXT PRIMARY KEY NOT NULL,
 dispatch_id TEXT NOT NULL REFERENCES dispatch_documents(id),
 dispatch_item_id TEXT NOT NULL UNIQUE REFERENCES dispatch_items(id),
 technician_id TEXT NOT NULL REFERENCES master_personnel(id),
 warehouse_id TEXT NOT NULL REFERENCES master_logistics_locations(id),
 sap_code TEXT NOT NULL REFERENCES master_sap_catalog(sap_code),
 serial TEXT NOT NULL DEFAULT '',
 quantity INTEGER NOT NULL CHECK(quantity>0),
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dispatch_movements ON dispatch_movements(technician_id,created_at);

CREATE TABLE IF NOT EXISTS dispatch_audit (
 id TEXT PRIMARY KEY NOT NULL,
 dispatch_id TEXT NOT NULL REFERENCES dispatch_documents(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 action TEXT NOT NULL CHECK(action IN ('CREAR_BORRADOR','GUARDAR_BORRADOR','DESPACHAR')),
 details TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dispatch_audit ON dispatch_audit(dispatch_id,created_at);

CREATE TRIGGER IF NOT EXISTS dispatch_document_immutable
BEFORE UPDATE ON dispatch_documents
WHEN OLD.status='DESPACHADO'
BEGIN SELECT RAISE(ABORT,'DESPACHO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS dispatch_document_delete_guard
BEFORE DELETE ON dispatch_documents
WHEN OLD.status='DESPACHADO'
BEGIN SELECT RAISE(ABORT,'DESPACHO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS dispatch_items_insert_guard
BEFORE INSERT ON dispatch_items
WHEN EXISTS(SELECT 1 FROM dispatch_documents WHERE id=NEW.dispatch_id AND status='DESPACHADO')
BEGIN SELECT RAISE(ABORT,'DESPACHO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS dispatch_items_update_guard
BEFORE UPDATE ON dispatch_items
WHEN EXISTS(SELECT 1 FROM dispatch_documents WHERE id=OLD.dispatch_id AND status='DESPACHADO')
BEGIN SELECT RAISE(ABORT,'DESPACHO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS dispatch_items_delete_guard
BEFORE DELETE ON dispatch_items
WHEN EXISTS(SELECT 1 FROM dispatch_documents WHERE id=OLD.dispatch_id AND status='DESPACHADO')
BEGIN SELECT RAISE(ABORT,'DESPACHO_INMUTABLE'); END;

-- Guardias SQL y movimiento de inventario en la MISMA transacción.
CREATE TRIGGER IF NOT EXISTS dispatch_confirm_guard
BEFORE UPDATE OF status ON dispatch_documents
WHEN OLD.status='BORRADOR' AND NEW.status='DESPACHADO'
BEGIN
 SELECT RAISE(ABORT,'FECHA_INVALIDA') WHERE NEW.dispatch_date='' OR NEW.confirmed_by IS NULL;
 SELECT RAISE(ABORT,'TECNICO_INVALIDO') WHERE NOT EXISTS(
  SELECT 1 FROM master_personnel p
  WHERE p.id=NEW.technician_id AND p.position='TECNICO' AND p.is_active=1);
 SELECT RAISE(ABORT,'BODEGA_INVALIDA') WHERE NOT EXISTS(
  SELECT 1 FROM master_logistics_locations w
  WHERE w.id=NEW.warehouse_id AND w.administration='PROPIA' AND w.is_active=1);
 SELECT RAISE(ABORT,'SIN_ITEMS') WHERE NOT EXISTS(
  SELECT 1 FROM dispatch_items i WHERE i.dispatch_id=NEW.id);
 SELECT RAISE(ABORT,'SAP_INVALIDO') WHERE EXISTS(
  SELECT 1 FROM dispatch_items i LEFT JOIN master_sap_catalog s
   ON s.sap_code=i.sap_code AND s.is_active=1
  WHERE i.dispatch_id=NEW.id AND s.id IS NULL);
 SELECT RAISE(ABORT,'CANTIDAD_INVALIDA') WHERE EXISTS(
  SELECT 1 FROM dispatch_items i WHERE i.dispatch_id=NEW.id AND
   (i.quantity<1 OR (trim(i.serial)<>'' AND i.quantity<>1)));
 SELECT RAISE(ABORT,'SERIAL_OBLIGATORIO') WHERE EXISTS(
  SELECT 1 FROM dispatch_items i JOIN master_sap_catalog s ON s.sap_code=i.sap_code
  WHERE i.dispatch_id=NEW.id AND s.serial_profile='CON PERFIL DE SERIE' AND trim(i.serial)='');
 SELECT RAISE(ABORT,'SERIAL_REPETIDO') WHERE EXISTS(
  SELECT 1 FROM dispatch_items i WHERE i.dispatch_id=NEW.id AND trim(i.serial)<>''
  GROUP BY i.serial COLLATE NOCASE HAVING COUNT(*)>1);
 SELECT RAISE(ABORT,'SERIAL_NO_DISPONIBLE') WHERE EXISTS(
  SELECT 1 FROM dispatch_items i
  LEFT JOIN inventory_serials inv ON inv.serial=i.serial COLLATE NOCASE
  LEFT JOIN dispatch_serial_assignments ass ON ass.serial=i.serial COLLATE NOCASE
  WHERE i.dispatch_id=NEW.id AND trim(i.serial)<>'' AND
   (inv.serial IS NULL OR inv.sap_code<>i.sap_code OR inv.warehouse_id<>NEW.warehouse_id
    OR inv.status<>'DISPONIBLE' OR ass.serial IS NOT NULL));
 SELECT RAISE(ABORT,'SIN_EXISTENCIAS') WHERE EXISTS(
  SELECT 1 FROM dispatch_items i
  LEFT JOIN inventory_bulk_stock b
    ON b.sap_code=i.sap_code AND b.warehouse_id=NEW.warehouse_id
  WHERE i.dispatch_id=NEW.id AND trim(i.serial)=''
  GROUP BY i.sap_code HAVING SUM(i.quantity)>COALESCE(MAX(b.quantity),0));
END;

CREATE TRIGGER IF NOT EXISTS dispatch_confirm_stock
AFTER UPDATE OF status ON dispatch_documents
WHEN OLD.status='BORRADOR' AND NEW.status='DESPACHADO'
BEGIN
 INSERT INTO dispatch_serial_assignments(serial,dispatch_id,dispatch_item_id,technician_id)
 SELECT upper(trim(i.serial)),NEW.id,i.id,NEW.technician_id FROM dispatch_items i
 WHERE i.dispatch_id=NEW.id AND trim(i.serial)<>'';
 UPDATE inventory_bulk_stock SET
  quantity=quantity-(
   SELECT COALESCE(SUM(i.quantity),0) FROM dispatch_items i
   WHERE i.dispatch_id=NEW.id AND i.sap_code=inventory_bulk_stock.sap_code AND trim(i.serial)=''
  ),updated_at=CURRENT_TIMESTAMP
 WHERE warehouse_id=NEW.warehouse_id AND sap_code IN(
  SELECT i.sap_code FROM dispatch_items i WHERE i.dispatch_id=NEW.id AND trim(i.serial)=''
 );
 INSERT INTO dispatch_movements(id,dispatch_id,dispatch_item_id,technician_id,warehouse_id,sap_code,serial,quantity,actor_id)
 SELECT lower(hex(randomblob(16))),NEW.id,i.id,NEW.technician_id,NEW.warehouse_id,
  i.sap_code,upper(trim(i.serial)),i.quantity,NEW.confirmed_by
 FROM dispatch_items i WHERE i.dispatch_id=NEW.id;
END;
