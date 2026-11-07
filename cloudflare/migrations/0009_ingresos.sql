-- PULSO 0009: Ingresos con borradores y contabilización atómica en D1.
-- No modifica las maestras, la tabla legada de bodegas, ni existencias antiguas.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS ingress_documents (
 id TEXT PRIMARY KEY NOT NULL,
 reference TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'BORRADOR' CHECK(status IN ('BORRADOR','REGISTRADO')),
 document_type TEXT NOT NULL DEFAULT '',
 document_number TEXT NOT NULL DEFAULT '',
 document_date TEXT NOT NULL DEFAULT '',
 received_date TEXT NOT NULL DEFAULT '',
 source_id TEXT REFERENCES master_logistics_locations(id),
 destination_id TEXT REFERENCES master_logistics_locations(id),
 notes TEXT NOT NULL DEFAULT '',
 support_filename TEXT NOT NULL DEFAULT '',
 support_size INTEGER NOT NULL DEFAULT 0,
 support_sha256 TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL REFERENCES app_users(id),
 updated_by TEXT NOT NULL REFERENCES app_users(id),
 registered_by TEXT REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 registered_at TEXT,
 CHECK(length(notes)<=500),
 CHECK(support_size>=0 AND support_size<=5242880)
);
CREATE INDEX IF NOT EXISTS idx_ingress_status ON ingress_documents(status,created_at);
CREATE INDEX IF NOT EXISTS idx_ingress_source ON ingress_documents(source_id,created_at);
CREATE INDEX IF NOT EXISTS idx_ingress_dest ON ingress_documents(destination_id,created_at);

CREATE TABLE IF NOT EXISTS ingress_items (
 id TEXT PRIMARY KEY NOT NULL,
 ingress_id TEXT NOT NULL REFERENCES ingress_documents(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 sap_code TEXT NOT NULL DEFAULT '',
 serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
 quantity INTEGER NOT NULL DEFAULT 0,
 notes TEXT NOT NULL DEFAULT '',
 UNIQUE(ingress_id,position),
 CHECK(length(sap_code)<=50 AND length(serial)<=100 AND length(notes)<=240),
 CHECK(quantity BETWEEN -1000000 AND 1000000)
);
CREATE INDEX IF NOT EXISTS idx_ingress_items_doc ON ingress_items(ingress_id,position);

-- PDF opcional almacenado en bloques binarios de hasta 128 KiB.
-- Limitar archivo a 5 MiB evita sobrecargas de D1 y preserva descarga privada.
CREATE TABLE IF NOT EXISTS ingress_support_chunks (
 ingress_id TEXT NOT NULL REFERENCES ingress_documents(id) ON DELETE CASCADE,
 chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 40),
 bytes BLOB NOT NULL,
 PRIMARY KEY(ingress_id,chunk_index)
);

CREATE TABLE IF NOT EXISTS inventory_serials (
 serial TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
 sap_code TEXT NOT NULL REFERENCES master_sap_catalog(sap_code),
 warehouse_id TEXT NOT NULL REFERENCES master_logistics_locations(id),
 ingress_id TEXT NOT NULL REFERENCES ingress_documents(id),
 ingress_item_id TEXT NOT NULL UNIQUE REFERENCES ingress_items(id),
 status TEXT NOT NULL DEFAULT 'DISPONIBLE' CHECK(status IN ('DISPONIBLE')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_serial_warehouse ON inventory_serials(warehouse_id,sap_code);

CREATE TABLE IF NOT EXISTS inventory_bulk_stock (
 warehouse_id TEXT NOT NULL REFERENCES master_logistics_locations(id),
 sap_code TEXT NOT NULL REFERENCES master_sap_catalog(sap_code),
 quantity INTEGER NOT NULL CHECK(quantity>=0),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(warehouse_id,sap_code)
);
CREATE TABLE IF NOT EXISTS inventory_movements (
 id TEXT PRIMARY KEY NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('INGRESO')),
 ingress_id TEXT NOT NULL REFERENCES ingress_documents(id),
 ingress_item_id TEXT NOT NULL UNIQUE REFERENCES ingress_items(id),
 source_id TEXT NOT NULL REFERENCES master_logistics_locations(id),
 destination_id TEXT NOT NULL REFERENCES master_logistics_locations(id),
 sap_code TEXT NOT NULL REFERENCES master_sap_catalog(sap_code),
 serial TEXT NOT NULL DEFAULT '',
 quantity INTEGER NOT NULL CHECK(quantity>0),
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements ON inventory_movements(ingress_id,created_at);

CREATE TABLE IF NOT EXISTS ingress_audit (
 id TEXT PRIMARY KEY NOT NULL,
 ingress_id TEXT NOT NULL REFERENCES ingress_documents(id),
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 action TEXT NOT NULL CHECK(action IN ('CREAR_BORRADOR','GUARDAR_BORRADOR','ADJUNTAR_PDF','QUITAR_PDF','REGISTRAR')),
 details TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ingress_audit ON ingress_audit(ingress_id,created_at);

CREATE TRIGGER IF NOT EXISTS ingress_registered_immutable
BEFORE UPDATE ON ingress_documents
WHEN OLD.status='REGISTRADO'
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS ingress_items_registered_insert
BEFORE INSERT ON ingress_items
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=NEW.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS ingress_items_registered_update
BEFORE UPDATE ON ingress_items
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=OLD.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS ingress_items_registered_delete
BEFORE DELETE ON ingress_items
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=OLD.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS ingress_support_registered_insert
BEFORE INSERT ON ingress_support_chunks
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=NEW.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS ingress_support_registered_delete
BEFORE DELETE ON ingress_support_chunks
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=OLD.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;

-- Última barrera en el motor SQL: verificación dentro de la misma transacción
-- que aplica las existencias. Evita desactivar maestros o duplicar seriales a la vez.
CREATE TRIGGER IF NOT EXISTS ingress_ready_guard
BEFORE UPDATE OF status ON ingress_documents
WHEN OLD.status='BORRADOR' AND NEW.status='REGISTRADO'
BEGIN
 SELECT RAISE(ABORT,'DOCUMENTO_INCOMPLETO')
 WHERE NEW.document_type NOT IN ('ORDEN_COMPRA','FACTURA','REMISION','ACTA_ENTREGA','OTRO')
 OR trim(NEW.document_number)='' OR NEW.document_date='' OR NEW.received_date='';
 SELECT RAISE(ABORT,'ORIGEN_ALIADO_INVALIDO')
 WHERE NOT EXISTS(SELECT 1 FROM master_logistics_locations w
 WHERE w.id=NEW.source_id AND w.administration='ALIADO' AND w.is_active=1);
 SELECT RAISE(ABORT,'DESTINO_PROPIO_INVALIDO')
 WHERE NOT EXISTS(SELECT 1 FROM master_logistics_locations w
 WHERE w.id=NEW.destination_id AND w.administration='PROPIA' AND w.is_active=1);
 SELECT RAISE(ABORT,'SIN_ITEMS')
 WHERE NOT EXISTS(SELECT 1 FROM ingress_items i WHERE i.ingress_id=NEW.id);
 SELECT RAISE(ABORT,'SAP_INVALIDO')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 LEFT JOIN master_sap_catalog s ON s.sap_code=i.sap_code AND s.is_active=1
 WHERE i.ingress_id=NEW.id AND s.id IS NULL);
 SELECT RAISE(ABORT,'CANTIDAD_INVALIDA')
 WHERE EXISTS(SELECT 1 FROM ingress_items i WHERE i.ingress_id=NEW.id AND i.quantity<=0);
 SELECT RAISE(ABORT,'SERIAL_OBLIGATORIO')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 JOIN master_sap_catalog s ON s.sap_code=i.sap_code
 WHERE i.ingress_id=NEW.id AND s.serial_profile='CON PERFIL DE SERIE'
 AND (trim(i.serial)='' OR i.quantity<>1));
 SELECT RAISE(ABORT,'SERIAL_NO_PERMITIDO')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 JOIN master_sap_catalog s ON s.sap_code=i.sap_code
 WHERE i.ingress_id=NEW.id AND s.serial_profile='SIN PERFIL DE SERIE'
 AND trim(i.serial)<>'');
 SELECT RAISE(ABORT,'SERIAL_DUPLICADO_DOCUMENTO')
 WHERE EXISTS (SELECT 1 FROM ingress_items i
 WHERE i.ingress_id=NEW.id AND trim(i.serial)<>'' GROUP BY i.serial COLLATE NOCASE HAVING count(*)>1);
 SELECT RAISE(ABORT,'SERIAL_YA_EXISTE')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 JOIN inventory_serials stock ON stock.serial=i.serial COLLATE NOCASE
 WHERE i.ingress_id=NEW.id AND trim(i.serial)<>'');
END;

-- Solo el cambio controlado BORRADOR → REGISTRADO aplica inventario.
-- No hay una segunda operación que pueda registrar parcialmente.
CREATE TRIGGER IF NOT EXISTS ingress_register_stock
AFTER UPDATE OF status ON ingress_documents
WHEN OLD.status='BORRADOR' AND NEW.status='REGISTRADO'
BEGIN
 INSERT INTO inventory_serials(serial,sap_code,warehouse_id,ingress_id,ingress_item_id)
 SELECT upper(trim(i.serial)),i.sap_code,NEW.destination_id,NEW.id,i.id
 FROM ingress_items i JOIN master_sap_catalog s ON s.sap_code=i.sap_code
 WHERE i.ingress_id=NEW.id AND s.serial_profile='CON PERFIL DE SERIE';
 INSERT INTO inventory_bulk_stock(warehouse_id,sap_code,quantity)
 SELECT NEW.destination_id,i.sap_code,sum(i.quantity)
 FROM ingress_items i JOIN master_sap_catalog s ON s.sap_code=i.sap_code
 WHERE i.ingress_id=NEW.id AND s.serial_profile='SIN PERFIL DE SERIE'
 GROUP BY i.sap_code
 ON CONFLICT(warehouse_id,sap_code) DO UPDATE SET
 quantity=inventory_bulk_stock.quantity+excluded.quantity,
 updated_at=CURRENT_TIMESTAMP;
 INSERT INTO inventory_movements(id,operation,ingress_id,ingress_item_id,source_id,destination_id,sap_code,serial,quantity,actor_id)
 SELECT lower(hex(randomblob(16))),'INGRESO',NEW.id,i.id,NEW.source_id,NEW.destination_id,
 i.sap_code,upper(trim(i.serial)),i.quantity,NEW.registered_by
 FROM ingress_items i WHERE i.ingress_id=NEW.id;
END;
