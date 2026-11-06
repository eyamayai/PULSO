# Usuarios y Permisos · PULSO

## Alcance
Tercera pestaña de **Maestras**. Permite que un administrador gestione cuentas de acceso sin crear registros ficticios en la maestra de **Personal**. La identificación de la cuenta se almacena en `app_user_details` y el cargo laboral es libre: por ejemplo, «Auxiliar de operaciones» con perfil de acceso «Administrador».

Los perfiles de autenticación disponibles inicialmente son **Administrador, Supervisor, Técnico y Auditor/Consulta**. Estas etiquetas todavía no conceden operaciones sobre módulos pendientes de implementar. El acceso a Maestras y a la gestión de usuarios permanece exclusivo de **Administrador**. Cuando se desarrollen los módulos, cada operación necesitará permisos explícitos en el servidor. «Bodega» se definirá cuando diseñemos las funciones de bodega y su matriz de permisos; no se reutiliza otro rol para fingir ese perfil.

## Crear un usuario
En **Maestras → Usuarios y permisos → Nuevo usuario**, introducir identificación, nombre, correo, perfil, cargo laboral y teléfono opcional. El correo y la identificación deben ser únicos. La cuenta se crea **pendiente** y sin contraseña ni sesión.

El administrador recibe una única vez un enlace de activación que puede **copiar** y entregar por un canal privado al destinatario. El sistema no envía correos automáticamente. El enlace contiene un token aleatorio de 256 bits **en el fragmento # de la URL**, de forma que no viaja en la petición GET. En D1 se almacena solo el hash SHA-256 del token. Dura 48 horas, se consume una sola vez y un nuevo enlace invalida los anteriores.

El destinatario abre `/activar`, escribe el correo autorizado y define su propia contraseña, con las mismas reglas de fortaleza que PULSO. La clave se conserva únicamente como PBKDF2-SHA512 con sal aleatoria y 100.000 iteraciones compatibles con Cloudflare Workers. Después inicia sesión desde `/main`.

## Gestión
Un administrador puede actualizar el cargo, nombre, teléfono, identificación, perfil o estado de otra cuenta. El correo no cambia en esta fase. Las modificaciones de perfil y de estado revocan las sesiones previas. La cuenta propia no permite cambiarse el perfil o desactivarse a sí misma. Un trigger SQL impide que quede la base sin administrador activo. Las cuentas aún sin contraseña no pueden habilitarse mediante edición manual: deben aceptar primero su invitación.

El restablecimiento de contraseña crea otro enlace temporal de un solo uso, sin mostrar ni conocer la contraseña anterior. Se invalidan las sesiones existentes al aceptar el restablecimiento. Las acciones de creación, edición, invitación, activación, cambio de estado y restablecimiento quedan registradas en `app_user_audit`, sin almacenar contraseñas o tokens.

## Componentes
- `cloudflare/migrations/0005_usuarios_permisos.sql`: detalles de cuenta, invitaciones, auditoría y guardas del último administrador.
- `pages/auth-worker.mjs`: endpoints `GET/POST/PATCH /api/usuarios`, `POST /api/usuarios/invitaciones` y `POST /api/auth/activar`.
- `pages/usuarios.js`: interfaz de gestión y enlace de invitación.
- `pages/activar.html`, `activar.js`, `activar.css`: establecimiento de contraseña.
- `test/auth.test.mjs`: pruebas de acceso, invitaciones, revocación, duplicados y protección de la última cuenta administradora.

Esta versión no modifica las maestras de técnicos, supervisores, SAP o bodegas, no importa datos y no habilita operaciones de inventario.
