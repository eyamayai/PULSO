/** End-to-end verification using secrets only in CI; do not print credentials or cookies. */
const email=(process.env.PULSO_ADMIN_EMAIL||'').trim().toLowerCase();
const password=process.env.PULSO_ADMIN_PASSWORD||'';
if(!email && !password){console.log('Sin cuenta inicial; verificación con credenciales pospuesta.');process.exit(0)}
if(!email || !password)throw new Error('Configuración incompleta del administrador');
const origin='https://pulso-mintic.pages.dev';
const login=await fetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
if(!login.ok)throw new Error('No se pudo iniciar sesión con la cuenta autorizada; HTTP '+login.status);
const payload=await login.json();
if(!payload.ok || payload.user?.role!=='ADMIN')throw new Error('El perfil de administrador no es válido');
const cookie=login.headers.get('set-cookie')?.split(';')[0];
if(!/^__Host-pulso_session=[A-Za-z0-9_-]{43}$/.test(cookie||''))throw new Error('Cookie de sesión segura no entregada');
const me=await fetch(origin+'/api/auth/me',{redirect:'manual',headers:{Cookie:cookie}});
if(!me.ok)throw new Error('La sesión no pudo recuperarse');
const home=await fetch(origin+'/inicio',{redirect:'manual',headers:{Cookie:cookie}});
if(home.status!==200)throw new Error('La sesión no puede acceder a Inicio; HTTP '+home.status);
const masters=await fetch(origin+'/maestras',{redirect:'manual',headers:{Cookie:cookie}});
if(masters.status!==200)throw new Error('El administrador no puede abrir Maestras; HTTP '+masters.status);
const mastersHtml=await masters.text();
if(!mastersHtml.includes('id="tab-personal"')||!mastersHtml.includes('id="tab-catalogo"'))
  throw new Error('La nueva pantalla de Maestras no es la versión publicada');
for(const endpoint of ['/api/maestras/personal','/api/maestras/catalogo']){
  const result=await fetch(origin+endpoint,{redirect:'manual',headers:{Cookie:cookie}});
  if(result.status!==200)throw new Error('El administrador no puede consultar '+endpoint+'; HTTP '+result.status);
  const data=await result.json();
  if(!data.ok||!Array.isArray(data.items))throw new Error('Respuesta inválida de '+endpoint);
}
const invalidBulk=await fetch(origin+'/api/maestras/import',{
  method:'POST',redirect:'manual',
  headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({kind:'CATALOGO',mode:'validate',rows:[{sap_code:'',description:''}]})
});
if(invalidBulk.status!==200)throw new Error('No se pudo validar la importación masiva, HTTP '+invalidBulk.status);
const preview=await invalidBulk.json();
if(!preview.ok||preview.valid!==false||!preview.errors?.length)
  throw new Error('La validación masiva no rechazó un registro inválido');
const logout=await fetch(origin+'/api/auth/logout',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'});
if(!logout.ok)throw new Error('Falló el cierre de sesión');
const after=await fetch(origin+'/inicio',{redirect:'manual',headers:{Cookie:cookie}});
if(after.status!==302||after.headers.get('location')!=='/main')throw new Error('La sesión revocada aún puede acceder a Inicio');
console.log('Acceso, Maestras, autorización ADMIN, D1 y cierre de sesión verificados sin registrar credenciales.');