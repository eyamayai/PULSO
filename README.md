# PULSO 1.0 · Operación Logística MinTIC
Aplicación web responsive con autenticación Supabase, control de acceso por perfil y custodia de inventario por serial.

## Puesta en marcha
- Frontend: `index.html` servido por GitHub Pages.
- Backend: proyecto Supabase exclusivo de PULSO (`qdzkpwhtxabyqpxmqrcg`), migración en `sql/schema.sql`.
- Roles: ADMIN, ASISTENTE, SUPERVISOR por departamento y TECNICO con ubicación individual.
- Bodegas iniciales: Riohacha, Valledupar, Aguachica, San Andrés.
- El administrador debe asignar su rol ADMIN en `public.actors` después de iniciar sesión con un usuario de Auth, usando SQL del panel Supabase.

## Flujo de movimientos
Carga inicial / ingresos / despachos / consumos / retiros INVERSA / devoluciones / prealertas / recolección, mediante Excel y vista previa editable antes de confirmar. Todas las unidades se registran individualmente, incluso SIN PERFIL.

Las instalaciones solo consumen un equipo previamente asignado LIBRE. Los retiros crean la obligación INVERSA y no elevan el saldo de bodega hasta su recepción física.

## Transferencias
Solo LIBRE entre técnicos. El técnico solicita; logística aprueba; receptor acepta o rechaza. Existen notificaciones en el aplicativo y cola `email_outbox`. **Importante**: los mensajes de correo externo no se envían hasta configurar un transportador de correos y un proceso de envío. Los recordatorios de 6 horas requieren programar `pulso_send_due_alerts()` en servidor.

## Seguridad
El frontend solo contiene una llave publicable. RLS a nivel de tablas, escrituras de inventario mediante funciones de validación transaccional. Los usuarios de consulta no pueden modificar inventarios. Registrar usuarios por el panel Auth y asignarles rol desde el módulo de administración.

## Estado
Primera versión funcional de estructura y flujos básicos. Debe validarse con registros reales, permisos, correo saliente, reportes Claro y pruebas de concurrencia antes de pasar a uso crítico en producción.
