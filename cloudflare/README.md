# PULSO | Cloudflare, fase 1: maestras en cero

**Ambiente independiente. No afecta PULSO en GitHub Pages ni su Supabase existente.**

## Alcance de esta entrega

- Estructura de Cloudflare Worker + base Cloudflare D1 **nueva y vacía**.
- Cinco maestras independientes: bodegas, materiales SAP, equipos/seriales, técnicos y supervisores. La creación de técnicos no crea cuentas de acceso.
- **Ninguna maestra tiene datos precargados**; no hay instrucciones `INSERT` en la migración.
- Registro explícito de maestras mediante API administrativa; no se crean automáticamente a partir de plantillas operativas.
- Validación completa, en servidor, de cada fila de una plantilla operativa, con errores por número de fila. Cualquier error bloquea el lote completo.
- `POST /api/importaciones/confirmar` permanece deliberadamente **bloqueado** (HTTP 423). No hay procesamiento de movimientos de inventario en esta fase.
- No se copia ni se conecta la base de datos antigua de Supabase. Sin alertas en vivo ni acceso de 60 usuarios hasta implementar autenticación de producción.

## Reglas innegociables

1. Un SAP **debe** existir activo en `master_materials` antes de registrar un equipo.
2. Un equipo **debe** existir activo en `master_equipment` y corresponder al SAP informado antes de cargar una operación.
3. Toda bodega informada, incluso cuando es un dato documental de Claro, se contrasta con `master_warehouses`. Las operaciones con traslado físico exigen bodega.
4. Todo técnico informado se contrasta por **identificación**, no por nombre aproximado. Un técnico inactivo no es válido.
5. El supervisor de un técnico, cuando se especifica, ya debe existir en su maestra.
6. Los identificadores se tratan siempre como **texto**. Se conservan ceros iniciales y sufijos, por ejemplo `4065878S`.
7. Excel operativo es una **propuesta de operación**, jamás una orden de alta de bodegas, SAP, equipos, supervisores o técnicos.
8. Un retiro de Claro no aumenta stock físico de bodega; su lógica de pendiente INVERSA se implementará en la fase transaccional tras su validación.
9. Las instalaciones requerirán equipo LIBRE previamente asignado al técnico; esto se verificará en la fase transaccional.
10. No habilitar operaciones ni compartir el token administrativo con el navegador. El control por roles, sesiones y permisos de usuarios se desarrollará antes del despliegue productivo.

## Configuración, sin datos anteriores

En una cuenta Cloudflare autorizada por el propietario:

1. Instala Node.js y Wrangler según la documentación oficial.
2. Dentro de esta carpeta ejecuta `npx wrangler login`.
3. Crea **una D1 nueva**: `npx wrangler d1 create pulso-staging-empty`. Nunca apuntar a una base antigua.
4. Copia el identificador creado a `wrangler.jsonc` en `database_id`.
5. Aplica `npx wrangler d1 migrations apply pulso-staging-empty --remote` tras confirmar el destino.
6. Crea una credencial administrativa aleatoria de 32 caracteres o más y configura `npx wrangler secret put MASTER_ADMIN_TOKEN` (nunca la guardes en GitHub).
7. Publica el Worker: `npx wrangler deploy`. **Este despliegue no importa datos, no genera usuarios y no activa operaciones.**
8. Prueba `GET /api/health`; consulta `GET /api/maestras/estado` únicamente con `Authorization: Bearer <token>` para comprobar que los cinco contadores están en 0.

## Orden correcto de alimentación

1. Maestra de Bodegas (`POST /api/maestras/bodegas`).
2. Maestra de Materiales SAP (`POST /api/maestras/materiales`).
3. Maestra de Supervisores (`POST /api/maestras/supervisores`).
4. Maestra de Técnicos (`POST /api/maestras/tecnicos`), vinculando a supervisores existentes si aplica.
5. Maestra de Equipos (`POST /api/maestras/equipos`), vinculando cada serial con un SAP existente.
6. Importación operativa (`POST /api/importaciones/validar`) solo para consultar errores y coincidencias; no hay confirmación habilitada.

Las maestras pueden alimentarse manualmente o desde un Excel de maestra **explícitamente aprobado**, convertido a JSON en un módulo administrativo futuro. Solo el administrador autorizado podrá confirmar esas altas.

### Ejemplos de estructura JSON, SIN datos de ejemplo

Para `POST /api/maestras/materiales`:

```json
{ "rows": [ { "sap": "CODIGO_DE_LA_MAESTRA", "descripcion": "DESCRIPCION_REAL" } ] }
```

Para validar un despacho, `POST /api/importaciones/validar`:

```json
{
  "tipo": "DESPACHO",
  "rows": [ { "sap": "SAP_EXISTENTE", "serial": "SERIAL_EXISTENTE", "bodega": "BODEGA_EXISTENTE", "tecnico": "IDENTIFICACION_EXISTENTE" } ]
}
```

**Estos ejemplos son exclusivamente de formato** y no se insertan en ninguna base.

## Pruebas sin nube

`npm test` ejecuta pruebas locales sin dependencias, verificando el bloqueo por maestras vacías, seriales y SAP, cruzamientos incorrectos, lotes mixtos y preservación de códigos textuales. También se debe probar la migración SQL sobre SQLite vacía antes de aplicarla remotamente.

## Etapas posteriores (aún NO implementadas)

- Autenticación real y autorización en backend por perfiles ADMIN, ASISTENTE, SUPERVISOR y TÉCNICO.
- Integrar pantallas y plantillas existentes de PULSO a los nuevos endpoints, con mapeo explícito y vista previa.
- Motor de operaciones atómico, eventos Claro, inventario individual, pendientes INVERSA, conciliación, auditoría e idempotencia.
- Alertas en vivo y presencia de técnicos/supervisores (Durable Objects/WebSockets), tras pruebas de carga con 60 usuarios.
- Respaldos, monitoreo y plan de recuperación ante fallos.