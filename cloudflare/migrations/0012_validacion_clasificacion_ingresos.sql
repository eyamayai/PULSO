-- PULSO 0012: exige lote y estado de recepción en ingresos nuevos.
-- Registra automáticamente estado físico BUENO y disponibilidad DISPONIBLE.
-- Reinstala triggers cada despliegue, sin modificar existencias existentes.
DROP TRIGGER IF EXISTS ingress_ready_guard;
DROP TRIGGER IF EXISTS ingress_register_stock;

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

-- Solo el cambio controlado BORRADOR → REGISTRADO aplica inventario.
-- No hay una segunda operación que pueda registrar parcialmente.
CREATE TRIGGER IF NOT EXISTS ingress_register_stock
AFTER UPDATE OF status ON ingress_documents
WHEN OLD.status='BORRADOR' AND NEW.status='REGISTRADO'
BEGIN
 INSERT INTO inventory_serials(serial,sap_code,warehouse_id,ingress_id,ingress_item_id,status,lot,reception_state,physical_state)
 SELECT upper(trim(i.serial)),i.sap_code,NEW.destination_id,NEW.id,i.id,'DISPONIBLE',i.lot,i.reception_state,i.physical_state
 FROM ingress_items i JOIN master_sap_catalog s ON s.sap_code=i.sap_code
 WHERE i.ingress_id=NEW.id AND trim(i.serial)<>'';
 INSERT INTO inventory_bulk_stock(warehouse_id,sap_code,quantity)
 SELECT NEW.destination_id,i.sap_code,sum(i.quantity)
 FROM ingress_items i JOIN master_sap_catalog s ON s.sap_code=i.sap_code
 WHERE i.ingress_id=NEW.id AND s.serial_profile='SIN PERFIL DE SERIE' AND trim(i.serial)=''
 GROUP BY i.sap_code
 ON CONFLICT(warehouse_id,sap_code) DO UPDATE SET
 quantity=inventory_bulk_stock.quantity+excluded.quantity,
 updated_at=CURRENT_TIMESTAMP;
 INSERT INTO inventory_movements(id,operation,ingress_id,ingress_item_id,source_id,destination_id,sap_code,serial,quantity,actor_id)
 SELECT lower(hex(randomblob(16))),'INGRESO',NEW.id,i.id,NEW.source_id,NEW.destination_id,
 i.sap_code,upper(trim(i.serial)),i.quantity,NEW.registered_by
 FROM ingress_items i WHERE i.ingress_id=NEW.id;
END;
