-- PULSO 0011: metadatos de lote, recepción y estado inicial para informes.
-- No se asigna una clasificación artificial a ingresos históricos: quedan sin clasificar.
ALTER TABLE ingress_items ADD COLUMN lot TEXT NOT NULL DEFAULT '' CHECK(lot IN ('','VALORADO','NOVALORADO'));
ALTER TABLE ingress_items ADD COLUMN reception_state TEXT NOT NULL DEFAULT '' CHECK(reception_state IN ('','NUEVO','REMANUFACTURADO'));
ALTER TABLE ingress_items ADD COLUMN physical_state TEXT NOT NULL DEFAULT '' CHECK(physical_state IN ('','BUENO'));
ALTER TABLE ingress_items ADD COLUMN availability_state TEXT NOT NULL DEFAULT '' CHECK(availability_state IN ('','DISPONIBLE'));
ALTER TABLE inventory_serials ADD COLUMN lot TEXT NOT NULL DEFAULT '' CHECK(lot IN ('','VALORADO','NOVALORADO'));
ALTER TABLE inventory_serials ADD COLUMN reception_state TEXT NOT NULL DEFAULT '' CHECK(reception_state IN ('','NUEVO','REMANUFACTURADO'));
ALTER TABLE inventory_serials ADD COLUMN physical_state TEXT NOT NULL DEFAULT '' CHECK(physical_state IN ('','BUENO'));
CREATE INDEX IF NOT EXISTS idx_ingress_items_classification ON ingress_items(lot,reception_state);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_classification ON inventory_serials(lot,reception_state,physical_state,status);
