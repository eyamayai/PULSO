-- Hashes de acceso compatibles con la limitación nativa WebCrypto de Cloudflare (100.000 iteraciones).
-- No modifica tablas de inventario ni cuentas ya existentes.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS auth_passwords (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL CHECK(length(password_hash)=64),
  password_salt TEXT NOT NULL CHECK(length(password_salt)=32),
  password_kdf TEXT NOT NULL CHECK(password_kdf='pbkdf2-sha512-100000'),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
