-- PULSO Cloudflare: esquema nuevo, sin INSERT/seed ni migración de Supabase.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS master_warehouses (
  code TEXT PRIMARY KEY NOT NULL CHECK(length(trim(code)) > 0),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS master_materials (
  sap TEXT PRIMARY KEY NOT NULL CHECK(length(trim(sap)) > 0),
  description TEXT NOT NULL CHECK(length(trim(description)) > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS master_supervisors (
  identifier TEXT PRIMARY KEY NOT NULL CHECK(length(trim(identifier)) > 0),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS master_technicians (
  identifier TEXT PRIMARY KEY NOT NULL CHECK(length(trim(identifier)) > 0),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  supervisor_identifier TEXT REFERENCES master_supervisors(identifier) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS master_equipment (
  serial TEXT PRIMARY KEY NOT NULL CHECK(length(trim(serial)) > 0),
  sap TEXT NOT NULL REFERENCES master_materials(sap) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_equipment_sap ON master_equipment(sap);

-- Reservadas para etapas posteriores; ninguna plantilla puede escribir aquí
-- hasta que se implemente y pruebe el motor de movimientos.
CREATE TABLE IF NOT EXISTS inventory_assets (
  serial TEXT PRIMARY KEY REFERENCES master_equipment(serial) ON DELETE RESTRICT,
  warehouse_code TEXT REFERENCES master_warehouses(code) ON DELETE RESTRICT,
  technician_identifier TEXT REFERENCES master_technicians(identifier) ON DELETE RESTRICT,
  stock_type TEXT NOT NULL CHECK(stock_type IN ('LIBRE','INVERSA','CONSUMIDO','ENTREGADO')),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (warehouse_code IS NULL OR technician_identifier IS NULL)
);
CREATE TABLE IF NOT EXISTS movement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE,
  serial TEXT NOT NULL REFERENCES master_equipment(serial) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  warehouse_code TEXT REFERENCES master_warehouses(code),
  technician_identifier TEXT REFERENCES master_technicians(identifier),
  ot TEXT,
  site TEXT,
  event_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);