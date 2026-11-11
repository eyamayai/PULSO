-- Corrección puntual PULSO, autorizada por responsable operativo 2026-11-11.
-- Serial 4060070-VAL-0023: el SAP registrado fue 1053481, SAP real 4060070.
-- Bodega: C901 / A221. Ningún otro serial, ítem o saldo se modifica.
-- No debe correrse si el serial ya fue asignado a un técnico.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS inventory_sap_correction_log (
 correction_key TEXT PRIMARY KEY NOT NULL,
 serial TEXT NOT NULL,
 old_sap TEXT NOT NULL,
 new_sap TEXT NOT NULL,
 ingress_id TEXT NOT NULL REFERENCES ingress_documents(id),
 ingress_item_id TEXT NOT NULL REFERENCES ingress_items(id),
 warehouse_id TEXT NOT NULL REFERENCES master_logistics_locations(id),
 reason TEXT NOT NULL,
 started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at TEXT
);

-- Los controles usan CHECK=1 para abortar el archivo antes de modificar datos.
-- Repetir la migración tras completarse es seguro, incluso con despachos posteriores.
CREATE TABLE IF NOT EXISTS inventory_sap_correction_guard (
 check_key TEXT PRIMARY KEY NOT NULL,
 passed INTEGER NOT NULL CHECK(passed=1)
);
INSERT OR REPLACE INTO inventory_sap_correction_guard(check_key,passed)
SELECT 'SAP-4060070-VAL-0023-PRE',
 CASE
 WHEN EXISTS (
  SELECT 1 FROM inventory_sap_correction_log c
  JOIN inventory_serials s ON s.ingress_item_id=c.ingress_item_id
  JOIN ingress_items i ON i.id=c.ingress_item_id
  JOIN inventory_movements m ON m.ingress_item_id=c.ingress_item_id
  WHERE c.correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111'
    AND c.completed_at IS NOT NULL
    AND s.serial='4060070-VAL-0023' COLLATE NOCASE
    AND s.sap_code='4060070' AND i.sap_code='4060070' AND m.sap_code='4060070'
    AND c.old_sap='1053481' AND c.new_sap='4060070'
 ) THEN 1
 WHEN NOT EXISTS (
   SELECT 1 FROM inventory_sap_correction_log
   WHERE correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111'
 )
 AND (
  SELECT COUNT(*) FROM inventory_serials s
  JOIN ingress_items i ON i.id=s.ingress_item_id AND i.ingress_id=s.ingress_id
  JOIN ingress_documents d ON d.id=s.ingress_id
  JOIN inventory_movements m ON m.ingress_item_id=i.id AND m.ingress_id=d.id
  JOIN master_logistics_locations w ON w.id=s.warehouse_id AND w.id=d.destination_id
  JOIN master_sap_catalog sap ON sap.sap_code='4060070' AND sap.is_active=1
  LEFT JOIN dispatch_serial_assignments assigned ON assigned.serial=s.serial COLLATE NOCASE
  WHERE s.serial='4060070-VAL-0023' COLLATE NOCASE
    AND s.sap_code='1053481' AND i.sap_code='1053481' AND m.sap_code='1053481'
    AND i.serial='4060070-VAL-0023' COLLATE NOCASE
    AND m.serial='4060070-VAL-0023' COLLATE NOCASE
    AND w.centro='C901' AND w.almacen='A221'
    AND w.administration='PROPIA'
    AND d.status='REGISTRADO' AND d.document_type='SALDO_INICIAL'
    AND d.source_id=d.destination_id
    AND s.status='DISPONIBLE'
    AND i.quantity=1 AND m.quantity=1
    AND assigned.serial IS NULL
 ) = 1 THEN 1
 ELSE 0 END;


-- La auditoría registra el estado ANTERIOR, sin eliminar el ingreso original.
INSERT INTO inventory_sap_correction_log(
 correction_key,serial,old_sap,new_sap,ingress_id,ingress_item_id,warehouse_id,reason
)
SELECT 'CORRECCION-SAP-4060070-VAL-0023-20261111',
 s.serial,'1053481','4060070',s.ingress_id,i.id,s.warehouse_id,
 'SAP incorrecto en apertura de inventario; confirmado por responsable operativo el 2026-11-11'
FROM inventory_serials s
JOIN ingress_items i ON i.id=s.ingress_item_id
JOIN ingress_documents d ON d.id=s.ingress_id
JOIN master_logistics_locations w ON w.id=s.warehouse_id
JOIN inventory_movements m ON m.ingress_item_id=i.id
WHERE s.serial='4060070-VAL-0023' COLLATE NOCASE
 AND s.sap_code='1053481' AND i.sap_code='1053481' AND m.sap_code='1053481'
 AND w.centro='C901' AND w.almacen='A221'
 AND d.status='REGISTRADO' AND d.document_type='SALDO_INICIAL'
 AND NOT EXISTS (SELECT 1 FROM inventory_sap_correction_log
  WHERE correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111');

-- Suspender SOLO la restricción de edición del ítem registrado durante la
-- corrección ya validada. Reinstalarla inmediatamente, incluso en despliegues futuros.
DROP TRIGGER IF EXISTS ingress_items_registered_update;
UPDATE ingress_items SET sap_code='4060070'
WHERE sap_code='1053481'
 AND serial='4060070-VAL-0023' COLLATE NOCASE
 AND id IN (
  SELECT ingress_item_id FROM inventory_sap_correction_log
  WHERE correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111'
    AND completed_at IS NULL
 );
CREATE TRIGGER IF NOT EXISTS ingress_items_registered_update
BEFORE UPDATE ON ingress_items
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=OLD.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;

UPDATE inventory_serials SET sap_code='4060070'
WHERE sap_code='1053481'
 AND serial='4060070-VAL-0023' COLLATE NOCASE
 AND ingress_item_id IN (
  SELECT ingress_item_id FROM inventory_sap_correction_log
  WHERE correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111'
    AND completed_at IS NULL
 );
UPDATE inventory_movements SET sap_code='4060070'
WHERE sap_code='1053481'
 AND serial='4060070-VAL-0023' COLLATE NOCASE
 AND ingress_item_id IN (
  SELECT ingress_item_id FROM inventory_sap_correction_log
  WHERE correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111'
    AND completed_at IS NULL
 );

UPDATE inventory_sap_correction_log SET completed_at=CURRENT_TIMESTAMP
WHERE correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111'
 AND completed_at IS NULL
 AND EXISTS (
  SELECT 1 FROM inventory_serials s
  JOIN ingress_items i ON i.id=s.ingress_item_id
  JOIN inventory_movements m ON m.ingress_item_id=i.id
  WHERE s.serial='4060070-VAL-0023' COLLATE NOCASE
    AND s.sap_code='4060070' AND i.sap_code='4060070' AND m.sap_code='4060070'
    AND s.ingress_item_id=inventory_sap_correction_log.ingress_item_id
    AND s.warehouse_id=inventory_sap_correction_log.warehouse_id
 );

INSERT OR REPLACE INTO inventory_sap_correction_guard(check_key,passed)
SELECT 'SAP-4060070-VAL-0023-POST',CASE WHEN
 EXISTS(
  SELECT 1 FROM inventory_sap_correction_log c
  JOIN inventory_serials s ON s.ingress_item_id=c.ingress_item_id
  JOIN ingress_items i ON i.id=c.ingress_item_id
  JOIN inventory_movements m ON m.ingress_item_id=c.ingress_item_id
  JOIN master_logistics_locations w ON w.id=c.warehouse_id
  WHERE c.correction_key='CORRECCION-SAP-4060070-VAL-0023-20261111'
   AND c.completed_at IS NOT NULL
   AND c.old_sap='1053481' AND c.new_sap='4060070'
   AND s.serial='4060070-VAL-0023' COLLATE NOCASE
   AND s.sap_code='4060070' AND i.sap_code='4060070' AND m.sap_code='4060070'
   AND w.centro='C901' AND w.almacen='A221'
 ) THEN 1 ELSE 0 END;
