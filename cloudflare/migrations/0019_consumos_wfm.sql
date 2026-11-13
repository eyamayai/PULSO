-- PULSO 0019 · Consumos WFM de Claro, ligados a equipos previamente despachados.
-- No cambia existencias de bodega: se descontaron cuando se confirmó Despachos.
-- Una confirmación completa es transaccional y no modifica Maestras ni Ingresos.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS consumption_batches (
 id TEXT PRIMARY KEY NOT NULL,
 operation_id TEXT NOT NULL UNIQUE,
 content_sha TEXT NOT NULL,
 source_filename TEXT NOT NULL DEFAULT '',
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS consumption_items (
 id TEXT PRIMARY KEY NOT NULL,
 batch_id TEXT NOT NULL REFERENCES consumption_batches(id),
 dispatch_item_id TEXT NOT NULL REFERENCES dispatch_items(id),
 technician_id TEXT NOT NULL REFERENCES master_personnel(id),
 sap_code TEXT NOT NULL REFERENCES master_sap_catalog(sap_code),
 ot TEXT NOT NULL CHECK(length(ot) BETWEEN 4 AND 40),
 wfm_id TEXT NOT NULL CHECK(length(wfm_id) BETWEEN 1 AND 40),
 centro TEXT NOT NULL,
 almacen TEXT NOT NULL,
 consumo_fecha TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),
 reported_serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
 internal_serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
 source_key TEXT NOT NULL UNIQUE,
 lot TEXT NOT NULL DEFAULT '',
 source_row INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consumption_technician ON consumption_items(technician_id,created_at);
CREATE INDEX IF NOT EXISTS idx_consumption_dispatch_item ON consumption_items(dispatch_item_id);
CREATE INDEX IF NOT EXISTS idx_consumption_ot ON consumption_items(ot);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consumption_serial_once ON consumption_items(internal_serial COLLATE NOCASE)
 WHERE trim(internal_serial)<>'';

CREATE TRIGGER IF NOT EXISTS consumption_validated_insert BEFORE INSERT ON consumption_items
BEGIN
 -- El equipo debe estar bajo responsabilidad del técnico y provenir de la bodega indicada.
 SELECT RAISE(ABORT,'CONSUMO_SIN_DESPACHO')
 WHERE NOT EXISTS(
  SELECT 1 FROM dispatch_movements m
  JOIN dispatch_documents d ON d.id=m.dispatch_id AND d.status='DESPACHADO'
  JOIN master_logistics_locations w ON w.id=m.warehouse_id
  WHERE m.dispatch_item_id=NEW.dispatch_item_id
   AND m.technician_id=NEW.technician_id
   AND m.sap_code=NEW.sap_code
   AND upper(w.centro)=upper(NEW.centro)
   AND upper(w.almacen)=upper(NEW.almacen)
   AND (trim(m.serial)=trim(NEW.internal_serial) COLLATE NOCASE)
 );
 SELECT RAISE(ABORT,'CONSUMO_SERIAL_NO_ASIGNADO')
 WHERE trim(NEW.internal_serial)<>'' AND NOT EXISTS(
  SELECT 1 FROM dispatch_serial_assignments a
  WHERE a.dispatch_item_id=NEW.dispatch_item_id AND a.technician_id=NEW.technician_id
   AND a.serial=NEW.internal_serial COLLATE NOCASE
 );
 SELECT RAISE(ABORT,'CONSUMO_CANTIDAD_EXCEDIDA')
 WHERE (
  SELECT m.quantity FROM dispatch_movements m WHERE m.dispatch_item_id=NEW.dispatch_item_id
 ) < NEW.quantity + COALESCE((
  SELECT SUM(c.quantity) FROM consumption_items c WHERE c.dispatch_item_id=NEW.dispatch_item_id
 ),0);
 SELECT RAISE(ABORT,'CONSUMO_SERIAL_CANTIDAD')
 WHERE trim(NEW.internal_serial)<>'' AND NEW.quantity<>1;
END;
