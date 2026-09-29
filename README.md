# PULSO

**Plataforma Unificada de Logística, Seguimiento y Operaciones**

> El pulso de tu operación.

PULSO es una aplicación web independiente para gestionar la operación logística del proyecto MinTIC. Nace desde cero con identidad, arquitectura y modelo de datos propios.

## Estado actual

Versión **v0.1**: base funcional de interfaz y modelo de datos.

Incluye:

- Login visual inspirado en la identidad PULSO.
- Navegación principal: Inicio, Ingresos, Trazabilidad y Configuración.
- Registro local de ingresos operativos, históricos e importados.
- Detalle por Código SAP, serial, tipo de recepción, lote y cantidad.
- Consulta básica de trazabilidad de seriales.
- Maestro CRUD inicial de Almacenes SAP.
- Bodegas iniciales de Riohacha: **A221** y **U020**.
- Centros iniciales: **C903 Costa** y **C901 Centro**.
- Ubicaciones iniciales: Riohacha, Valledupar, Aguachica y San Andrés.
- Esquema PostgreSQL/Supabase preparado en `supabase/schema.sql`.
- Flujo de despliegue para GitHub Pages.

## Identidad visual

- Carbón: `#1F252D`
- Verde PULSO: `#13A66B`
- Verde profundo: `#0B5D46`
- Naranja energía: `#F39C12`
- Marfil claro: `#F5F1E8`
- Títulos: **Poppins**
- Interfaz y texto: **Inter**

## Principios del modelo

1. Un serial existe una sola vez como equipo, aunque pueda ingresar múltiples veces.
2. La historia del serial se construye mediante movimientos cronológicos.
3. Se diferencia la **fecha efectiva del evento** de la **fecha de registro en PULSO**.
4. Los registros históricos pueden existir con información incompleta y completarse posteriormente.
5. PULSO no obliga a inventar datos históricos desconocidos.
6. Los maestros SAP se administran desde Configuración.
7. Las modificaciones críticas quedarán auditadas al conectar Supabase.

## Ejecución actual

La interfaz funciona temporalmente con almacenamiento local del navegador para poder probar flujos sin backend. **No es todavía autenticación de producción.**

El siguiente hito es conectar Supabase Auth + PostgreSQL y reemplazar el almacenamiento local por persistencia real y segura.

## Publicación

El repositorio contiene un workflow en `.github/workflows/pages.yml` para GitHub Pages. Una vez habilitado GitHub Pages con **GitHub Actions** como fuente, los cambios de `main` podrán desplegarse automáticamente.
