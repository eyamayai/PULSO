# PULSO · Maestras (fase inicial)

Páginas: `/inicio` y `/maestras`. Ambas requieren autenticación; Maestras y sus API permiten el acceso únicamente a administradores. La interfaz conserva la identidad de PULSO y utiliza el logo original.

## Diseño de datos

### Personal
La maestra `master_personnel` concentra **supervisores y técnicos**. Campos: identificación única, nombre, tipo (supervisor/técnico), departamento, zona del supervisor o ciudad base del técnico, supervisor asignado al técnico, correo y teléfono opcionales, estado activo, fechas y auditoría.

Un técnico solo puede crearse con un supervisor activo previamente registrado. Un supervisor con técnicos activos no puede desactivarse hasta reasignarlos o desactivarlos. Identificación y tipo no pueden cambiarse después de crear el registro; otros campos se pueden corregir.

### Equipos y Materiales
La maestra `master_sap_catalog` almacena código SAP único (preservado como texto para no perder ceros iniciales), descripción, tipo (equipo/material), perfil **CON PERFIL DE SERIE** o **SIN PERFIL DE SERIE**, unidad, familia opcional y estado.

Crear un código SAP **no crea inventario ni recibe mercancías**. La API de futuras cargas deberá validar contra esta maestra. Las bodegas siguen sin crearse automáticamente.

### Accesos
La tabla `app_users` es independiente de `master_personnel`. Dar de alta un supervisor o técnico no crea usuario, contraseña ni sesión. Más adelante podrá añadirse un enlace explícito entre personal y cuenta, con administración de roles y permisos.

## Seguridad
`GET/POST/PATCH /api/maestras/personal` y `GET/POST/PATCH /api/maestras/catalogo` exigen usuario autenticado con rol `ADMIN`. Los cambios de estado son lógicos, no eliminaciones físicas. Se registran entidad, identificador, tipo de cambio y autor en `master_audit`. La API bloquea datos inválidos, duplicados y referencias no vigentes.

## Operación y despliegue
La migración idempotente `cloudflare/migrations/0004_maestras_personal_y_sap.sql` incorpora tablas nuevas a D1 sin importar información previa ni alterar movimientos. Se ejecuta mediante GitHub Actions como parte del despliegue de Pages. Se mantiene la validación de que `/maestras` exige sesión y que las APIs son privadas.

Esta es la primera versión de captura individual. La importación masiva de Excel, las maestras de bodegas, los permisos granulares y la administración segura de contraseñas quedan para fases posteriores. Es crucial conservar la regla: **un Excel no puede crear maestros implícitamente**.


## Carga masiva de Excel (.xlsx)

El administrador puede utilizar **Carga masiva Excel** en Maestras para descargar plantillas de **Supervisores**, **Técnicos** y **Equipos y materiales**. Las plantillas incluyen encabezados estandarizados y columnas de identificación/código SAP como texto, preservando ceros iniciales.

Orden recomendado: primero supervisores, después técnicos asociados por **identificación del supervisor**, y luego catálogo SAP. Los técnicos no crean cuentas de usuario. Cada plantilla contiene una sola hoja; máximo 1.000 registros o 5 MB por archivo. Se valida toda la carga antes de permitir la confirmación.

El cliente interpreta el archivo en el navegador mediante ExcelJS 4.4.0, distribuido por Pages. El servidor **vuelve a validar** todos los registros contra D1: tipos, campos obligatorios, referencias, duplicados internos y existentes. La importación usa una transacción D1 con dos instrucciones SQL parametrizadas que insertan registros y auditoría. Ante un error, se revierte toda la carga y no se acepta una importación parcial. No hay inserciones silenciosas desde un Excel ni se reconocen bodegas, usuarios o SAP desconocidos.

La validación preliminar no persiste registros. Al confirmar se vuelve a validar para contemplar cambios concurrentes. Si dos operadores intentan cargar los mismos códigos, las restricciones únicas de base de datos detienen la segunda operación. Los errores señalan el número de fila. El sistema nunca permite sobreescritura automática de registros existentes: las actualizaciones se realizan en la ficha individual por el administrador.

Los archivos Excel solo se interpretan como datos, las fórmulas no se ejecutan ni se aceptan. El servidor no utiliza macros ni evalúa expresiones de la hoja.
