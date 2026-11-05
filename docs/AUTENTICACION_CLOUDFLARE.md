# PULSO · Autenticación segura (Cloudflare Pages y D1)

El formulario público en `/main` consume una API de autenticación en el mismo dominio, protegida con cookies HttpOnly y Secure. La dirección `/inicio` es inaccesible sin una sesión válida.

## Activar primer usuario
Solo el administrador del repositorio debe crear estos **GitHub Actions secrets**:

- `PULSO_ADMIN_EMAIL`: correo autorizado del primer administrador.
- `PULSO_ADMIN_PASSWORD`: contraseña de 14 a 128 caracteres, con mayúscula, minúscula, número y símbolo.

No compartir contraseñas ni tokens por chat. Tras guardar ambos secretos, ejecutar el flujo [Publicar PULSO en Cloudflare Pages](https://github.com/eyamayai/PULSO/actions/workflows/pulso-pages-setup.yml).

El flujo agrega **un administrador exclusivamente si todavía no existe ningún usuario**. Los despliegues posteriores no reemplazan credenciales ni crean usuarios a partir de maestras. Recomendación: retirar los dos secretos de bootstrap tras el alta inicial y gestionar la rotación de contraseñas en una siguiente fase.

## Componentes
- Base D1 existente: `pulso-staging-empty`; migración `0002_autenticacion.sql` crea únicamente tablas de usuarios, sesiones y bloqueos.
- Contraseñas: PBKDF2-SHA512 (220.000 iteraciones, salt aleatorio), sin guardar texto plano.
- Sesiones: token de 256 bits, almacenado en D1 solo como hash SHA-256; cookie HttpOnly, Secure, SameSite=Lax, validez de 8 horas.
- Login: limitación de intentos por correo e IP. No se permite autorregistro.
- Logout: revoca la sesión en D1.
- Páginas: la protección de `/inicio` se realiza en el servidor, no solamente en JavaScript.

**Limitación vigente:** La autenticación no habilita movimientos de inventario ni las API administrativas anteriores. Continúan bloqueadas hasta que se implementen roles y permisos sobre las operaciones.
