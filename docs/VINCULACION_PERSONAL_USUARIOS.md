# PULSO: vincular Personal con Usuarios y permisos

## Funcionamiento
La ficha **Personal** sigue siendo la única fuente operativa de técnicos y supervisores. Las cuentas en `app_users` son independientes, pero quedan relacionadas mediante la tabla `app_personnel_user_links` (índices únicos por persona y por cuenta). No se duplican fichas de Personal.

Un administrador puede activar el panel **Acceso a PULSO** en la ficha de una persona guardada o seleccionar varias en la tabla, incluyendo **Seleccionar todos los visibles**, y pulsar **Habilitar accesos**. Por defecto, el perfil de acceso se propone según el cargo, pero se puede cambiar explícitamente a Administrador, Supervisor, Técnico o Auditor. Crear una cuenta no cambia el cargo en Personal.

Para crear una cuenta vinculada se exige: ficha activa, correo válido, identificación válida y ninguna cuenta o vínculo existente con ese correo/documento. Si hay cualquier error, la operación completa se rechaza; no hay inserciones parciales ni reutilización silenciosa de cuentas. El administrador debe revisar manualmente las cuentas previamente creadas con identidades coincidentes.

Al validar, no se escribe nada. Al confirmar, PULSO crea registros pendientes (`active=0`) y genera una invitación personal de un solo uso, válida durante 48 horas, para que el colaborador defina su propia contraseña. Los enlaces aparecen **una sola vez** y pueden copiarse individualmente o exportarse explícitamente a un CSV privado. No se envían correos automáticamente. Ese CSV contiene enlaces sensibles y debe distribuirse de forma segura y eliminarse una vez utilizado.

La API `POST /api/usuarios/vincular-personal` acepta `mode: "validate" | "commit"` y `assignments: [{personnel_id, role}]`. Máximo 80 personas por solicitud. Requiere una sesión ADMIN y verificación de origen. La validación se repite al confirmar. Se crea la cuenta, la ficha de detalles, el enlace a Personal, la invitación y las entradas de auditoría en **una sola transacción D1**; las restricciones UNIQUE impiden duplicados bajo concurrencia.

La pestaña **Usuarios y permisos** incluye las cuentas creadas desde Personal. Sus permisos dependen del rol de autenticación, no del cargo operativo. La maestra SAP, bodegas, inventarios y movimientos no cambian.

## Archivos
- `cloudflare/migrations/0006_vinculo_personal_usuarios.sql`
- `pages/auth-worker.mjs`: API de vinculación
- `pages/maestras.html`, `pages/maestras.js`, `pages/maestras.css`, `pages/personal-access.js`
- `test/auth.test.mjs`: pruebas de selección individual y de 46 colaboradores, control de duplicados, inactividad, autenticación y atomicidad
