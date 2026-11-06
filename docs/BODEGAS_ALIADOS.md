# PULSO · Bodegas y Aliados

Cuarta pestaña de **Maestras**. Una sola maestra distingue almacenes administrados por **PROPIA (Dominion)** y **ALIADO**. No se han precargado bodegas ni proveedores y no se crea inventario.

## Campos y reglas
- **Centro** y **Almacén**: códigos alfanuméricos, guardados como texto para conservar ceros iniciales. La combinación `Centro + Almacén` es única; una vez creada no se modifica.
- **Descripción**: nombre identificativo del almacén.
- **Administración**: exactamente `PROPIA` o `ALIADO`.
- **Departamento**: `CESAR`, `LA GUAJIRA` o `SAN ANDRES`. Se admiten Guajira/La Guajira y San Andrés con o sin tilde en las importaciones.
- **Estado**: activo o inactivo. Se desactiva sin eliminar el historial.

### Regla reservada al módulo Ingresos
- **Quién despacha**: solo `ALIADO` y activo.
- **Bodega destino**: solo `PROPIA` y activa.
- Ambos deben **existir previamente en D1**, y el inventario solo aumentará en el destino propio.
- Esta regla deberá implementarse y comprobarse en el **servidor** del módulo Ingresos, no únicamente como filtro visual.
- **Traslados** definirá sus reglas propias posteriormente.

## Interfaces
- Crear/editar/activar/desactivar individualmente con administración exclusiva del rol `ADMIN`.
- Filtrar por Administración y Estado.
- Carga masiva Excel con plantilla `PULSO_Maestra_Bodegas_Aliados.xlsx`, hasta 1.000 filas, previa validación y bloqueo total del archivo ante errores.
- Nunca insertar bodegas implícitamente desde Excel de Ingresos.
- Los campos de Centro/Almacén de la plantilla se formatean como texto.
- Las modificaciones se registran en `master_warehouse_audit` con fecha y usuario.

## Recursos
- `cloudflare/migrations/0007_bodegas_aliados.sql`
- `GET /api/maestras/bodegas` (admite filtros `?administration=PROPIA&active=1` o `ALIADO`, solo ADMIN por ahora)
- `POST /api/maestras/bodegas`
- `PATCH /api/maestras/bodegas`
- `POST /api/maestras/bodegas/import` (`kind:'BODEGAS'`, `mode:'validate'|'commit'`)
- `pages/maestras.html`, `pages/maestras.js`, `pages/bodegas.js`, `pages/maestras-import.js`, `pages/maestras.css`.

Los movimientos del módulo Ingresos aún no están habilitados y la ausencia de PDF no es bloqueante según la decisión aprobada para ese módulo.
