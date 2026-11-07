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
if(!mastersHtml.includes('id="tab-personal"')||!mastersHtml.includes('id="tab-catalogo"')||!mastersHtml.includes('id="tab-usuarios"')||!mastersHtml.includes('id="tab-bodegas"')||!mastersHtml.includes('bodegas.js'))
  throw new Error('La nueva pantalla de Maestras no es la versión publicada');
const incomePage=await fetch(origin+'/ingresos',{redirect:'manual',headers:{Cookie:cookie}});
const incomeHtml=await incomePage.text();
if(incomePage.status!==200||!incomeHtml.includes('id="ingress-wizard"')||
   !incomeHtml.includes('src="/ingresos.js"')||
   !incomeHtml.includes('id="ing-confirm"'))
  throw new Error('La página Ingresos no se publicó o no carga los cuatro pasos');
const incomeList=await fetch(origin+'/api/ingresos',{redirect:'manual',headers:{Cookie:cookie}});
const incomeListData=await incomeList.json().catch(()=>({}));
if(incomeList.status!==200||!incomeListData.ok||!Array.isArray(incomeListData.items))
  throw new Error('No se pueden listar ingresos desde D1 con sesión Administrador');
const incomeCatalogs=await fetch(origin+'/api/ingresos/catalogos',{redirect:'manual',headers:{Cookie:cookie}});
const incomeCatalogData=await incomeCatalogs.json().catch(()=>({}));
if(incomeCatalogs.status!==200||!incomeCatalogData.ok||
   !Array.isArray(incomeCatalogData.warehouses)||!Array.isArray(incomeCatalogData.catalog))
  throw new Error('No se pudieron consultar las maestras de Ingresos desde D1');
if(incomeCatalogData.warehouses.some(w=>!['PROPIA','ALIADO'].includes(w.administration)))
  throw new Error('La API de Ingresos entregó una administración inválida');
const anonIncomes=await fetch(origin+'/api/ingresos',{redirect:'manual'});
if(anonIncomes.status!==401)throw new Error('Ingresos es accesible sin autenticación');
for(const endpoint of ['/api/maestras/personal','/api/maestras/catalogo']){
  const result=await fetch(origin+endpoint,{redirect:'manual',headers:{Cookie:cookie}});
  if(result.status!==200)throw new Error('El administrador no puede consultar '+endpoint+'; HTTP '+result.status);
  const data=await result.json();
  if(!data.ok||!Array.isArray(data.items))throw new Error('Respuesta inválida de '+endpoint);
}
const warehouses=await fetch(origin+'/api/maestras/bodegas',{redirect:'manual',headers:{Cookie:cookie}});
if(warehouses.status!==200)throw new Error('La maestra de Bodegas no está disponible para ADMIN; HTTP '+warehouses.status);
const warehousesData=await warehouses.json();
if(!warehousesData.ok||!Array.isArray(warehousesData.items))
  throw new Error('La maestra de Bodegas no devolvió una lista válida');
const own=await fetch(origin+'/api/maestras/bodegas?administration=PROPIA&active=1',
  {redirect:'manual',headers:{Cookie:cookie}});
const allies=await fetch(origin+'/api/maestras/bodegas?administration=ALIADO&active=1',
  {redirect:'manual',headers:{Cookie:cookie}});
if(own.status!==200||allies.status!==200)
  throw new Error('No funcionan los filtros de PROPIA y ALIADO');
const ownRows=(await own.json()).items;
const allyRows=(await allies.json()).items;
if(!Array.isArray(ownRows)||!Array.isArray(allyRows)||
   ownRows.some(x=>x.administration!=='PROPIA'||x.is_active!==1)||
   allyRows.some(x=>x.administration!=='ALIADO'||x.is_active!==1))
  throw new Error('Los filtros de bodegas mezclan orígenes o destinos');
const invalidWarehouse=await fetch(origin+'/api/maestras/bodegas/import',{
  method:'POST',redirect:'manual',
  headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({kind:'BODEGAS',mode:'validate',rows:[{
    centro:'000001',almacen:'0001',description:'Prueba sin inserción',
    administration:'NO_DEFINIDA',department:'Cesar',is_active:true
  }]})
});
const invalidWarehouseData=await invalidWarehouse.json().catch(()=>({}));
if(invalidWarehouse.status!==200||invalidWarehouseData.ok!==true||
   invalidWarehouseData.valid!==false||!invalidWarehouseData.errors?.length)
  throw new Error('La validación de Bodegas aceptó administración inválida');
// Validación no destructiva de departamentos externos: sin crear ninguna bodega.
const key='T'+Date.now().toString(36).toUpperCase();
const nationalPreview=await fetch(origin+'/api/maestras/bodegas/import',{
  method:'POST',redirect:'manual',
  headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({kind:'BODEGAS',mode:'validate',rows:[
    {centro:key,almacen:'A001',description:'Almacén aliado Cundinamarca',
      administration:'ALIADO',department:'Cundinamarca',is_active:true},
    {centro:key,almacen:'A002',description:'Almacén aliado Atlántico',
      administration:'ALIADO',department:'Atlántico',is_active:true},
    {centro:key,almacen:'A003',description:'Almacén propio Cesar',
      administration:'PROPIA',department:'Cesar',is_active:true}
  ]})
});
const national=(await nationalPreview.json().catch(()=>({})));
if(nationalPreview.status!==200||national.valid!==true||national.total!==3)
  throw new Error('La maestra no acepta departamentos nacionales de ALIADOS; estado '+nationalPreview.status);
const ownOutside=await fetch(origin+'/api/maestras/bodegas/import',{
  method:'POST',redirect:'manual',
  headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({kind:'BODEGAS',mode:'validate',rows:[
    {centro:key,almacen:'A004',description:'Bodega propia no permitida',
      administration:'PROPIA',department:'Cundinamarca',is_active:true}
  ]})
});
const ownOutsideData=await ownOutside.json().catch(()=>({}));
if(ownOutside.status!==200||ownOutsideData.valid!==false||
   ownOutsideData.errors?.[0]?.field!=='Departamento')
  throw new Error('Una bodega propia fuera de Costa R1 no fue bloqueada');
const linkProbe=await fetch(origin+'/api/usuarios/vincular-personal',{
  method:'POST',redirect:'manual',
  headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({mode:'validate',assignments:[{personnel_id:'00000000-0000-4000-8000-000000000000',role:'TECNICO'}]})
});
const probe=await linkProbe.json().catch(()=>({}));
if(linkProbe.status!==200||probe.ok!==true||probe.valid!==false||!probe.errors?.length)
  throw new Error('La validación de vínculos no rechazó el Personal inexistente');
const unauthLink=await fetch(origin+'/api/usuarios/vincular-personal',{redirect:'manual'});
if(unauthLink.status!==401)throw new Error('No se protegió la vinculación sin sesión');
const userResponse=await fetch(origin+'/api/usuarios',{redirect:'manual',headers:{Cookie:cookie}});
if(userResponse.status!==200)throw new Error('El administrador no puede consultar Usuarios y Permisos; HTTP '+userResponse.status);
const userData=await userResponse.json();
if(!userData.ok||!Array.isArray(userData.items)||!userData.items.some(u=>u.role==='ADMIN'))
  throw new Error('No se recuperó correctamente la lista de cuentas autorizadas');
const anonymous=await fetch(origin+'/api/usuarios',{redirect:'manual'});
if(anonymous.status!==401)throw new Error('La API de usuarios no bloquea la consulta anónima');
const activation=await fetch(origin+'/activar',{redirect:'manual'});
if(activation.status!==200||!(await activation.text()).includes('activation-form'))
  throw new Error('La página de activación de contraseñas no está publicada');
let bulkReady=false;
let lastBulkStatus=0;
for(let retry=1;retry<=15;retry++){
  const invalidBulk=await fetch(origin+'/api/maestras/import',{
    method:'POST',redirect:'manual',
    headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({kind:'CATALOGO',mode:'validate',rows:[{sap_code:'',description:''}]})
  });
  lastBulkStatus=invalidBulk.status;
  const preview=await invalidBulk.json().catch(()=>({}));
  if(invalidBulk.status===200&&preview.ok===true&&preview.valid===false&&preview.errors?.length){
    bulkReady=true;
    break;
  }
  if(![404,503].includes(invalidBulk.status))
    throw new Error('La vista previa masiva falló (HTTP '+invalidBulk.status+', código '+(preview.error||'desconocido')+')');
  await new Promise(resolve=>setTimeout(resolve,3000));
}
if(!bulkReady)throw new Error('La ruta de importación masiva no se propagó en Cloudflare (HTTP '+lastBulkStatus+')');
const logout=await fetch(origin+'/api/auth/logout',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'});
if(!logout.ok)throw new Error('Falló el cierre de sesión');
const after=await fetch(origin+'/inicio',{redirect:'manual',headers:{Cookie:cookie}});
if(after.status!==302||after.headers.get('location')!=='/main')throw new Error('La sesión revocada aún puede acceder a Inicio');
console.log('Acceso y cierre, Usuarios/ADMIN, Maestras y activación protegida verificados sin exponer credenciales.');