-- PULSO | Reinicio solicitado el 2026-11-11.
-- Solo datos operativos de Ingresos, Despachos e inventario generado por ellos.
-- No toca master_*, app_users, usuarios, permisos ni configuraciones.
-- El identificador y completed_at impiden borrar datos NUEVOS en futuros despliegues.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS pulso_operational_reset_events (
 reset_key TEXT PRIMARY KEY NOT NULL,
 started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at TEXT,
 master_personnel_before INTEGER NOT NULL,
 master_sap_catalog_before INTEGER NOT NULL,
 master_locations_before INTEGER NOT NULL,
 app_users_before INTEGER NOT NULL,
 master_personnel_after INTEGER,
 master_sap_catalog_after INTEGER,
 master_locations_after INTEGER,
 app_users_after INTEGER
);
INSERT OR IGNORE INTO pulso_operational_reset_events(
 reset_key,master_personnel_before,master_sap_catalog_before,
 master_locations_before,app_users_before
) SELECT 'REINICIO-INGRESOS-DESPACHOS-2026-11-11',
 (SELECT COUNT(*) FROM master_personnel),
 (SELECT COUNT(*) FROM master_sap_catalog),
 (SELECT COUNT(*) FROM master_logistics_locations),
 (SELECT COUNT(*) FROM app_users);

-- Se suspenden únicamente las barreras contra borrar movimientos confirmados
-- mientras se retiran de forma ordenada sus tablas dependientes.
DROP TRIGGER IF EXISTS dispatch_document_delete_guard;
DROP TRIGGER IF EXISTS dispatch_items_delete_guard;
DROP TRIGGER IF EXISTS ingress_items_registered_delete;
DROP TRIGGER IF EXISTS ingress_support_registered_delete;

-- Primero Despachos: lotes, asignaciones y movimientos.
DELETE FROM dispatch_mass_batch_documents WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM dispatch_mass_batches WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM dispatch_movements WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM dispatch_serial_assignments WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM dispatch_audit WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM dispatch_items WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM dispatch_documents WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);

-- Luego existencias e historial de Ingresos: el inventario nace de Ingresos.
DELETE FROM inventory_movements WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM inventory_serials WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM inventory_bulk_stock WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM ingress_audit WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM ingress_support_chunks WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM ingress_items WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);
DELETE FROM ingress_documents WHERE EXISTS(
 SELECT 1 FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL
);

-- No se marca completado si quedó cualquier dato operativo.
-- Esta tabla no contiene registros de usuario ni seriales.
CREATE TABLE IF NOT EXISTS pulso_operational_reset_checks (
 reset_key TEXT PRIMARY KEY NOT NULL,
 checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 operational_rows_remaining INTEGER NOT NULL
);
INSERT OR REPLACE INTO pulso_operational_reset_checks(reset_key,operational_rows_remaining)
SELECT 'REINICIO-INGRESOS-DESPACHOS-2026-11-11',
 (SELECT COUNT(*) FROM dispatch_mass_batch_documents)
 +(SELECT COUNT(*) FROM dispatch_mass_batches)
 +(SELECT COUNT(*) FROM dispatch_movements)
 +(SELECT COUNT(*) FROM dispatch_serial_assignments)
 +(SELECT COUNT(*) FROM dispatch_audit)
 +(SELECT COUNT(*) FROM dispatch_items)
 +(SELECT COUNT(*) FROM dispatch_documents)
 +(SELECT COUNT(*) FROM inventory_movements)
 +(SELECT COUNT(*) FROM inventory_serials)
 +(SELECT COUNT(*) FROM inventory_bulk_stock)
 +(SELECT COUNT(*) FROM ingress_audit)
 +(SELECT COUNT(*) FROM ingress_support_chunks)
 +(SELECT COUNT(*) FROM ingress_items)
 +(SELECT COUNT(*) FROM ingress_documents)
WHERE EXISTS(SELECT 1 FROM pulso_operational_reset_events
 WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11' AND completed_at IS NULL);

UPDATE pulso_operational_reset_events SET
 completed_at=CURRENT_TIMESTAMP,
 master_personnel_after=(SELECT COUNT(*) FROM master_personnel),
 master_sap_catalog_after=(SELECT COUNT(*) FROM master_sap_catalog),
 master_locations_after=(SELECT COUNT(*) FROM master_logistics_locations),
 app_users_after=(SELECT COUNT(*) FROM app_users)
WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11'
 AND completed_at IS NULL
 AND (SELECT operational_rows_remaining FROM pulso_operational_reset_checks
  WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11')=0
 AND master_personnel_before=(SELECT COUNT(*) FROM master_personnel)
 AND master_sap_catalog_before=(SELECT COUNT(*) FROM master_sap_catalog)
 AND master_locations_before=(SELECT COUNT(*) FROM master_logistics_locations)
 AND app_users_before=(SELECT COUNT(*) FROM app_users);

-- Restablecer los cuatro triggers de protección del esquema original.
CREATE TRIGGER IF NOT EXISTS dispatch_document_delete_guard
BEFORE DELETE ON dispatch_documents
WHEN OLD.status='DESPACHADO'
BEGIN SELECT RAISE(ABORT,'DESPACHO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS dispatch_items_delete_guard
BEFORE DELETE ON dispatch_items
WHEN EXISTS(SELECT 1 FROM dispatch_documents WHERE id=OLD.dispatch_id AND status='DESPACHADO')
BEGIN SELECT RAISE(ABORT,'DESPACHO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS ingress_items_registered_delete
BEFORE DELETE ON ingress_items
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=OLD.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS ingress_support_registered_delete
BEFORE DELETE ON ingress_support_chunks
WHEN EXISTS (SELECT 1 FROM ingress_documents d WHERE d.id=OLD.ingress_id AND d.status='REGISTRADO')
BEGIN SELECT RAISE(ABORT,'INGRESO_INMUTABLE'); END;
