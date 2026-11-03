# PULSO Cloudflare · Cómo obtener el enlace de pruebas

Este despliegue es independiente de SIGLO, del PULSO actual en GitHub Pages y de Supabase. No carga información histórica. Usa exclusivamente la rama feature/cloudflare-fase1-maestras-vacias.

## Pasos para habilitarlo
1. Entrar o crear una cuenta gratuita en https://dash.cloudflare.com/.
2. Obtener el identificador Account ID de Cloudflare y generar un API Token limitado a esa cuenta, con permisos para editar Workers y D1. Guía: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
3. Abrir https://github.com/eyamayai/PULSO/settings/secrets/actions y agregar dos secretos de repositorio:
   - CLOUDFLARE_ACCOUNT_ID = identificador de cuenta.
   - CLOUDFLARE_API_TOKEN = token secreto de Cloudflare.
   No publicar ni enviar las credenciales por chat.
4. Abrir https://github.com/eyamayai/PULSO/actions/workflows/pulso-cloudflare-staging.yml y ejecutar Run workflow desde main.
5. Una vez termine correctamente, el resumen de la ejecución mostrará Abrir PULSO con el enlace real de Cloudflare.

## Alcance del primer enlace
- Presentación inicial de PULSO con API Cloudflare Workers y base nueva D1.
- Maestras creadas sin registros precargados ni migrados.
- Sin usuarios de producción ni movimientos habilitados.
- Lotes Excel rechazados si falta cualquier maestro, SAP, serial, bodega o técnico.
- API de importación final bloqueada con HTTP 423.
- El siguiente desarrollo será autenticación real, pantallas de maestras, Excel validado y notificaciones.

Si una ejecución falla por permisos, revisa la pestaña Actions. No compartas registros que incluyan credenciales.
