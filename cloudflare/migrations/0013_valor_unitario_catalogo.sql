-- PULSO: valor unitario del catálogo SAP en centavos COP.
-- NULL: sin valorización asignada. Conserva las fichas y las existencias anteriores.
ALTER TABLE master_sap_catalog ADD COLUMN unit_value_cents INTEGER
  CHECK(unit_value_cents IS NULL OR (unit_value_cents BETWEEN 0 AND 999999999999));
