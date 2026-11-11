-- PULSO 0017. Habilita apertura única de saldos sin alterar Maestras.
-- La ruta de apertura es independiente y requiere ADMIN.
-- Importante: volver a aplicar DESPUÉS de 0012 en cada despliegue.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS opening_stock_once (
 key TEXT PRIMARY KEY NOT NULL CHECK(key='APERTURA-2026-11-11'),
 operation_id TEXT NOT NULL UNIQUE,
 content_sha TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES app_users(id),
 document_count INTEGER NOT NULL CHECK(document_count BETWEEN 1 AND 150),
 item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 2500),
 total_units INTEGER NOT NULL CHECK(total_units>0),
 completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS opening_stock_documents (
 key TEXT NOT NULL REFERENCES opening_stock_once(key),
 ingress_id TEXT NOT NULL UNIQUE REFERENCES ingress_documents(id),
 PRIMARY KEY(key,ingress_id)
);
-- Reinstalar el guard de Ingresos: conservar validaciones normales y permitir
-- un documento especial de apertura con origen=destino (bodega propia).
DROP TRIGGER IF EXISTS ingress_ready_guard;
CREATE TRIGGER IF NOT EXISTS ingress_ready_guard
BEFORE UPDATE OF status ON ingress_documents
WHEN OLD.status='BORRADOR' AND NEW.status='REGISTRADO'
BEGIN
 SELECT RAISE(ABORT,'DOCUMENTO_INCOMPLETO')
 WHERE NEW.document_type NOT IN ('NUMERO_PEDIDO','SALDO_INICIAL')
 OR trim(NEW.document_number)='' OR NEW.document_date='' OR NEW.received_date='';
 SELECT RAISE(ABORT,'ORIGEN_ALIADO_INVALIDO')
 WHERE NOT EXISTS(SELECT 1 FROM master_logistics_locations w
 WHERE w.id=NEW.source_id AND w.is_active=1 AND (
 (NEW.document_type='NUMERO_PEDIDO' AND w.administration='ALIADO')
 OR (NEW.document_type='SALDO_INICIAL' AND w.administration='PROPIA' AND NEW.source_id=NEW.destination_id)
 ));
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
 AND (trim(i.serial)='' OR upper(trim(i.serial)) IN ('SIN PERFIL DE SERIE','N/A','NA','SIN SERIAL') OR i.quantity<>1));
 SELECT RAISE(ABORT,'CANTIDAD_SERIAL')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 WHERE i.ingress_id=NEW.id AND trim(i.serial)<>'' AND i.quantity<>1);
 SELECT RAISE(ABORT,'LOTE_INVALIDO')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 WHERE i.ingress_id=NEW.id AND i.lot NOT IN ('VALORADO','NOVALORADO'));
 SELECT RAISE(ABORT,'ESTADO_RECEPCION_INVALIDO')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 WHERE i.ingress_id=NEW.id AND i.reception_state NOT IN ('NUEVO','REMANUFACTURADO'));
 SELECT RAISE(ABORT,'ESTADO_FISICO_INVALIDO')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 WHERE i.ingress_id=NEW.id AND i.physical_state<>'BUENO');
 SELECT RAISE(ABORT,'DISPONIBILIDAD_INVALIDA')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 WHERE i.ingress_id=NEW.id AND i.availability_state<>'DISPONIBLE');
 SELECT RAISE(ABORT,'SERIAL_DUPLICADO_DOCUMENTO')
 WHERE EXISTS (SELECT 1 FROM ingress_items i
 WHERE i.ingress_id=NEW.id AND trim(i.serial)<>'' GROUP BY i.serial COLLATE NOCASE HAVING count(*)>1);
 SELECT RAISE(ABORT,'SERIAL_YA_EXISTE')
 WHERE EXISTS(SELECT 1 FROM ingress_items i
 JOIN inventory_serials stock ON stock.serial=i.serial COLLATE NOCASE
 WHERE i.ingress_id=NEW.id AND trim(i.serial)<>'');
END;

