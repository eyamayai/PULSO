-- PULSO 0005: cuentas administradas e invitaciones de uso único.
-- Añade tablas; NO modifica personal, catálogo SAP, bodegas ni inventarios.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS app_user_details (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  document_number TEXT UNIQUE COLLATE NOCASE,
  job_title TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_user_invitations (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('ACTIVAR','RESTABLECER')),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_invites_user ON app_user_invitations(user_id, expires_at);
CREATE TABLE IF NOT EXISTS app_user_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  actor_id TEXT NOT NULL REFERENCES app_users(id),
  action TEXT NOT NULL CHECK(action IN ('CREAR','EDITAR','ACTIVAR','DESACTIVAR','INVITAR','RESTABLECER','ACEPTAR_INVITACION')),
  changed_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_audit_time ON app_user_audit(user_id, created_at);

-- Protección de la última cuenta administrativa activa, también ante operaciones concurrentes.
CREATE TRIGGER IF NOT EXISTS guard_last_admin_update
BEFORE UPDATE OF role, active ON app_users
WHEN OLD.role='ADMIN' AND OLD.active=1
 AND (NEW.role!='ADMIN' OR NEW.active!=1)
 AND (SELECT COUNT(*) FROM app_users WHERE role='ADMIN' AND active=1)<=1
BEGIN SELECT RAISE(ABORT,'ULTIMO_ADMINISTRADOR'); END;
CREATE TRIGGER IF NOT EXISTS guard_last_admin_delete
BEFORE DELETE ON app_users
WHEN OLD.role='ADMIN' AND OLD.active=1
 AND (SELECT COUNT(*) FROM app_users WHERE role='ADMIN' AND active=1)<=1
BEGIN SELECT RAISE(ABORT,'ULTIMO_ADMINISTRADOR'); END;
