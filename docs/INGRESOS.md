# PULSO · Ingresos de inventario (D1)

## Flujo operativo aprobado
**Ingresos** usa cuatro pasos: Documento, Ítems, Validación y Confirmación. Se puede retroceder, avanzar y guardar borradores aunque existan errores. Solo el acto definitivo «Registrar ingreso» exige validación sin errores bloqueantes y actualiza existencias. La confirmación aplica todo o nada.

**Documento:** tipo (orden de compra, factura, remisión, acta de entrega, otro), número, fecha, remitente, destino, observaciones y soporte PDF opcional (hasta 5 MB). El remitente debe ser **ALIADO y activo** y el destino debe ser **PROPIA y activa**. Ambos provienen exclusivamente de la maestra `master_logistics_locations`, conservando Centro, Almacén y descripción. La ausencia del PDF únicamente genera aviso, nunca bloqueo.

**Ítems:** SAP existente y activo de la maestra, serial obligatorio y cantidad **1** si `CON PERFIL DE SERIE`; serial vacío y cantidad entera mayor que cero si `SIN PERFIL DE SERIE`. Se pueden agregar manualmente o cargar desde Excel (plantilla descargable) y revisar sin guardar existencias.

**Validación:** impide códigos SAP inexistentes/inactivos, bodega inválida, origen inválido, cantidades o seriales incorrectos, seriales repetidos dentro del documento o previamente contabilizados en D1. Las observaciones no bloqueantes se identifican aparte. Cada error apunta al paso o ítem correspondiente.

**Confirmación:** resumen final del documento, almacenes, PDF e ítems; aceptación expresa; nueva validación inmediatamente antes de registrar. El botón está bloqueado hasta que no haya errores. Un ingreso registrado es inmutable. Los borradores no modifican inventario.

## Integridad transaccional y privacidad
- Migración: `cloudflare/migrations/0009_ingresos.sql`, nuevas tablas `ingress_documents`, `ingress_items`, `ingress_support_chunks`, `inventory_serials`, `inventory_bulk_stock`, `inventory_movements` e `ingress_audit`.
- Las reglas críticas están replicadas en triggers D1 que se ejecutan dentro de **la misma transacción SQLite** que añade existencias y movimientos. No hay registro parcial.
- Inventario serializado usa índice primario único sobre serial (sin distinción de mayúsculas) y referencia a bodega propia, ingreso e ítem. Stock no serializado suma por `warehouse_id + sap_code`. Los movimientos tienen enlace a ítem, origen, destino, usuario y fecha.
- El PDF se conserva **privado** en bloques binarios de D1. No se publica como un archivo estático. Solo ADMIN autenticado puede verlo, adjuntarlo o quitarlo mientras el ingreso es borrador. Se guarda SHA-256, nombre limpio y tamaño.
- Los perfiles `SUPERVISOR`, `TECNICO` y `AUDITOR` aún no tienen permisos operativos aprobados; el registro de ingresos queda restringido a ADMIN.
- Los movimientos antiguos en SQL de Supabase y las maestras no se modifican. La coexistencia con los módulos futuros exige usar las tablas D1 para cualquier consulta posterior de stock.

## Endpoints
`GET/POST /api/ingresos` (listar, crear borrador),
`GET /api/ingresos/catalogos` (SAP y bodegas activos),
`GET/PATCH/DELETE /api/ingresos/:id`,
`GET/POST /api/ingresos/:id/validar`,
`POST /api/ingresos/:id/confirmar`,
`GET/POST/DELETE /api/ingresos/:id/soporte`.
Cambios exigen sesión ADMIN y origen del mismo sitio.

## Alcance
La interfaz está en `/ingresos`, conserva el shell PULSO y su identidad visual aprobada. No habilita Despachos, Consumos ni Traslados; estos deberán integrar el inventario D1 y definir sus propias reglas. No se crean ingresos operativos automáticamente.
