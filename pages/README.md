# PULSO · Cloudflare Pages

Este sitio está preparado en la carpeta `pages/` del repositorio GitHub `eyamayai/PULSO`.

## Dirección solicitada

El proyecto Pages debe llamarse **pulso** para generar `https://pulso.pages.dev` si el nombre está disponible. La pantalla de acceso está en `main.html`, que Cloudflare sirve en la ruta limpia `/main`.

## Configuración Git integrada

- Repositorio: `eyamayai/PULSO`
- Rama: `main`
- Directorio raíz: `/`
- Comando de compilación: `exit 0` (sitio estático)
- Directorio de salida: `pages`
- Sin conexión directa a D1 ni secretos visibles en el navegador.

## Seguridad y alcance

La pantalla es una vista de preparación: el inicio de sesión está deshabilitado y no se publican datos operativos. El Worker de pruebas y su base D1 siguen separados en Cloudflare. Ninguna carga histórica se realiza por crear Pages. Se necesitarán autenticación real, permisos por rol, integración API y validaciones en servidor antes de activar funcionalidades.
