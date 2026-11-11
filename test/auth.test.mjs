import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import worker from '../pages/auth-worker.mjs';
const sql = fs.readFileSync(new URL('../cloudflare/migrations/0002_autenticacion.sql', import.meta.url), 'utf8');
const sql3 = fs.readFileSync(new URL('../cloudflare/migrations/0003_auth_passwords_compat.sql', import.meta.url), 'utf8');
const sql4=fs.readFileSync(new URL('../cloudflare/migrations/0004_maestras_personal_y_sap.sql',import.meta.url),'utf8');
const sql5=fs.readFileSync(new URL('../cloudflare/migrations/0005_usuarios_permisos.sql',import.meta.url),'utf8');
const sql6=fs.readFileSync(new URL('../cloudflare/migrations/0006_vinculo_personal_usuarios.sql',import.meta.url),'utf8');
const sql7=fs.readFileSync(new URL('../cloudflare/migrations/0007_bodegas_aliados.sql',import.meta.url),'utf8');
const sql8=fs.readFileSync(new URL('../cloudflare/migrations/0008_departamentos_aliados.sql',import.meta.url),'utf8');
const sql9=fs.readFileSync(new URL('../cloudflare/migrations/0009_ingresos.sql',import.meta.url),'utf8');
const sql10=fs.readFileSync(new URL('../cloudflare/migrations/0010_seriales_internos_ingresos.sql',import.meta.url),'utf8');
const sql11=fs.readFileSync(new URL('../cloudflare/migrations/0011_clasificacion_estados_ingresos.sql',import.meta.url),'utf8');
const sql12=fs.readFileSync(new URL('../cloudflare/migrations/0012_validacion_clasificacion_ingresos.sql',import.meta.url),'utf8');
const sql13=fs.readFileSync(new URL('../cloudflare/migrations/0013_valor_unitario_catalogo.sql',import.meta.url),'utf8');
const sql14=fs.readFileSync(new URL('../cloudflare/migrations/0014_despachos_tecnicos.sql',import.meta.url),'utf8');
const sql15=fs.readFileSync(new URL('../cloudflare/migrations/0015_despachos_masivos.sql',import.meta.url),'utf8');
const sql16=fs.readFileSync(new URL('../cloudflare/migrations/0016_reinicio_operativo_20261111.sql',import.meta.url),'utf8');
const sql17=fs.readFileSync(new URL('../cloudflare/migrations/0017_apertura_saldos_iniciales.sql',import.meta.url),'utf8');
const sql18=fs.readFileSync(new URL('../cloudflare/migrations/0018_correccion_sap_serial_4060070_val_0023.sql',import.meta.url),'utf8');
const root='https://pulso-mintic.pages.dev';
function setup({legacyWarehouse=false}={}) {
  const database = new DatabaseSync(':memory:'); database.exec(sql); database.exec(sql3); database.exec(sql4); database.exec(sql5); database.exec(sql6); database.exec(sql7); if(!legacyWarehouse){database.exec(sql8);database.exec(sql9);database.exec(sql10);database.exec(sql11);database.exec(sql12);database.exec(sql13);database.exec(sql14);database.exec(sql15);database.exec(sql17);}
  const wrap = stmt => {
    let args=[];
    return {
      bind(...values){ args=values;return this; },
      async first(){return database.prepare(stmt).get(...args)||null},
      async all(){return {results:database.prepare(stmt).all(...args)}},
      async run(){return database.prepare(stmt).run(...args)}
    };
  };
  const DB={prepare:wrap,async batch(stmts){database.exec('BEGIN');try{const results=[];for(const stmt of stmts){const v=await stmt.run();results.push(v)}database.exec('COMMIT');return results;}catch(e){database.exec('ROLLBACK');throw e;}}};
  const env={DB, ASSETS:{async fetch(){return new Response('<html>Inicio</html>',{'headers':{'content-type':'text/html'}})}}};
  const addUser=(email='admin@example.com',password='Prueba-de-acceso-2026!')=>{
    const salt=randomBytes(16);
    const digest=pbkdf2Sync(password,salt,220000,32,'sha512');
    const id=randomUUID();
    database.prepare('INSERT INTO app_users(id,email,display_name,password_hash,password_salt,password_kdf,role,active) VALUES (?,?,?,?,?,?,?,1)').run(id,email,'Admin de pruebas',digest.toString('hex'),salt.toString('hex'),'pbkdf2-sha512-220000','ADMIN');
    const saltV2=randomBytes(16);
    const digestV2=pbkdf2Sync(password,saltV2,100000,32,'sha512');
    database.prepare('INSERT INTO auth_passwords(user_id,password_hash,password_salt,password_kdf) VALUES (?,?,?,?)').run(id,digestV2.toString('hex'),saltV2.toString('hex'),'pbkdf2-sha512-100000');
  };
  function req(path,{method='GET',data,origin=root,headers={}}={}){
    return new Request(root+path,{method,headers:{...(data?{'content-type':'application/json','origin':origin}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});
  }
  return {database,env,addUser,req};
}
test('No permite acceder a inicio sin sesión',async()=>{const x=setup();const r=await worker.fetch(x.req('/inicio'),x.env);assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/main')});
test('API de autenticación requiere D1; no crea usuarios',async()=>{const x=setup();assert.equal((await worker.fetch(x.req('/api/auth/health'),x.env)).status,200);const me=await worker.fetch(x.req('/api/auth/me'),x.env);assert.equal(me.status,401);assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,0);assert.equal((await worker.fetch(x.req('/api/auth/health'),{})).status,503)});
test('Inicio de sesión y cierre de sesión, cookie HttpOnly SameSite',async()=>{const x=setup();x.addUser();const r=await worker.fetch(x.req('/api/auth/login',{method:'POST',data:{email:'admin@example.com',password:'Prueba-de-acceso-2026!'}}),x.env);assert.equal(r.status,200);const body=await r.json();assert.equal(body.user.role,'ADMIN');assert.equal(body.redirect,'/inicio');const cookie=r.headers.get('set-cookie');assert.match(cookie,/__Host-pulso_session=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);assert.match(cookie,/Secure/);const session=cookie.split(';')[0];const authorized={headers:{cookie:session}};assert.equal((await worker.fetch(x.req('/api/auth/me',authorized),x.env)).status,200);assert.equal((await worker.fetch(x.req('/inicio',authorized),x.env)).status,200);assert.equal((await worker.fetch(x.req('/main',authorized),x.env)).status,302);const logout=await worker.fetch(x.req('/api/auth/logout',{method:'POST',origin:root,headers:{cookie:session,origin:root}}),x.env);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await worker.fetch(x.req('/inicio',authorized),x.env)).status,302)});
test('Rechaza claves erradas y POST de otro origen',async()=>{const x=setup();x.addUser();let r=await worker.fetch(x.req('/api/auth/login',{method:'POST',origin:'https://sitio-ajeno.example',data:{email:'admin@example.com',password:'Prueba-de-acceso-2026!'}}),x.env);assert.equal(r.status,403);r=await worker.fetch(x.req('/api/auth/login',{method:'POST',data:{email:'admin@example.com',password:'no'}}),x.env);assert.equal(r.status,401);assert.equal(x.database.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n,0)});
test('Bloquea intentos reiterados sin afectar otros datos',async()=>{const x=setup();x.addUser();for(let i=0;i<5;i++){const r=await worker.fetch(x.req('/api/auth/login',{method:'POST',data:{email:'admin@example.com',password:'equivocada'}}),x.env);assert.equal(r.status,401)}const r=await worker.fetch(x.req('/api/auth/login',{method:'POST',data:{email:'admin@example.com',password:'Prueba-de-acceso-2026!'}}),x.env);assert.equal(r.status,429)});
test('Usuario legado sin clave compatible no recibe acceso',async()=>{const x=setup();const id=randomUUID();const salt=randomBytes(16);const password='Clave-prueba-segura2026!';const digest=pbkdf2Sync(password,salt,220000,32,'sha512');x.database.prepare('INSERT INTO app_users(id,email,display_name,password_hash,password_salt,password_kdf,role,active) VALUES (?,?,?,?,?,?,?,1)').run(id,'legacy@example.com','Legado',digest.toString('hex'),salt.toString('hex'),'pbkdf2-sha512-220000','ADMIN');const r=await worker.fetch(x.req('/api/auth/login',{method:'POST',data:{email:'legacy@example.com',password}}),x.env);assert.equal(r.status,401)});

async function adminCookie(x) {
 x.addUser();
 const response=await worker.fetch(x.req('/api/auth/login',{method:'POST',data:{email:'admin@example.com',password:'Prueba-de-acceso-2026!'}}),x.env);
 assert.equal(response.status,200);
 return response.headers.get('set-cookie').split(';')[0];
}
const supervisor={
 document_number:'11223344',full_name:'Supervisora de Pruebas',position:'SUPERVISOR',
 department:'CESAR',zone:'Valledupar Norte',city_base:'',supervisor_id:'',
 email:'supervisor@example.com',phone:'3001234567',is_active:true
};
const technician={
 document_number:'55667788',full_name:'Técnico de Pruebas',position:'TECNICO',
 department:'CESAR',zone:'',city_base:'Valledupar',supervisor_id:'',
 email:'tecnico@example.com',phone:'3101234567',is_active:true
};
const sapItem={
 sap_code:'00000012345',description:'Equipo de pruebas',item_type:'EQUIPO',
 serial_profile:'CON PERFIL DE SERIE',unit:'UND',family:'Acceso',is_active:true
};
test('Maestras vacías, acceso protegido y sin creación de cuentas por ficha',async()=>{
 const x=setup();
 const guest=await worker.fetch(x.req('/api/maestras/personal'),x.env);
 assert.equal(guest.status,401);
 assert.equal((await worker.fetch(x.req('/maestras'),x.env)).status,302);
 const cookie=await adminCookie(x);
 const headers={cookie};
 const loaded=await worker.fetch(x.req('/api/maestras/personal',{headers}),x.env);
 assert.equal(loaded.status,200);
 assert.deepEqual((await loaded.json()).items,[]);
 assert.equal((await worker.fetch(x.req('/maestras',{headers}),x.env)).status,200);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,0);
});
test('Supervisor primero, técnico solo si su supervisor existe y está activo',async()=>{
 const x=setup();const cookie=await adminCookie(x);
 const req=(p,method,data)=>worker.fetch(x.req(p,{method,data,headers:{cookie}}),x.env);
 const invalid=await req('/api/maestras/personal','POST',{...technician,supervisor_id:randomUUID()});
 assert.equal(invalid.status,422);
 let res=await req('/api/maestras/personal','POST',supervisor);
 assert.equal(res.status,201);
 const bossId=(await res.json()).id;
 res=await req('/api/maestras/personal','POST',{...technician,supervisor_id:bossId});
 assert.equal(res.status,201);
 const list=await worker.fetch(x.req('/api/maestras/personal',{headers:{cookie}}),x.env);
 const items=(await list.json()).items;
 assert.equal(items.length,2);
 assert.equal(items.find(v=>v.position==='TECNICO').supervisor_name,supervisor.full_name);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,1);
 assert.equal((await req('/api/maestras/personal','POST',supervisor)).status,409);
 assert.equal((await req('/api/maestras/personal','PATCH',{id:bossId,is_active:false})).status,409);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_audit').get().n,2);
});
test('Catálogo SAP único y perfil de serie obligatorio, sin generar inventario',async()=>{
 const x=setup();const cookie=await adminCookie(x);
 const req=(method,data)=>worker.fetch(x.req('/api/maestras/catalogo',{method,data,headers:{cookie}}),x.env);
 assert.equal((await req('POST',{...sapItem,serial_profile:'DESCONOCIDO'})).status,400);
 let res=await req('POST',sapItem);
 assert.equal(res.status,201);const id=(await res.json()).id;
 assert.equal((await req('POST',sapItem)).status,409);
 res=await req('PATCH',{id,description:'Equipo corregido'});
 assert.equal(res.status,200);
 res=await req('PATCH',{id,is_active:false});
 assert.equal(res.status,200);
 const get=await worker.fetch(x.req('/api/maestras/catalogo',{headers:{cookie}}),x.env);
 const items=(await get.json()).items;
 assert.equal(items.length,1);assert.equal(items[0].is_active,0);
 assert.equal(items[0].sap_code,'00000012345');
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_audit').get().n,3);
});
test('Solo ADMIN edita maestras y POST bloquea otros orígenes',async()=>{
 const x=setup();const cookie=await adminCookie(x);
 x.addUser('respaldo1@example.com','ClaveRespaldoSegura2026!');
 x.database.prepare("UPDATE app_users SET role='AUDITOR' WHERE email='admin@example.com'").run();
 assert.equal((await worker.fetch(x.req('/api/maestras/personal',{headers:{cookie}}),x.env)).status,403);
 assert.equal((await worker.fetch(x.req('/maestras',{headers:{cookie}}),x.env)).status,302);
 x.database.prepare("UPDATE app_users SET role='ADMIN' WHERE email='admin@example.com'").run();
 const forbidden=await worker.fetch(x.req('/api/maestras/catalogo',{method:'POST',data:sapItem,origin:'https://ajeno.example',headers:{cookie}}),x.env);
 assert.equal(forbidden.status,403);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,0);
});

async function importReq(x,cookie,kind,rows,mode='validate',origin=root){
  return worker.fetch(x.req('/api/maestras/import',{method:'POST',origin,
    headers:{cookie},data:{kind,mode,rows}}),x.env);
}
const bulkSupervisor=(number='8000000',name='Supervisor Operativo')=>({
  document_number:number,full_name:name,department:'CESAR',zone:'Cesar R1',
  email:'',phone:'',is_active:true
});
const bulkTech=(number='9000000',supervisor='8000000')=>({
  document_number:number,full_name:'Técnico de campo '+number,department:'CESAR',
  city_base:'Valledupar',supervisor_document:supervisor,email:'',phone:'',is_active:true
});
const bulkSap=(code='0000100001')=>({
  sap_code:code,description:'Equipo de telecomunicaciones',item_type:'EQUIPO',
  serial_profile:'CON PERFIL DE SERIE',unit:'UND',family:'Acceso',is_active:true
});
test('Carga masiva: preview no escribe y 60 supervisores se insertan de una vez con auditoría',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const items=Array.from({length:60},(_,i)=>bulkSupervisor(String(8000000+i),'Supervisor '+i));
  let res=await importReq(x,cookie,'SUPERVISORES',items);
  assert.equal(res.status,200);
  assert.equal((await res.json()).valid,true);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,0);
  res=await importReq(x,cookie,'SUPERVISORES',items,'commit');
  assert.equal(res.status,201);assert.equal((await res.json()).inserted,60);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,60);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_audit').get().n,60);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,1);
  res=await importReq(x,cookie,'SUPERVISORES',items);
  assert.equal((await res.json()).valid,false);
  res=await importReq(x,cookie,'SUPERVISORES',items,'commit');
  assert.equal(res.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,60);
});
test('Carga masiva: 80 técnicos solo con supervisores activos existentes',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  assert.equal((await importReq(x,cookie,'SUPERVISORES',[bulkSupervisor()],'commit')).status,201);
  const items=Array.from({length:80},(_,i)=>bulkTech(String(9000000+i)));
  const invalid=[...items.slice(0,40),bulkTech('9999999','1111222'),...items.slice(40)];
  let res=await importReq(x,cookie,'TECNICOS',invalid,'commit');
  assert.equal(res.status,422);
  assert.equal(x.database.prepare("SELECT COUNT(*) n FROM master_personnel WHERE position='TECNICO'").get().n,0);
  res=await importReq(x,cookie,'TECNICOS',items,'commit');
  assert.equal(res.status,201);
  assert.equal(x.database.prepare("SELECT COUNT(*) n FROM master_personnel WHERE position='TECNICO'").get().n,80);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,1);
});
test('Carga masiva: 200 SAP con ceros iniciales y bloqueo integral por fila inválida o duplicada',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const items=Array.from({length:200},(_,i)=>bulkSap(String(100000+i).padStart(10,'0')));
  let res=await importReq(x,cookie,'CATALOGO',[...items,{...items[0],sap_code:'0000123999',serial_profile:'SIN INFORMACION'}],'commit');
  assert.equal(res.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,0);
  res=await importReq(x,cookie,'CATALOGO',[...items,items[1]],'commit');
  assert.equal(res.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,0);
  res=await importReq(x,cookie,'CATALOGO',items,'commit');
  assert.equal(res.status,201);assert.equal((await res.json()).inserted,200);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,200);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_audit').get().n,200);
  assert.equal(x.database.prepare("SELECT COUNT(*) n FROM master_sap_catalog WHERE sap_code LIKE '0000%'").get().n,200);
});
test('Carga masiva: protegida por rol, origen, formato y cantidad',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  let r=await importReq(x,'','SUPERVISORES',[bulkSupervisor()],'commit');
  assert.equal(r.status,401);
  r=await importReq(x,cookie,'SUPERVISORES',[bulkSupervisor()],'commit','https://origen-externo.example');
  assert.equal(r.status,403);
  const oversize=Array.from({length:1001},(_,i)=>bulkSupervisor(String(8000000+i)));
  r=await importReq(x,cookie,'SUPERVISORES',oversize,'commit');
  assert.equal(r.status,400);
  x.addUser('respaldo2@example.com','ClaveRespaldoSegura2026!');
 x.database.prepare("UPDATE app_users SET role='AUDITOR' WHERE email='admin@example.com'").run();
  r=await importReq(x,cookie,'SUPERVISORES',[bulkSupervisor()],'commit');
  assert.equal(r.status,403);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,0);
});


test('Supervisores de Cesar, Guajira y San Andrés pasan la validación masiva sin cambiar el Excel',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const rows=[
    {...bulkSupervisor('8000101','Supervisor Cesar'),department:'Cesar',zone:'Cesar'},
    {...bulkSupervisor('8000102','Supervisor Guajira'),department:'Guajira',zone:'Guajira'},
    {...bulkSupervisor('8000103','Supervisor San Andres'),department:'San Andrés',zone:'San Andrés'}
  ];
  let response=await importReq(x,cookie,'SUPERVISORES',rows,'validate');
  assert.equal(response.status,200);
  let data=await response.json();
  assert.equal(data.valid,true,JSON.stringify(data));
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,0);
  response=await importReq(x,cookie,'SUPERVISORES',rows,'commit');
  assert.equal(response.status,201);
  assert.equal((await response.json()).inserted,3);
  const departments=x.database.prepare('SELECT department FROM master_personnel ORDER BY document_number').all().map(r=>r.department);
  assert.deepEqual(departments,['CESAR','LA GUAJIRA','SAN ANDRES']);
  response=await importReq(x,cookie,'SUPERVISORES',[{...bulkSupervisor('8000104','Supervisor fuera de zona'),department:'Atlántico'}],'validate');
  data=await response.json();
  assert.equal(data.valid,false);
  assert.equal(data.errors[0].field,'Departamento');
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,3);
});


const auxiliar={
  email:'auxiliar@example.com', display_name:'Auxiliar de Operaciones',
  role:'ADMIN',document_number:'1070000123',job_title:'Auxiliar de operaciones',
  phone:'3001112233'
};
const securePassword='ClaveSeguraAuxiliar2026!';
async function createAccount(x,cookie,payload=auxiliar){
  const r=await worker.fetch(x.req('/api/usuarios',{
    method:'POST',headers:{cookie},data:payload
  }),x.env);
  assert.equal(r.status,201,'La creación administrativa debe devolver 201');
  return r.json(); 
}
async function activation(x,token,email=auxiliar.email,password=securePassword){
  return worker.fetch(x.req('/api/auth/activar',{
    method:'POST',data:{token,email,password}
  }),x.env);
}
async function signin(x,email,password){
  return worker.fetch(x.req('/api/auth/login',{
    method:'POST',data:{email,password}
  }),x.env);
}
test('Usuarios: tercero independiente de personal, administrador invitado sin clave automática',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const response=await worker.fetch(x.req('/api/usuarios',{headers:{cookie}}),x.env);
  assert.equal(response.status,200);
  const bootstrap=(await response.json()).items;
  assert.equal(bootstrap.length,1);
  assert.equal(bootstrap[0].role,'ADMIN');
  const created=await createAccount(x,cookie);
  assert.match(created.link,/^https:\/\/pulso-mintic\.pages\.dev\/activar#[A-Za-z0-9_-]{43}$/);
  assert.equal(x.database.prepare('SELECT active FROM app_users WHERE id=?').get(created.id).active,0);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM auth_passwords').get().n,1);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,0);
  const inviteHash=x.database.prepare('SELECT token_hash FROM app_user_invitations WHERE user_id=?').get(created.id).token_hash;
  assert.equal(inviteHash.length,64);
  assert.ok(!created.link.includes(inviteHash));
  const all=await worker.fetch(x.req('/api/usuarios',{headers:{cookie}}),x.env);
  const items=(await all.json()).items;
  assert.equal(items.length,2);
  assert.equal(items.find(u=>u.id===created.id).credential_status,'INVITADO');
  assert.equal(items.find(u=>u.id===created.id).job_title,'Auxiliar de operaciones');
});
test('Invitación de un uso: activa el Administrador, contraseña propia, login y control de perfiles',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const created=await createAccount(x,cookie);
  const token=created.link.split('#')[1];
  let r=await activation(x,token,'equivocado@example.com');
  assert.equal(r.status,400);
  r=await activation(x,token,auxiliar.email,'corta');
  assert.equal(r.status,400);
  r=await activation(x,token);
  assert.equal(r.status,200);
  assert.equal((await r.json()).ok,true);
  assert.equal(x.database.prepare('SELECT active FROM app_users WHERE id=?').get(created.id).active,1);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM auth_passwords').get().n,2);
  r=await activation(x,token);
  assert.equal(r.status,400,'No se debe reutilizar una invitación');
  const login=await signin(x,auxiliar.email,securePassword);
  assert.equal(login.status,200);
  assert.equal((await login.json()).user.role,'ADMIN');
  const newCookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await worker.fetch(x.req('/maestras',{headers:{cookie:newCookie}}),x.env)).status,200);
  assert.equal(x.database.prepare("SELECT COUNT(*) n FROM app_user_audit WHERE action='ACEPTAR_INVITACION'").get().n,1);
});
test('Invitación vencida y nueva invitación invalidan enlace anterior, sin activar cuentas',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const first=await createAccount(x,cookie);
  const token=first.link.split('#')[1];
  const rerun=await worker.fetch(x.req('/api/usuarios/invitaciones',{
    method:'POST',headers:{cookie},data:{id:first.id}
  }),x.env);
  assert.equal(rerun.status,201);
  const newer=(await rerun.json()).link.split('#')[1];
  assert.notEqual(newer,token);
  assert.equal((await activation(x,token)).status,400);
  x.database.prepare('UPDATE app_user_invitations SET expires_at=0 WHERE user_id=?').run(first.id);
  assert.equal((await activation(x,newer)).status,400);
  assert.equal(x.database.prepare('SELECT active FROM app_users WHERE id=?').get(first.id).active,0);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM auth_passwords').get().n,1);
});
test('Cambio de perfil o desactivación revoca las sesiones previas',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const created=await createAccount(x,cookie,{...auxiliar,role:'SUPERVISOR'});
  assert.equal((await activation(x,created.link.split('#')[1])).status,200);
  const session=await signin(x,auxiliar.email,securePassword);
  assert.equal(session.status,200);
  const userCookie=session.headers.get('set-cookie').split(';')[0];
  assert.equal((await worker.fetch(x.req('/inicio',{headers:{cookie:userCookie}}),x.env)).status,200);
  const changed=await worker.fetch(x.req('/api/usuarios',{
    method:'PATCH',headers:{cookie},data:{id:created.id,role:'ADMIN'}
  }),x.env);
  assert.equal(changed.status,200);
  assert.equal((await worker.fetch(x.req('/inicio',{headers:{cookie:userCookie}}),x.env)).status,302);
  const newSession=await signin(x,auxiliar.email,securePassword);
  assert.equal((await newSession.json()).user.role,'ADMIN');
  const cookie2=newSession.headers.get('set-cookie').split(';')[0];
  const disable=await worker.fetch(x.req('/api/usuarios',{
    method:'PATCH',headers:{cookie},data:{id:created.id,active:false}
  }),x.env);
  assert.equal(disable.status,200);
  assert.equal((await worker.fetch(x.req('/inicio',{headers:{cookie:cookie2}}),x.env)).status,302);
  assert.equal((await signin(x,auxiliar.email,securePassword)).status,401);
});
test('Último administrador protegido por API y trigger SQL, sin perder acceso',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const id=x.database.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
  const patch=async data=>worker.fetch(x.req('/api/usuarios',{method:'PATCH',headers:{cookie},data:{id,...data}}),x.env);
  assert.equal((await patch({role:'AUDITOR'})).status,409);
  assert.equal((await patch({active:false})).status,409);
  assert.throws(()=>x.database.prepare("UPDATE app_users SET active=0 WHERE id=?").run(id),/ULTIMO_ADMINISTRADOR/);
  assert.throws(()=>x.database.prepare("UPDATE app_users SET role='TECNICO' WHERE id=?").run(id),/ULTIMO_ADMINISTRADOR/);
  assert.equal((await worker.fetch(x.req('/inicio',{headers:{cookie}}),x.env)).status,200);
});
test('Solo ADMIN gestiona Usuarios; bloquea datos duplicados, otro origen y habilitar sin contraseña',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const created=await createAccount(x,cookie);
  const second=await worker.fetch(x.req('/api/usuarios',{
    method:'POST',headers:{cookie},data:{...auxiliar,email:'otra@example.com'}
  }),x.env);
  assert.equal(second.status,409,'No se permite identificación duplicada');
  const duplicate=await worker.fetch(x.req('/api/usuarios',{
    method:'POST',headers:{cookie},data:{...auxiliar,document_number:'11113333'}
  }),x.env);
  assert.equal(duplicate.status,409,'No se permite correo duplicado');
  const enable=await worker.fetch(x.req('/api/usuarios',{
    method:'PATCH',headers:{cookie},data:{id:created.id,active:true}
  }),x.env);
  assert.equal(enable.status,409);
  const other=await worker.fetch(x.req('/api/usuarios',{
    method:'POST',origin:'https://externo.example',headers:{cookie},data:auxiliar
  }),x.env);
  assert.equal(other.status,403);
  assert.equal((await worker.fetch(x.req('/api/usuarios'),x.env)).status,401);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,2);
});
test('Consulta/Auditor no puede abrir Maestras ni crear administradores',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const created=await createAccount(x,cookie,{...auxiliar,role:'AUDITOR'});
  assert.equal((await activation(x,created.link.split('#')[1])).status,200);
  const login=await signin(x,auxiliar.email,securePassword);
  const readonlyCookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await worker.fetch(x.req('/api/usuarios',{headers:{cookie:readonlyCookie}}),x.env)).status,403);
  assert.equal((await worker.fetch(x.req('/maestras',{headers:{cookie:readonlyCookie}}),x.env)).status,302);
  assert.equal((await worker.fetch(x.req('/api/usuarios',{method:'POST',headers:{cookie:readonlyCookie},data:auxiliar}),x.env)).status,403);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,2);
});
test('Restablecimiento de contraseña revoca la anterior y las sesiones existentes',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const created=await createAccount(x,cookie);
  await activation(x,created.link.split('#')[1]);
  const login=await signin(x,auxiliar.email,securePassword);
  assert.equal(login.status,200);
  const previousCookie=login.headers.get('set-cookie').split(';')[0];
  const reset=await worker.fetch(x.req('/api/usuarios/invitaciones',{
    method:'POST',headers:{cookie},data:{id:created.id}
  }),x.env);
  assert.equal(reset.status,201);
  const data=await reset.json();
  assert.equal(data.purpose,'RESTABLECER');
  assert.equal((await activation(x,data.link.split('#')[1],auxiliar.email,'ClaveNuevaSegura2026!')).status,200);
  assert.equal((await worker.fetch(x.req('/api/auth/me',{headers:{cookie:previousCookie}}),x.env)).status,401);
  assert.equal((await signin(x,auxiliar.email,securePassword)).status,401);
  assert.equal((await signin(x,auxiliar.email,'ClaveNuevaSegura2026!')).status,200);
});


test('Desactivar una cuenta invalida invitaciones de restablecimiento pendientes',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const created=await createAccount(x,cookie);
  assert.equal((await activation(x,created.link.split('#')[1])).status,200);
  const newInvite=await worker.fetch(x.req('/api/usuarios/invitaciones',{
    method:'POST',headers:{cookie},data:{id:created.id}
  }),x.env);
  assert.equal(newInvite.status,201);
  const token=(await newInvite.json()).link.split('#')[1];
  const disable=await worker.fetch(x.req('/api/usuarios',{
    method:'PATCH',headers:{cookie},data:{id:created.id,active:false}
  }),x.env);
  assert.equal(disable.status,200);
  assert.equal((await activation(x,token,auxiliar.email,'OtraClaveSegura2026!')).status,400);
  assert.equal(x.database.prepare('SELECT active FROM app_users WHERE id=?').get(created.id).active,0);
});


function createPersonnelRecords(x,count=46){
 const adminId=x.database.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 const ins=x.database.prepare("INSERT INTO master_personnel "+
  "(id,document_number,full_name,position,department,zone,city_base,supervisor_id,email,phone,is_active,created_by,updated_by) "+
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
 const bosses=[];
 for(let i=0;i<count;i++){
   const boss=i<3;
   const id=randomUUID(),doc=String(10000000+i);
   ins.run(id,doc,'Colaborador '+i,boss?'SUPERVISOR':'TECNICO',
     'CESAR',boss?'Zona Cesar':'',boss?'':'Valledupar',
     boss?null:bosses[i%3],
     'colaborador'+i+'@example.com','3001112233',1,adminId,adminId);
   if(boss)bosses.push(id);
 }
 return x.database.prepare('SELECT id,position FROM master_personnel ORDER BY document_number').all();
}
async function associate(x,cookie,assignments,mode='validate'){
  return worker.fetch(x.req('/api/usuarios/vincular-personal',{
    method:'POST',data:{mode,assignments},headers:{cookie}
  }),x.env);
}
test('Vinculación selectiva: sólo el personal autorizado obtiene usuario y un enlace individual',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const people=createPersonnelRecords(x,4);
 const chosen=[{personnel_id:people[0].id,role:'ADMIN'}];
 let response=await associate(x,cookie,chosen);
 assert.equal(response.status,200);assert.equal((await response.json()).valid,true);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,1);
 response=await associate(x,cookie,chosen,'commit');
 assert.equal(response.status,201);
 const body=await response.json();
 assert.equal(body.created,1);
 assert.match(body.invitations[0].link,/\/activar#[A-Za-z0-9_-]{43}$/);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,4);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_personnel_user_links').get().n,1);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM auth_passwords').get().n,1);
 const list=await worker.fetch(x.req('/api/maestras/personal',{headers:{cookie}}),x.env);
 const items=(await list.json()).items;
 assert.equal(items.find(p=>p.id===people[0].id).access_role,'ADMIN');
 assert.equal(items.find(p=>p.id===people[1].id).access_user_id,null);
 response=await associate(x,cookie,chosen,'commit');
 assert.equal(response.status,422);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,2);
});
test('Vinculación masiva de 46 colaboradores con perfiles según cargo: transacción completa',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const people=createPersonnelRecords(x,46);
 const assignments=people.map(p=>({personnel_id:p.id,role:p.position}));
 let r=await associate(x,cookie,assignments,'validate');
 assert.equal(r.status,200);
 assert.equal((await r.json()).valid,true);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_personnel_user_links').get().n,0);
 r=await associate(x,cookie,assignments,'commit');
 assert.equal(r.status,201);
 const body=await r.json();
 assert.equal(body.invitations.length,46);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,46);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,47);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_user_details').get().n,46);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_personnel_user_links').get().n,46);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_user_invitations').get().n,46);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM auth_passwords').get().n,1);
 assert.equal(x.database.prepare("SELECT COUNT(*) n FROM app_users WHERE role='SUPERVISOR'").get().n,3);
 assert.equal(x.database.prepare("SELECT COUNT(*) n FROM app_users WHERE role='TECNICO'").get().n,43);
 const first=body.invitations[0];
 const activate=await worker.fetch(x.req('/api/auth/activar',{
  method:'POST',data:{token:first.link.split('#')[1],email:first.email,password:'ClaveSeguraNuevo2026!'}
 }),x.env);
 assert.equal(activate.status,200);
 assert.equal((await worker.fetch(x.req('/api/auth/login',{
  method:'POST',data:{email:first.email,password:'ClaveSeguraNuevo2026!'}
 }),x.env)).status,200);
});
test('Bloqueo integral ante correos inválidos y cuentas preexistentes: nada se importa',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const people=createPersonnelRecords(x,6);
 x.database.prepare("UPDATE master_personnel SET email='' WHERE id=?").run(people[2].id);
 const all=people.map(p=>({personnel_id:p.id,role:'ADMIN'}));
 let r=await associate(x,cookie,all,'commit');
 assert.equal(r.status,422);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,1);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_personnel_user_links').get().n,0);
 x.database.prepare("UPDATE master_personnel SET email='admin@example.com' WHERE id=?").run(people[2].id);
 r=await associate(x,cookie,all,'validate');
 const body=await r.json();
 assert.equal(body.valid,false);
 assert.ok(body.errors.some(e=>e.error==='CORREO_YA_TIENE_USUARIO'));
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_user_invitations').get().n,0);
});
test('Vinculación: restringida a administradores, sin autenticación ni origen externo',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const people=createPersonnelRecords(x,1);
 const selections=[{personnel_id:people[0].id,role:'ADMIN'}];
 assert.equal((await associate(x,'',selections,'commit')).status,401);
 const other=await worker.fetch(x.req('/api/usuarios/vincular-personal',{
  method:'POST',origin:'https://intruso.example',data:{mode:'commit',assignments:selections},headers:{cookie}
 }),x.env);
 assert.equal(other.status,403);
 assert.equal((await associate(x,cookie,[...selections,...selections],'commit')).status,400);
 const extra=Array.from({length:81},()=>selections[0]);
 assert.equal((await associate(x,cookie,extra,'commit')).status,400);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM app_users').get().n,1);
});


const warehouse=(centro='0001',almacen='0001',administration='PROPIA',department='Cesar')=>({
  centro,almacen,description:'Bodega de prueba '+centro+' - '+almacen,
  administration,department,is_active:true
});
async function warehouseApi(x,cookie,method='GET',data=null,query=''){
  return worker.fetch(x.req('/api/maestras/bodegas'+query,{
    method,headers:{cookie},...(data?{data}:{})
  }),x.env);
}
async function warehouseImport(x,cookie,rows,mode='validate',origin=root){
  return worker.fetch(x.req('/api/maestras/bodegas/import',{
    method:'POST',origin,headers:{cookie},data:{kind:'BODEGAS',mode,rows}
  }),x.env);
}
test('Cuarta maestra empieza vacía; acceso exclusivo ADMIN y lectura filtrada',async()=>{
  const x=setup();
  assert.equal((await warehouseApi(x,'')).status,401);
  assert.equal((await warehouseImport(x,'',[warehouse()])).status,401);
  const cookie=await adminCookie(x);
  const res=await warehouseApi(x,cookie);
  assert.equal(res.status,200);
  assert.deepEqual((await res.json()).items,[]);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,0);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouse_audit').get().n,0);
});
test('Centro y almacén forman clave única, preservan ceros y distinguen PROPIA de ALIADO',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  let r=await warehouseApi(x,cookie,'POST',warehouse('00100','0001','PROPIA','Cesar'));
  assert.equal(r.status,201);
  const own=(await r.json()).id;
  r=await warehouseApi(x,cookie,'POST',warehouse('00100','0002','ALIADO','Guajira'));
  assert.equal(r.status,201);
  const other=(await r.json()).id;
  r=await warehouseApi(x,cookie,'POST',warehouse('00100','0001','ALIADO','Cesar'));
  assert.equal(r.status,409);
  r=await warehouseApi(x,cookie,'GET',null,'?administration=PROPIA&active=1');
  assert.equal(r.status,200);
  let items=(await r.json()).items;
  assert.equal(items.length,1);
  assert.equal(items[0].id,own);
  assert.equal(items[0].centro,'00100');
  assert.equal(items[0].almacen,'0001');
  assert.equal(items[0].department,'CESAR');
  r=await warehouseApi(x,cookie,'GET',null,'?administration=ALIADO&active=1');
  items=(await r.json()).items;
  assert.equal(items.length,1);
  assert.equal(items[0].id,other);
  assert.equal(items[0].department,'LA GUAJIRA');
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,2);
});
test('Editar y desactivar un almacén conserva su identidad y auditoría',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const created=await warehouseApi(x,cookie,'POST',warehouse());
  const id=(await created.json()).id;
  let r=await warehouseApi(x,cookie,'PATCH',{id,description:'Bodega corregida',department:'San Andrés'});
  assert.equal(r.status,200);
  r=await warehouseApi(x,cookie,'PATCH',{id,is_active:false});
  assert.equal(r.status,200);
  r=await warehouseApi(x,cookie,'GET',null,'?administration=PROPIA&active=1');
  assert.equal((await r.json()).items.length,0);
  r=await warehouseApi(x,cookie,'GET');
  let items=(await r.json()).items;
  assert.equal(items.length,1);
  assert.equal(items[0].description,'Bodega corregida');
  assert.equal(items[0].department,'SAN ANDRES');
  assert.equal(items[0].is_active,0);
  r=await warehouseApi(x,cookie,'PATCH',{id,centro:'9999'});
  assert.equal(r.status,409);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouse_audit').get().n,3);
});
test('Excel de Bodegas y Aliados valida primero y registra lote completo o ninguno',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const rows=Array.from({length:120},(_,i)=>warehouse(
    String(1000+Math.floor(i/5)),String(i%5).padStart(4,'0'),i%2?'ALIADO':'PROPIA',
    i%3===0?'Cesar':i%3===1?'La Guajira':'San Andrés'
  ));
  let r=await warehouseImport(x,cookie,rows);
  assert.equal(r.status,200);
  assert.equal((await r.json()).valid,true);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,0);
  r=await warehouseImport(x,cookie,[...rows,{...warehouse('9999','0001'),administration:'OTRA'}],'commit');
  assert.equal(r.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,0);
  r=await warehouseImport(x,cookie,[...rows,rows[1]],'commit');
  assert.equal(r.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,0);
  r=await warehouseImport(x,cookie,rows,'commit');
  assert.equal(r.status,201);
  assert.equal((await r.json()).inserted,120);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,120);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouse_audit').get().n,120);
  assert.equal(x.database.prepare("SELECT COUNT(*) n FROM master_logistics_locations WHERE administration='PROPIA'").get().n,60);
  r=await warehouseImport(x,cookie,rows,'commit');
  assert.equal(r.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,120);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,0);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,0);
});
test('No permite más de 1000 filas, origen externo ni perfiles sin administración',async()=>{
  const x=setup(),cookie=await adminCookie(x);
  const rows=[warehouse()];
  assert.equal((await warehouseImport(x,cookie,rows,'commit','https://externo.example')).status,403);
  assert.equal((await warehouseImport(x,cookie,Array.from({length:1001},()=>warehouse()),'commit')).status,400);
  x.addUser('respaldo-bodega@example.com','ClaveRespaldoSegura2026!');
  x.database.prepare("UPDATE app_users SET role='AUDITOR' WHERE email='admin@example.com'").run();
  assert.equal((await warehouseApi(x,cookie)).status,403);
  assert.equal((await warehouseImport(x,cookie,rows,'commit')).status,403);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,0);
});


test('Aliados pueden estar en Cundinamarca, Bogotá y departamentos nacionales; propias solo en Costa R1',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const examples=[
   warehouse('C906','U001','ALIADO','Cundinamarca'),
   warehouse('C906','L044','ALIADO','Cundinamarca'),
   warehouse('C906','L043','ALIADO','Cundinamarca'),
   warehouse('C907','0001','ALIADO','Bogotá, D.C.'),
   warehouse('C908','0010','ALIADO','Atlántico'),
   warehouse('C901','A221','PROPIA','San Andrés'),
   warehouse('C903','A223','PROPIA','Cesar'),
   warehouse('C903','A221','PROPIA','La Guajira')
 ];
 const validate=await warehouseImport(x,cookie,examples,'validate');
 assert.equal(validate.status,200);
 assert.equal((await validate.json()).valid,true);
 const saved=await warehouseImport(x,cookie,examples,'commit');
 assert.equal(saved.status,201);
 assert.equal((await saved.json()).inserted,8);
 const ally=(await (await warehouseApi(x,cookie,'GET',null,'?administration=ALIADO&active=1')).json()).items;
 assert.equal(ally.length,5);
 assert.equal(ally.filter(x=>x.department==='CUNDINAMARCA').length,3);
 assert.ok(ally.some(x=>x.department==='BOGOTA D.C.'));
 assert.ok(ally.some(x=>x.department==='ATLANTICO'));
 const own=(await (await warehouseApi(x,cookie,'GET',null,'?administration=PROPIA&active=1')).json()).items;
 assert.equal(own.length,3);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,8);
});
test('No permite bodega PROPIA en Cundinamarca, pero sí ALIADO; no permite departamentos falsos',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const invalidOwn=warehouse('C001','001','PROPIA','Cundinamarca');
 let r=await warehouseImport(x,cookie,[invalidOwn],'validate');
 assert.equal(r.status,200);
 let p=await r.json();
 assert.equal(p.valid,false);
 assert.equal(p.errors[0].field,'Departamento');
 assert.match(p.errors[0].message,/PROPIAS/);
 r=await warehouseApi(x,cookie,'POST',invalidOwn);
 assert.equal(r.status,400);
 r=await warehouseImport(x,cookie,[warehouse('C002','001','ALIADO','Departamento inventado')],'commit');
 assert.equal(r.status,422);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,0);
});
test('Migración nacional conserva IDs, estado, fechas y auditoría, es repetible y respeta claves foráneas',async()=>{
 const x=setup({legacyWarehouse:true}),cookie=await adminCookie(x);
 let r=await warehouseApi(x,cookie,'POST',warehouse('C001','A001','PROPIA','Cesar'));
 assert.equal(r.status,201);
 const id=(await r.json()).id;
 await warehouseApi(x,cookie,'PATCH',{id,is_active:false});
 const old=x.database.prepare('SELECT * FROM master_logistics_locations WHERE id=?').get(id);
 const audit=x.database.prepare('SELECT * FROM master_warehouse_audit WHERE warehouse_id=? ORDER BY created_at').all(id);
 assert.equal(audit.length,2);
 x.database.exec(sql8);
 const after=x.database.prepare('SELECT * FROM master_logistics_locations WHERE id=?').get(id);
 assert.deepEqual(after,old);
 assert.deepEqual(x.database.prepare('SELECT * FROM master_warehouse_audit WHERE warehouse_id=? ORDER BY created_at').all(id),audit);
 assert.deepEqual(x.database.prepare('PRAGMA foreign_key_check').all(),[]);
 x.database.exec(sql8);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,1);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouse_audit').get().n,2);
 r=await warehouseApi(x,cookie,'POST',warehouse('C906','U001','ALIADO','Cundinamarca'));
 assert.equal(r.status,201);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_logistics_locations WHERE department=?').get('CUNDINAMARCA').n,1);
});
test('La maestra Personal sigue limitada a los 3 departamentos operativos',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const r=await worker.fetch(x.req('/api/maestras/personal',{
   method:'POST',headers:{cookie},
   data:{...supervisor,document_number:'10334455',department:'Cundinamarca'}
 }),x.env);
 assert.equal(r.status,400);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,0);
});


function ingFixtures(x){
 const db=x.database,actor=db.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 const source=randomUUID(),destination=randomUUID(),badDest=randomUUID();
 for(const [id,centro,admin,active,department] of [
  [source,'C100','ALIADO',1,'CUNDINAMARCA'],
  [destination,'C200','PROPIA',1,'CESAR'],
  [badDest,'C300','PROPIA',0,'CESAR']])
  db.prepare('INSERT INTO master_logistics_locations(id,centro,almacen,description,administration,department,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id,centro,'A001','Bodega '+centro,admin,department,active,actor,actor);
 const sapSerial='SAP-10001',sapBulk='SAP-10002';
 for(const [sap,profile] of [[sapSerial,'CON PERFIL DE SERIE'],[sapBulk,'SIN PERFIL DE SERIE']])
  db.prepare('INSERT INTO master_sap_catalog(id,sap_code,description,item_type,serial_profile,unit,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(),sap,'Equipo '+sap,'EQUIPO',profile,'UND',1,actor,actor);
 return {source,destination,badDest,sapSerial,sapBulk};
}
async function ingApi(x,cookie,path='',method='GET',data=null,origin=root){
 return worker.fetch(x.req('/api/ingresos'+path,{
  method,origin,headers:{cookie,...(method!=='GET'?{origin}:{})},...(data===null?{}:{data})
 }),x.env);
}
async function ingNew(x,cookie){
 const response=await ingApi(x,cookie,'','POST');
 assert.equal(response.status,201);
 return (await response.json()).id;
}
function ingPayload(f){
 return {document:{
  document_type:'NUMERO_PEDIDO',document_number:'PED-2026-1',
  document_date:'2026-11-06',received_date:'2026-11-07',
  source_id:f.source,destination_id:f.destination,notes:'PDF opcional'
 },items:[
  {sap_code:f.sapSerial,serial:'EQ-001',quantity:1,lot:'VALORADO',reception_state:'NUEVO',notes:''},
  {sap_code:f.sapBulk,serial:'',quantity:5,lot:'NOVALORADO',reception_state:'REMANUFACTURADO',notes:''}
 ]};
}


test('Ingresos: eliminar borrador con ítems y PDF limpia datos sin mover inventario',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x),id=await ingNew(x,cookie);
 const payload=ingPayload(f);
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',payload)).status,200);
 const pdf=new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
 const upload=new Request(root+'/api/ingresos/'+id+'/soporte',{
   method:'POST',headers:{cookie,origin:root,'Content-Type':'application/pdf','x-file-name':'pedido.pdf'},body:pdf
 });
 assert.equal((await worker.fetch(upload,x.env)).status,201);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM ingress_items WHERE ingress_id=?').get(id).n,2);
 assert.ok(x.database.prepare('SELECT COUNT(*) n FROM ingress_support_chunks WHERE ingress_id=?').get(id).n>0);
 assert.equal((await ingApi(x,cookie,'/'+id,'DELETE',null,'https://externo.example')).status,403);
 assert.equal((await ingApi(x,'','/'+id,'DELETE')).status,401);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM ingress_documents WHERE id=?').get(id).n,1);
 const erased=await ingApi(x,cookie,'/'+id,'DELETE');
 assert.equal(erased.status,200);
 assert.equal((await erased.json()).deleted,true);
 for(const table of ['ingress_documents','ingress_items','ingress_support_chunks','ingress_audit'])
   assert.equal(x.database.prepare('SELECT COUNT(*) n FROM '+table+' WHERE '+(table==='ingress_documents'?'id':'ingress_id')+'=?').get(id).n,0,table);
 for(const table of ['inventory_serials','inventory_movements','inventory_bulk_stock'])
   assert.equal(x.database.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,table);
 assert.equal((await ingApi(x,cookie,'/'+id)).status,404);
 assert.equal((await ingApi(x,cookie,'/'+id,'DELETE')).status,404);
 assert.equal((await (await ingApi(x,cookie)).json()).items.length,0);
});
test('Ingresos: un ingreso REGISTRADO no se puede eliminar y mantiene existencias',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x),id=await ingNew(x,cookie);
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',ingPayload(f))).status,200);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 const before={
  serials:x.database.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,
  movements:x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,
  bulk:x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,
  audit:x.database.prepare('SELECT COUNT(*) n FROM ingress_audit WHERE ingress_id=?').get(id).n
 };
 const rejected=await ingApi(x,cookie,'/'+id,'DELETE');
 assert.equal(rejected.status,409);
 assert.equal((await rejected.json()).error,'INGRESO_INMUTABLE');
 assert.equal(x.database.prepare('SELECT status FROM ingress_documents WHERE id=?').get(id).status,'REGISTRADO');
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM ingress_items WHERE ingress_id=?').get(id).n,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,before.serials);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,before.movements);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,before.bulk);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM ingress_audit WHERE ingress_id=?').get(id).n,before.audit);
});
test('Ingresos: se puede descartar un borrador vacío sin afectar otros ingresos',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const registered=await ingNew(x,cookie);
 await ingApi(x,cookie,'/'+registered,'PATCH',ingPayload(f));
 assert.equal((await ingApi(x,cookie,'/'+registered+'/confirmar','POST')).status,200);
 const empty=await ingNew(x,cookie);
 assert.equal((await ingApi(x,cookie,'/'+empty,'DELETE')).status,200);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
 assert.equal(x.database.prepare('SELECT status FROM ingress_documents WHERE id=?').get(registered).status,'REGISTRADO');
 const listing=(await (await ingApi(x,cookie)).json()).items;
 assert.equal(listing.length,1);assert.equal(listing[0].status,'REGISTRADO');
});
test('Interfaz Ingresos: muestra Eliminar solo en borradores, con confirmación',()=>{
 const source=fs.readFileSync(new URL('../pages/ingresos.js',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../pages/ingresos.html',import.meta.url),'utf8');
 assert.match(source,/if\(record.status==='BORRADOR'\)\{\s*const remove=elt\('button','Eliminar'/);
 assert.match(source,/window.confirm\(/);
 assert.match(source,/api\('\/'\+record.id,\{method:'DELETE'\}\)/);
 assert.match(source,/list=list.filter\(entry=>entry.id!==record.id\)/);
 assert.match(html,/id="ingress-list-message"/);
});
test('Ingresos: único tipo de documento permitido Número de Pedido',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie),payload=ingPayload(f);
 let result=await ingApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal(result.status,200);
 assert.equal((await result.json()).validation.valid,true);
 const other=ingPayload(f);other.document.document_type='FACTURA';
 result=await ingApi(x,cookie,'/'+id,'PATCH',other);
 assert.equal(result.status,400);
 const actor=x.database.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 x.database.prepare('UPDATE ingress_documents SET document_type=? WHERE id=?').run('FACTURA',id);
 assert.throws(()=>x.database.prepare("UPDATE ingress_documents SET status='REGISTRADO',registered_by=? WHERE id=?").run(actor,id),/DOCUMENTO_INCOMPLETO/);
 const saved=await ingApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal(saved.status,200);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 assert.equal(x.database.prepare('SELECT document_type FROM ingress_documents WHERE id=?').get(id).document_type,'NUMERO_PEDIDO');
});
test('Ingresos: acceso de administrador y borradores sin movimientos',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 assert.equal((await ingApi(x,'')).status,401);
 assert.equal((await ingApi(x,cookie,'/catalogos')).status,200);
 assert.equal((await ingApi(x,cookie,'','POST',null,'https://externo.example')).status,403);
 const id=await ingNew(x,cookie);
 let payload=ingPayload(f);
 payload.document.document_number='';
 payload.items[0].serial='';
 payload.items[0].quantity=0;
 const save=await ingApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal(save.status,200);
 const v=(await save.json()).validation;
 assert.equal(v.valid,false);
 assert.ok(v.errors.some(y=>y.code==='SERIAL_OBLIGATORIO'));
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,422);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,0);
});
test('Ingresos: confirma sin PDF y registra serial, cantidades y movimiento en una transacción',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie);
 const save=await ingApi(x,cookie,'/'+id,'PATCH',ingPayload(f));
 assert.equal(save.status,200);
 const v=(await save.json()).validation;
 assert.equal(v.valid,true);
 assert.ok(v.warnings.some(y=>y.code==='PDF_OPCIONAL'));
 const confirm=await ingApi(x,cookie,'/'+id+'/confirmar','POST');
 assert.equal(confirm.status,200);
 assert.match((await confirm.json()).reference,/^ING-\d{8}-[A-F0-9]{8}$/);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,1);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
 assert.equal(x.database.prepare("SELECT COUNT(*) n FROM ingress_audit WHERE action='REGISTRAR'").get().n,1);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,409);
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',ingPayload(f))).status,409);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
});

test('Ingresos registrados: la consulta de detalle no reporta seriales ya contabilizados',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie),payload=ingPayload(f);
 await ingApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 const response=await ingApi(x,cookie,'/'+id);
 assert.equal(response.status,200);
 const detail=await response.json();
 assert.equal(detail.document.status,'REGISTRADO');
 assert.equal(detail.validation,null);
 assert.equal(detail.items.length,2);
 assert.equal(detail.items[0].serial,'EQ-001');
 assert.equal(detail.items[0].lot,'VALORADO');
 assert.equal(detail.items[0].reception_state,'NUEVO');
 assert.equal(detail.items[0].sap_description,'Equipo SAP-10001');
 assert.equal((await ingApi(x,cookie,'/'+id+'/validar')).status,409);
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',payload)).status,409);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
});
test('Interfaz de detalle de ingresos: historial sin pasos ni controles de modificación',()=>{
 const source=fs.readFileSync(new URL('../pages/ingresos.js',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../pages/ingresos.html',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../pages/ingresos.css',import.meta.url),'utf8');
 assert.match(source,/if\(data.document.status==='REGISTRADO'\)\{\s*showRegisteredDetail\(data\);\s*return;/);
 assert.match(source,/\$\('ingress-wizard'\).hidden=true;\s*\$\('ingress-detail'\).hidden=false/);
 assert.match(source,/const body=\$\('ingress-detail-items'\);body.replaceChildren\(\)/);
 assert.match(source,/\$\('ingress-detail-back'\).addEventListener\('click'/);
 assert.match(html,/id="ingress-detail" class="ingress-detail" hidden/);
 const area=html.split('id="ingress-detail"')[1].split('</section>')[0];
 assert.doesNotMatch(area,/ingress-steps|ing-confirm|ing-validation|ing-item-edit/);
 assert.match(css,/\.ingress-detail\[hidden\]/);
});
test('Ingresos: serial repetido bloquea segundo documento sin sumar cantidades',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const a=await ingNew(x,cookie);
 await ingApi(x,cookie,'/'+a,'PATCH',ingPayload(f));
 assert.equal((await ingApi(x,cookie,'/'+a+'/confirmar','POST')).status,200);
 const b=await ingNew(x,cookie);
 await ingApi(x,cookie,'/'+b,'PATCH',ingPayload(f));
 const blocked=await ingApi(x,cookie,'/'+b+'/confirmar','POST');
 assert.equal(blocked.status,422);
 assert.ok((await blocked.json()).validation.errors.some(y=>y.code==='SERIAL_EXISTENTE'));
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
});

test('Ingresos: SAP sin perfil puede registrar serial interno único sin sumar inventario a granel',async()=>{
  const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
  const id=await ingNew(x,cookie),payload=ingPayload(f);
  payload.document.notes='';
  payload.items=[
    {sap_code:f.sapSerial,serial:'EQ-002',quantity:1,lot:'VALORADO',reception_state:'NUEVO',notes:''},
    {sap_code:f.sapBulk,serial:'INT-SAP10002-0001',quantity:1,lot:'NOVALORADO',reception_state:'REMANUFACTURADO',notes:''},
    {sap_code:f.sapBulk,serial:'INT-SAP10002-0002',quantity:1,lot:'NOVALORADO',reception_state:'REMANUFACTURADO',notes:''}
  ];
  const saved=await ingApi(x,cookie,'/'+id,'PATCH',payload);
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).validation.valid,true);
  assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
  assert.deepEqual(
    x.database.prepare('SELECT serial FROM inventory_serials ORDER BY serial').all().map(x=>x.serial),
    ['EQ-002','INT-SAP10002-0001','INT-SAP10002-0002']);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_bulk_stock').get().n,0);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,3);
  assert.equal(x.database.prepare('SELECT notes FROM ingress_documents WHERE id=?').get(id).notes,'');
});
test('Ingresos: identificador interno duplicado o con cantidad mayor de uno bloquea el registro',async()=>{
  const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
  const id=await ingNew(x,cookie),payload=ingPayload(f);
  payload.items=[{sap_code:f.sapBulk,serial:'INT-MATERIAL-01',quantity:2,lot:'VALORADO',reception_state:'NUEVO',notes:''}];
  let result=await ingApi(x,cookie,'/'+id,'PATCH',payload);
  assert.equal(result.status,200);
  assert.ok((await result.json()).validation.errors.some(x=>x.code==='CANTIDAD_SERIAL'));
  assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,422);
  const actor=x.database.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
  assert.throws(()=>x.database.prepare("UPDATE ingress_documents SET status='REGISTRADO',registered_by=? WHERE id=?").run(actor,id),/CANTIDAD_SERIAL/);
  payload.items=[{sap_code:f.sapBulk,serial:'INT-MATERIAL-01',quantity:1,lot:'VALORADO',reception_state:'NUEVO',notes:''},
                 {sap_code:f.sapBulk,serial:'int-material-01',quantity:1,lot:'VALORADO',reception_state:'NUEVO',notes:''}];
  result=await ingApi(x,cookie,'/'+id,'PATCH',payload);
  assert.ok((await result.json()).validation.errors.some(x=>x.code==='SERIAL_REPETIDO'));
  assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,422);
  payload.items.pop();
  await ingApi(x,cookie,'/'+id,'PATCH',payload);
  assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
  const another=await ingNew(x,cookie);
  await ingApi(x,cookie,'/'+another,'PATCH',payload);
  const denied=await ingApi(x,cookie,'/'+another+'/confirmar','POST');
  assert.equal(denied.status,422);
  assert.ok((await denied.json()).validation.errors.some(x=>x.code==='SERIAL_EXISTENTE'));
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,1);
});

test('Ingresos: exige lote y recepción válidos antes de registrar, incluso por SQL directo',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie),payload=ingPayload(f);
 payload.items[0].lot='';
 payload.items[1].reception_state='';
 const saved=await ingApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal(saved.status,200);
 const v=(await saved.json()).validation;
 assert.equal(v.valid,false);
 assert.ok(v.errors.some(e=>e.code==='LOTE_INVALIDO'));
 assert.ok(v.errors.some(e=>e.code==='ESTADO_RECEPCION_INVALIDO'));
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,422);
 const actor=x.database.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 assert.throws(()=>x.database.prepare("UPDATE ingress_documents SET status='REGISTRADO',registered_by=? WHERE id=?").run(actor,id),/LOTE_INVALIDO/);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 payload.items[0].lot='VALORADO';payload.items[1].reception_state='NUEVO';
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',payload)).status,200);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
});
test('Ingresos: registra lote, recepción y estados automáticos por unidad, sin modificar registros anteriores',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x),id=await ingNew(x,cookie);
 const payload=ingPayload(f);payload.document.notes='';
 const saved=await ingApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal((await saved.json()).validation.valid,true);
 const lines=x.database.prepare('SELECT lot,reception_state,physical_state,availability_state,quantity FROM ingress_items WHERE ingress_id=? ORDER BY position').all(id);
 assert.deepEqual(lines.map(x=>[x.lot,x.reception_state,x.physical_state,x.availability_state,x.quantity]),[
  ['VALORADO','NUEVO','BUENO','DISPONIBLE',1],
  ['NOVALORADO','REMANUFACTURADO','BUENO','DISPONIBLE',5]
 ]);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 const serial=x.database.prepare('SELECT lot,reception_state,physical_state,status FROM inventory_serials WHERE serial=?').get('EQ-001');
 assert.deepEqual([serial.lot,serial.reception_state,serial.physical_state,serial.status],['VALORADO','NUEVO','BUENO','DISPONIBLE']);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
 assert.equal(x.database.prepare('SELECT notes FROM ingress_documents WHERE id=?').get(id).notes,'');
});
test('Migración de clasificación: conserva el historial sin inventar lotes ni estados históricos',()=>{
 const x=setup();
 const columns=x.database.prepare("SELECT name FROM pragma_table_info('ingress_items')").all().map(x=>x.name);
 assert.ok(['lot','reception_state','physical_state','availability_state'].every(x=>columns.includes(x)));
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,0);
});
test('Ingresos: origen y destino deben corresponder a ALIADO y PROPIA activos',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie),payload=ingPayload(f);
 payload.document.source_id=f.destination;
 payload.document.destination_id=f.badDest;
 payload.items[0].sap_code='SAP-INEXISTENTE';
 const response=await ingApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal(response.status,200);
 const errors=(await response.json()).validation.errors.map(y=>y.code);
 assert.ok(errors.includes('ORIGEN_INVALIDO'));
 assert.ok(errors.includes('DESTINO_INVALIDO'));
 assert.ok(errors.includes('SAP_INVALIDO'));
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,422);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,0);
});
test('Ingresos: integridad SQL bloquea serial ausente incluso saltando la API',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie),payload=ingPayload(f);
 payload.items[0].serial='';
 await ingApi(x,cookie,'/'+id,'PATCH',payload);
 const actor=x.database.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 assert.throws(()=>x.database.prepare("UPDATE ingress_documents SET status='REGISTRADO',registered_by=? WHERE id=?").run(actor,id),/SERIAL_OBLIGATORIO/);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 assert.equal(x.database.prepare('SELECT status FROM ingress_documents WHERE id=?').get(id).status,'BORRADOR');
});
test('Ingresos: no permite más de 500 ítems ni guardar desde otro origen',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie),payload=ingPayload(f);
 payload.items=Array.from({length:501},()=>({sap_code:f.sapBulk,serial:'',quantity:1,lot:'VALORADO',reception_state:'NUEVO',notes:''}));
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',payload)).status,400);
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',ingPayload(f),'https://externo.example')).status,403);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM ingress_items').get().n,0);
});

test('Ingresos: PDF privado opcional se adjunta, descarga y retira de borrador',async()=>{
 const x=setup(),cookie=await adminCookie(x),id=await ingNew(x,cookie);
 const bytes=new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
 const upload=new Request(root+'/api/ingresos/'+id+'/soporte',{
  method:'POST',headers:{cookie,origin:root,'Content-Type':'application/pdf','x-file-name':'soporte.pdf'},
  body:bytes
 });
 const stored=await worker.fetch(upload,x.env);
 assert.equal(stored.status,201,'El PDF se debe conservar correctamente');
 assert.equal((await worker.fetch(x.req('/api/ingresos/'+id+'/soporte'),x.env)).status,401);
 const download=await ingApi(x,cookie,'/'+id+'/soporte');
 assert.equal(download.status,200);
 assert.equal(download.headers.get('content-type'),'application/pdf');
 assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
 assert.equal((await ingApi(x,cookie,'/'+id+'/soporte','DELETE')).status,200);
 assert.equal((await ingApi(x,cookie,'/'+id+'/soporte')).status,404);
});


test('Interfaz: ítems importados en modo consulta y editor explícito por fila',()=>{
 const source=fs.readFileSync(new URL('../pages/ingresos.js',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../pages/ingresos.html',import.meta.url),'utf8');
 assert.match(source,/let editingIndex=null,editingDraft=null,editingNew=false/);
 assert.match(source,/const isEditing=editingIndex===index,draft=isEditing\?editingDraft:item/);
 assert.match(source,/isEditing\?itemEditorField\(draft,key,index\):viewItemValue\(item,key\)/);
 assert.match(source,/const edit=elt\('button','✎','ingress-item-edit'\)/);
 assert.match(source,/const apply=elt\('button','✓','ingress-item-apply'\)/);
 assert.match(source,/const cancel=elt\('button','↶','ingress-item-cancel'\)/);
 assert.match(source,/items\[index\]=\{\.\.\.items\[index\],\.\.\.editingDraft\}/);
 assert.match(source,/if\(editingNew\)items\.splice\(editingIndex,1\)/);
 assert.match(source,/if\(editingIndex!==null\)\{showMessage\('Aplica o cancela la edición/);
 assert.match(source,/const sap=bySap.get\(n\(draft.sap_code\)\),issues=rowIssues\(index\)/);
 assert.match(html,/Pulsa ✎ para editar una fila/);
});


test('Catálogo: valor en COP, centavos exactos y validación de importes',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const req=(method,data)=>worker.fetch(x.req('/api/maestras/catalogo',{method,data,headers:{cookie}}),x.env);
 let response=await req('POST',{...sapItem,unit_value:'1250000.25'});
 assert.equal(response.status,201);
 const id=(await response.json()).id;
 assert.equal(x.database.prepare('SELECT unit_value_cents FROM master_sap_catalog WHERE id=?').get(id).unit_value_cents,125000025);
 response=await req('PATCH',{id,unit_value:'0'});
 assert.equal(response.status,200);
 for(const invalid of ['12,50','12.345','-10','99999999999'])
  assert.equal((await req('PATCH',{id,unit_value:invalid})).status,400,invalid);
 assert.equal((await (await req('GET')).json()).items[0].unit_value_cents,0);
});
test('Catálogo: carga masiva distingue SAP nuevos de SAP existentes; solo actualiza su valor',async()=>{
 const x=setup(),cookie=await adminCookie(x);
 const existing={...bulkSap('0000100001'),unit_value:'150.50'};
 assert.equal((await importReq(x,cookie,'CATALOGO',[existing],'commit')).status,201);
 const before=x.database.prepare('SELECT * FROM master_sap_catalog WHERE sap_code=?').get(existing.sap_code);
 const batch=[
  {...existing,unit_value:'1250000.99',description:'No cambiar descripción',item_type:'MATERIAL',serial_profile:'SIN PERFIL DE SERIE',is_active:false},
  {...bulkSap('0000100002'),unit_value:'3499.50'}
 ];
 const preview=await (await importReq(x,cookie,'CATALOGO',batch,'validate')).json();
 assert.equal(preview.valid,true,JSON.stringify(preview));
 assert.equal(preview.inserted,1);assert.equal(preview.updated,1);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,1);
 assert.equal(x.database.prepare('SELECT unit_value_cents FROM master_sap_catalog WHERE id=?').get(before.id).unit_value_cents,15050);
 const result=await importReq(x,cookie,'CATALOGO',batch,'commit');
 assert.equal(result.status,201,await result.text());
 const after=x.database.prepare('SELECT * FROM master_sap_catalog WHERE id=?').get(before.id);
 assert.equal(after.id,before.id);assert.equal(after.description,before.description);
 assert.equal(after.item_type,before.item_type);assert.equal(after.serial_profile,before.serial_profile);
 assert.equal(after.unit,before.unit);assert.equal(after.is_active,before.is_active);
 assert.equal(after.unit_value_cents,125000099);
 assert.equal(x.database.prepare('SELECT unit_value_cents FROM master_sap_catalog WHERE sap_code=?').get('0000100002').unit_value_cents,349950);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,2);
 const audit=x.database.prepare("SELECT changed_fields FROM master_audit WHERE record_id=? AND action='EDITAR'").get(before.id);
 assert.equal(audit.changed_fields,'["unit_value_cents"]');
});
test('Catálogo: valor vacío preserva valor previo y errores impiden cambios parciales',async()=>{
 const x=setup(),cookie=await adminCookie(x),row={...bulkSap('0000200001'),unit_value:'450.20'};
 assert.equal((await importReq(x,cookie,'CATALOGO',[row],'commit')).status,201);
 const result=await importReq(x,cookie,'CATALOGO',[{...row,unit_value:''}],'commit');
 assert.equal(result.status,201);
 assert.equal((await result.json()).unchanged,1);
 const batch=[{...row,unit_value:'800.20'},{...bulkSap('0000200002'),unit_value:'12,50'}];
 assert.equal((await importReq(x,cookie,'CATALOGO',batch,'commit')).status,422);
 assert.equal(x.database.prepare('SELECT unit_value_cents FROM master_sap_catalog WHERE sap_code=?').get(row.sap_code).unit_value_cents,45020);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,1);
 assert.equal((await importReq(x,cookie,'CATALOGO',[row,row],'commit')).status,422);
});
test('Catálogo: nueva columna disponible en plantilla, ficha y tabla',()=>{
 const js=fs.readFileSync(new URL('../pages/maestras.js',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../pages/maestras.html',import.meta.url),'utf8');
 const imp=fs.readFileSync(new URL('../pages/maestras-import.js',import.meta.url),'utf8');
 assert.match(js,/unit_value:val\('sap-value'\)/);
 assert.match(html,/id="sap-value"/);
 assert.match(imp,/\['Valor del equipo','unit_value'\]/);
 assert.match(imp,/answer.updated/);
});

/* Test integrado del primer despliegue de Despachos a técnicos. */
async function dispatchApi(x,cookie,path='',method='GET',data=null,origin=root){
 return worker.fetch(x.req('/api/despachos'+path,{
  method,origin,headers:{cookie,...(method!=='GET'?{origin}:{})},
  ...(data===null?{}:{data})
 }),x.env);
}
function dispatchFixtures(x){
 const f=ingFixtures(x),db=x.database;
 const actor=db.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 const sup=randomUUID(),tech=randomUUID(),secondTech=randomUUID();
 db.prepare('INSERT INTO master_personnel(id,document_number,full_name,position,department,zone,supervisor_id,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(sup,'11001100','Supervisor despacho','SUPERVISOR','CESAR','Valledupar',null,actor,actor);
 for(const [id,doc,name] of [[tech,'77001122','Técnico despacho'],[secondTech,'77001133','Técnica alterna']])
  db.prepare('INSERT INTO master_personnel(id,document_number,full_name,position,department,city_base,supervisor_id,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
   .run(id,doc,name,'TECNICO','CESAR','Valledupar',sup,actor,actor);
 return {...f,tech,secondTech,sup};
}
async function fillIngressForDispatch(x,cookie,f){
 const id=await ingNew(x,cookie);
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',ingPayload(f))).status,200);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 return id;
}
async function newDispatch(x,cookie){
 const response=await dispatchApi(x,cookie,'','POST');
 assert.equal(response.status,201);
 return (await response.json()).id;
}
function dispatchPayload(f){
 return {technician_id:f.tech,warehouse_id:f.destination,dispatch_date:'2026-11-07',notes:'Prueba de asignación',
  items:[{sap_code:f.sapSerial,serial:'EQ-001',quantity:1,notes:''},
   {sap_code:f.sapBulk,serial:'',quantity:3,notes:''}]
 };
}
test('Despachos: requiere autenticación y usa técnicos activos y stock real',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 assert.equal((await dispatchApi(x,'')).status,401);
 assert.equal((await dispatchApi(x,cookie,'','POST',null,'https://ajeno.example')).status,403);
 assert.equal((await dispatchApi(x,'','/catalogos')).status,401);
 assert.equal((await dispatchApi(x,cookie,'/catalogos')).status,200);
 await fillIngressForDispatch(x,cookie,f);
 const data=await (await dispatchApi(x,cookie,'/catalogos')).json();
 assert.equal(data.technicians.length,2);
 assert.equal(data.warehouses.some(w=>w.id===f.destination),true);
 assert.equal(data.serials.some(s=>s.serial==='EQ-001'),true);
 assert.equal(data.bulk.find(b=>b.sap_code===f.sapBulk).quantity,5);
});
test('Despachos: confirmar asignación de serial y cantidades es atómico y trazable',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 const ingresado=await fillIngressForDispatch(x,cookie,f),id=await newDispatch(x,cookie);
 const payload=dispatchPayload(f);
 const draft=await dispatchApi(x,cookie,'/'+id,'PATCH',payload);
 assert.equal(draft.status,200);
 assert.equal((await draft.json()).validation.valid,true);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_serial_assignments').get().n,0);
 const confirmed=await dispatchApi(x,cookie,'/'+id+'/confirmar','POST');
 assert.equal(confirmed.status,200);
 const confirmedData=await confirmed.json();
 assert.match(confirmedData.reference,/^DES-\d{8}-[A-F0-9]{8}$/);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_movements').get().n,2);
 const ass=x.database.prepare('SELECT serial,technician_id,dispatch_id FROM dispatch_serial_assignments').get();
 assert.deepEqual([ass.serial,ass.technician_id,ass.dispatch_id],['EQ-001',f.tech,id]);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM inventory_serials WHERE ingress_id=?').get(ingresado).n,1);
 const view=(await (await dispatchApi(x,cookie,'/'+id)).json());
 assert.equal(view.document.status,'DESPACHADO');
 assert.equal(view.validation,null);
 assert.equal(view.items[0].lot,'VALORADO');
 assert.equal(view.items[0].physical_state,'BUENO');
 const cat=(await (await dispatchApi(x,cookie,'/catalogos')).json());
 assert.equal(cat.serials.some(s=>s.serial==='EQ-001'),false);
 assert.equal(cat.bulk.find(b=>b.sap_code===f.sapBulk).quantity,2);
 assert.equal((await dispatchApi(x,cookie,'/'+id+'/confirmar','POST')).status,409);
 assert.equal((await dispatchApi(x,cookie,'/'+id,'PATCH',payload)).status,409);
 assert.equal((await dispatchApi(x,cookie,'/'+id,'DELETE')).status,409);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_movements').get().n,2);
});
test('Despachos: bloquea segundo despacho del mismo serial y exceder saldos de bodega',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const first=await newDispatch(x,cookie);
 await dispatchApi(x,cookie,'/'+first,'PATCH',dispatchPayload(f));
 assert.equal((await dispatchApi(x,cookie,'/'+first+'/confirmar','POST')).status,200);
 const other=await newDispatch(x,cookie),duplicate=dispatchPayload(f);
 duplicate.technician_id=f.secondTech;
 duplicate.items=[{sap_code:f.sapSerial,serial:'EQ-001',quantity:1,notes:''}];
 const result=await dispatchApi(x,cookie,'/'+other,'PATCH',duplicate);
 assert.equal(result.status,200);
 assert.ok((await result.json()).validation.errors.some(e=>e.code==='SERIAL_NO_DISPONIBLE'));
 assert.equal((await dispatchApi(x,cookie,'/'+other+'/confirmar','POST')).status,422);
 // Ni un UPDATE directo de SQL debe reservar el mismo serial.
 const actor=x.database.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 assert.throws(()=>x.database.prepare("UPDATE dispatch_documents SET status='DESPACHADO',confirmed_by=? WHERE id=?").run(actor,other),/SERIAL_NO_DISPONIBLE/);
 const excessive=dispatchPayload(f);
 excessive.items=[{sap_code:f.sapBulk,serial:'',quantity:3,notes:''}];
 await dispatchApi(x,cookie,'/'+other,'PATCH',excessive);
 assert.equal((await dispatchApi(x,cookie,'/'+other+'/confirmar','POST')).status,422);
 assert.throws(()=>x.database.prepare("UPDATE dispatch_documents SET status='DESPACHADO',confirmed_by=? WHERE id=?").run(actor,other),/SIN_EXISTENCIAS/);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_movements').get().n,2);
});
test('Despachos: borrador no mueve stock, puede eliminarse, y se valida inventario insuficiente',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const id=await newDispatch(x,cookie);
 const data=dispatchPayload(f);data.items[1].quantity=6;
 const saved=await dispatchApi(x,cookie,'/'+id,'PATCH',data);
 assert.equal(saved.status,200);
 assert.ok((await saved.json()).validation.errors.some(e=>e.code==='SIN_EXISTENCIAS'));
 assert.equal((await dispatchApi(x,cookie,'/'+id+'/confirmar','POST')).status,422);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
 assert.equal((await dispatchApi(x,cookie,'/'+id,'DELETE',null,'https://ajeno.example')).status,403);
 assert.equal((await dispatchApi(x,cookie,'/'+id,'DELETE')).status,200);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_documents').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_items').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_audit').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM dispatch_movements').get().n,0);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
 const noTech=await newDispatch(x,cookie),payload=dispatchPayload(f);
 payload.technician_id=f.sup;
 const err=await dispatchApi(x,cookie,'/'+noTech,'PATCH',payload);
 assert.ok((await err.json()).validation.errors.some(e=>e.code==='TECNICO_INVALIDO'));
 assert.equal((await dispatchApi(x,cookie,'/'+noTech+'/confirmar','POST')).status,422);
});
test('Despachos: HTML muestra la identidad y las tres pantallas diferenciadas',()=>{
 const html=fs.readFileSync(new URL('../pages/despachos.html',import.meta.url),'utf8');
 const js=fs.readFileSync(new URL('../pages/despachos.js',import.meta.url),'utf8');
 assert.match(html,/id="dispatch-home"/);assert.match(html,/id="dispatch-wizard"/);
 assert.match(html,/id="dispatch-detail"/);
 assert.match(html,/id="dispatch-excel-file"/);
 assert.match(html,/Nuevo despacho a técnico/);
 assert.doesNotMatch(html,/Cargar despachos desde Excel/);
 assert.match(html,/id="dispatch-import-button"/);
 assert.match(js,/showDetail\(result\)/);
 assert.match(js,/PULSO_Plantilla_Despachos_a_tecnicos.xlsx/);
});


test('Despachos: solo muestra bodegas propias con saldo asignable, no vacías o inactivas',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 const actor=db.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 const empty=randomUUID(),zero=randomUUID(),bulkOnly=randomUUID(),inactive=randomUUID(),aliado=randomUUID();
 for(const [id,centro,administration,is_active] of [
  [empty,'C401','PROPIA',1],[zero,'C402','PROPIA',1],
  [bulkOnly,'C403','PROPIA',1],[inactive,'C404','PROPIA',0],[aliado,'C405','ALIADO',1]
 ]){
  db.prepare(
   'INSERT INTO master_logistics_locations(id,centro,almacen,description,administration,department,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id,centro,'A001','Bodega '+centro,administration,'CESAR',is_active,actor,actor);
 }
 // Sin saldo inicial: también deben desaparecer bodegas PROPIAS activas.
 let catalog=(await (await dispatchApi(x,cookie,'/catalogos')).json());
 assert.deepEqual(catalog.warehouses,[]);
 await fillIngressForDispatch(x,cookie,f);
 db.prepare('INSERT INTO inventory_bulk_stock(warehouse_id,sap_code,quantity) VALUES (?,?,?)')
  .run(zero,f.sapBulk,0);
 for(const id of [bulkOnly,inactive,aliado])
  db.prepare('INSERT INTO inventory_bulk_stock(warehouse_id,sap_code,quantity) VALUES (?,?,?)')
   .run(id,f.sapBulk,2);
 catalog=(await (await dispatchApi(x,cookie,'/catalogos')).json());
 const ids=new Set(catalog.warehouses.map(w=>w.id));
 assert.equal(ids.has(f.destination),true);
 assert.equal(ids.has(bulkOnly),true);
 assert.equal(ids.has(empty),false);
 assert.equal(ids.has(zero),false);
 assert.equal(ids.has(inactive),false);
 assert.equal(ids.has(aliado),false);
 assert.equal(ids.has(f.badDest),false);
 assert.equal(catalog.warehouses.find(w=>w.id===f.destination).available_units,6);
 assert.equal(catalog.warehouses.find(w=>w.id===bulkOnly).available_units,2);
});
test('Despachos: bodega solo con seriales, solo material y sin saldo final',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 await fillIngressForDispatch(x,cookie,f);
 const first=await newDispatch(x,cookie),data=dispatchPayload(f);
 data.items=[{sap_code:f.sapSerial,serial:'EQ-001',quantity:1,notes:''}];
 assert.equal((await dispatchApi(x,cookie,'/'+first,'PATCH',data)).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+first+'/confirmar','POST')).status,200);
 let cat=(await (await dispatchApi(x,cookie,'/catalogos')).json());
 assert.equal(cat.warehouses.length,1);
 assert.equal(cat.warehouses[0].available_units,5,'La bodega permanece por el material sin serial');
 const second=await newDispatch(x,cookie);
 data.items=[{sap_code:f.sapBulk,serial:'',quantity:5,notes:''}];
 assert.equal((await dispatchApi(x,cookie,'/'+second,'PATCH',data)).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+second+'/confirmar','POST')).status,200);
 cat=(await (await dispatchApi(x,cookie,'/catalogos')).json());
 assert.equal(cat.warehouses.length,0,'Una bodega agotada desaparece del selector');
 assert.equal(db.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_serial_assignments').get().n,1);
 const third=await newDispatch(x,cookie);
 const stale=dispatchPayload(f);
 await dispatchApi(x,cookie,'/'+third,'PATCH',stale);
 assert.equal((await dispatchApi(x,cookie,'/'+third+'/confirmar','POST')).status,422);
});
test('Despachos: un único serial libre basta para mostrar su bodega',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 await fillIngressForDispatch(x,cookie,f);
 db.prepare('UPDATE inventory_bulk_stock SET quantity=0 WHERE warehouse_id=?').run(f.destination);
 const cat=(await (await dispatchApi(x,cookie,'/catalogos')).json());
 assert.equal(cat.warehouses.length,1);
 assert.equal(cat.warehouses[0].id,f.destination);
 assert.equal(cat.warehouses[0].available_units,1);
});
test('Despachos: bodega agotada en borrador se muestra como no disponible y no permite avanzar',()=>{
 const js=fs.readFileSync(new URL('../pages/despachos.js',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../pages/despachos.html',import.meta.url),'utf8');
 assert.match(js,/function unavailableWarehouse\(id,name\)/);
 assert.match(js,/option\.disabled=true/);
 assert.match(js,/const depleted=unavailableWarehouse\(doc\.warehouse_id/);
 assert.match(js,/if\(!warehouses\.some\(w=>w\.id===currentDoc\(\)\.warehouse_id\)\)/);
 assert.match(js,/unidades disponibles/);
 assert.match(html,/id="dispatch-warehouse-note"/);
});


test('Despachos: paso 3 solo equipos y paso 4 confirmación completa con equipos',()=>{
 const html=fs.readFileSync(new URL('../pages/despachos.html',import.meta.url),'utf8');
 const js=fs.readFileSync(new URL('../pages/despachos.js',import.meta.url),'utf8');
 const third=html.split('<div id="dispatch-step-three"')[1]?.split('<div id="dispatch-step-four"')[0];
 const fourth=html.split('<div id="dispatch-step-four"')[1]?.split('<div id="dispatch-errors"')[0];
 assert.ok(third,'El paso 3 debe existir');
 assert.ok(fourth,'El paso 4 debe existir');
 assert.match(third,/Resumen de equipos/);
 assert.match(third,/id="dispatch-review-counts"/);
 assert.match(third,/id="dispatch-review-items"/);
 assert.doesNotMatch(third,/id="dispatch-confirm-summary"|id="dispatch-review"|Técnico responsable|Bodega de origen|id="dispatch-ack"/);
 assert.match(fourth,/id="dispatch-confirm-summary"/);
 assert.match(fourth,/id="dispatch-confirm-items"/);
 assert.match(fourth,/id="dispatch-ack"/);
 assert.match(js,/function renderEquipmentTable\(elementId\)/);
 assert.match(js,/renderEquipmentTable\('dispatch-review-items'\)/);
 assert.match(js,/renderEquipmentTable\('dispatch-confirm-items'\)/);
 assert.match(js,/fieldSummary\(\$\('dispatch-review-counts'\)/);
 assert.match(js,/fieldSummary\(\$\('dispatch-confirm-summary'\),summaryData\(\)\)/);
 assert.doesNotMatch(js,/fieldSummary\(\$\('dispatch-review'\),summaryData\(\)\)/);
});


test('Despachos: cuatro vistas reales separan técnico, equipos asignados e historial',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 assert.equal((await dispatchApi(x,'','/consultas')).status,401);
 assert.equal((await dispatchApi(x,cookie,'/consultas','POST')).status,405);
 let data=(await (await dispatchApi(x,cookie,'/consultas')).json());
 assert.deepEqual(data.technicians,[]);
 assert.deepEqual(data.equipment,[]);
 const first=await newDispatch(x,cookie);
 assert.equal((await dispatchApi(x,cookie,'/'+first,'PATCH',dispatchPayload(f))).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+first+'/confirmar','POST')).status,200);
 data=(await (await dispatchApi(x,cookie,'/consultas')).json());
 assert.equal(data.technicians.length,1);
 assert.equal(data.technicians[0].technician_id,f.tech);
 assert.equal(data.technicians[0].dispatch_count,1);
 assert.equal(data.technicians[0].assigned_units,4);
 assert.equal(data.equipment.length,2);
 assert.equal(data.equipment.find(row=>row.serial==='EQ-001').technician_name,'Técnico despacho');
 assert.equal(data.equipment.find(row=>row.serial==='EQ-001').sap_description,'Equipo SAP-10001');
 assert.equal(data.equipment.find(row=>row.serial==='').quantity,3);
 const second=await newDispatch(x,cookie);
 const payload=dispatchPayload(f);
 payload.technician_id=f.secondTech;
 payload.items=[{sap_code:f.sapBulk,serial:'',quantity:1,notes:''}];
 assert.equal((await dispatchApi(x,cookie,'/'+second,'PATCH',payload)).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+second+'/confirmar','POST')).status,200);
 data=(await (await dispatchApi(x,cookie,'/consultas')).json());
 assert.equal(data.technicians.length,2);
 assert.equal(data.technicians.find(row=>row.technician_id===f.secondTech).assigned_units,1);
 assert.equal(data.equipment.length,3);
 const listing=(await (await dispatchApi(x,cookie)).json()).items;
 assert.ok(listing.every(row=>row.technician_id));
 assert.equal(listing.filter(row=>row.status==='DESPACHADO').length,2);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,1);
});
test('Despachos: panel simétrico, botones sin duplicidad y pestañas con columnas distintas',()=>{
 const html=fs.readFileSync(new URL('../pages/despachos.html',import.meta.url),'utf8');
 const js=fs.readFileSync(new URL('../pages/despachos.js',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../pages/despachos.css',import.meta.url),'utf8');
 assert.doesNotMatch(html,/Registrar devolución/);
 assert.doesNotMatch(html,/Cargar despachos desde Excel/);
 assert.doesNotMatch(html,/id="dispatch-excel"/);
 assert.match(html,/id="dispatch-import-button"/,'Excel individual permanece dentro del asistente');
 assert.match(html,/id="dispatch-download-template"/);
 assert.match(html,/id="dispatch-technician-filter"/);
 assert.match(html,/id="dispatch-date-from"/);
 assert.match(html,/id="dispatch-date-to"/);
 assert.match(html,/id="dispatch-list-head"/);
 assert.match(html,/id="dispatch-page-prev"/);
 assert.match(html,/id="dispatch-page-next"/);
 assert.match(js,/function viewTechnician\(record,body\)/);
 assert.match(js,/function viewEquipment\(record,body\)/);
 assert.match(js,/function viewDispatch\(record,body\)/);
 assert.match(js,/technicianSummaries=views.technicians/);
 assert.match(js,/activeEquipment=views.equipment/);
 assert.match(js,/activeTab==='history'/);
 assert.match(js,/activeTab==='recent'\?result.slice\(0,12\)/);
 assert.match(js,/api\('\/consultas'\)/);
 assert.match(css,/\.dispatch-dashboard\{align-items:stretch\}/);
 assert.match(css,/\.dispatch-board\{min-height:580px;height:100%;display:flex;flex-direction:column\}/);
});


test('Despachos: confirmar bloquea el botón y muestra detalle con notificación de éxito',()=>{
 const js=fs.readFileSync(new URL('../pages/despachos.js',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../pages/despachos.html',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../pages/despachos.css',import.meta.url),'utf8');
 assert.match(js,/async function showConfirmedDispatch\(id,reference\)/);
 assert.match(js,/function lockConfirmedDispatch\(reference\)/);
 assert.match(js,/dispatchStatus='DESPACHADO';dirty=false/);
 assert.match(js,/\$\('dispatch-confirm'\)\.disabled=true/);
 assert.match(js,/\$\('dispatch-confirm'\)\.textContent=confirmedLabel/);
 assert.match(js,/button\.textContent='Confirmando despacho\.\.\.'/);
 assert.match(js,/await showConfirmedDispatch\(result\.id,result\.reference\)/);
 assert.match(js,/if\(check\.document\.status==='DESPACHADO'\)/);
 assert.match(js,/showDetail\(detail\);\s*display\('detail'\)/);
 assert.match(js,/if\(dispatchStatus==='DESPACHADO'\)return;\s*resetConfirmControls\(\)/);
 assert.match(html,/id="dispatch-confirmed-message"/);
 assert.match(html,/id="dispatch-confirmed-detail"/);
 assert.match(css,/\.dispatch-confirmed-message\[hidden\]\{display:none!important\}/);
});
test('Despachos: la confirmación duplicada sigue siendo rechazada por el servidor',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const id=await newDispatch(x,cookie);
 assert.equal((await dispatchApi(x,cookie,'/'+id,'PATCH',dispatchPayload(f))).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 const duplicate=await dispatchApi(x,cookie,'/'+id+'/confirmar','POST');
 assert.equal(duplicate.status,409);
 assert.equal((await duplicate.json()).error,'DESPACHO_INMUTABLE');
 const get=await dispatchApi(x,cookie,'/'+id);
 const detail=await get.json();
 assert.equal(detail.document.status,'DESPACHADO');
 assert.equal(detail.document.reference.startsWith('DES-'),true);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_movements WHERE dispatch_id=?').get(id).n,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_serial_assignments WHERE dispatch_id=?').get(id).n,1);
});


test('Acceso: correo y contraseña siguen legibles con autocompletado de Chrome',()=>{
 const css=fs.readFileSync(new URL('../pages/acceso.css',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../pages/main.html',import.meta.url),'utf8');
 assert.match(css,/\.field input:-webkit-autofill/);
 assert.match(css,/\.field input:-webkit-autofill:focus/);
 assert.match(css,/\.field input:autofill/);
 assert.match(css,/-webkit-text-fill-color:#f7fffb !important/);
 assert.match(css,/box-shadow:0 0 0 1000px #28675c inset !important/);
 assert.match(css,/caret-color:#fff/);
 assert.match(html,/id="login-email" type="email"[^>]*autocomplete="username"/);
 assert.match(html,/id="login-password" type="password"[^>]*autocomplete="current-password"/);
});


function massRow({technician='77001122',centro='C200',almacen='A001',
 date='2026-11-07',sap='SAP-10002',serial='',quantity=1,notes=''}={}){
 return {technician_document:technician,centro,almacen,dispatch_date:date,
  sap_code:sap,serial,quantity,notes};
}
function massPayload(rows,operation_id=randomUUID()){return {operation_id,rows};}
test('Despachos masivos: valida archivo para varios técnicos sin modificar inventario',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const rows=[
  massRow({technician:'77001122',sap:f.sapSerial,serial:'EQ-001'}),
  massRow({technician:'77001122',sap:f.sapBulk,quantity:2}),
  massRow({technician:'77001133',sap:f.sapBulk,quantity:2})
 ];
 const result=await dispatchApi(x,cookie,'/masivo/validar','POST',massPayload(rows));
 assert.equal(result.status,200);
 const body=await result.json();
 assert.equal(body.valid,true,JSON.stringify(body));
 assert.deepEqual([body.totals.technicians,body.totals.dispatches,body.totals.lines,body.totals.units],[2,2,3,5]);
 assert.equal(body.groups.length,2);
 assert.equal(body.groups.find(g=>g.technician_document==='77001122').item_count,2);
 assert.equal(body.groups.find(g=>g.technician_document==='77001133').units,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_documents').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_movements').get().n,0);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
});
test('Despachos masivos: confirma todos los técnicos de forma conjunta, audita y permite reintentar sin duplicar',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const request=massPayload([
  massRow({technician:'77001122',sap:f.sapSerial,serial:'EQ-001'}),
  massRow({technician:'77001122',sap:f.sapBulk,quantity:2}),
  massRow({technician:'77001133',sap:f.sapBulk,quantity:2})
 ]);
 const response=await dispatchApi(x,cookie,'/masivo/confirmar','POST',request);
 assert.equal(response.status,200,await response.clone().text());
 const body=await response.json();
 assert.equal(body.confirmed,true);
 assert.equal(body.replayed,true);
 assert.equal(body.dispatches.length,2);
 assert.deepEqual([body.totals.dispatches,body.totals.technicians,body.totals.lines,body.totals.units],[2,2,3,5]);
 assert.ok(body.dispatches.every(d=>/^DES-\d{8}-[A-F0-9]{8}$/.test(d.reference)));
 assert.equal(x.database.prepare("SELECT COUNT(*) AS n FROM dispatch_documents WHERE status='DESPACHADO'").get().n,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_movements').get().n,3);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_serial_assignments').get().n,1);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,1);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_audit WHERE action=?').get('DESPACHAR').n,2);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_mass_batch_documents').get().n,2);
 const again=await dispatchApi(x,cookie,'/masivo/confirmar','POST',request);
 assert.equal(again.status,200);
 const replay=await again.json();
 assert.equal(replay.replayed,true);
 assert.deepEqual(replay.dispatches.map(d=>d.reference),body.dispatches.map(d=>d.reference));
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_movements').get().n,3);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,1);
 const changed=massPayload([massRow({technician:'77001122',sap:f.sapBulk,quantity:1})],request.operation_id);
 assert.equal((await dispatchApi(x,cookie,'/masivo/confirmar','POST',changed)).status,409);
});
test('Despachos masivos: rechaza serial repetido entre técnicos sin crear ningún despacho',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const request=massPayload([
  massRow({technician:'77001122',sap:f.sapSerial,serial:'EQ-001'}),
  massRow({technician:'77001133',sap:f.sapSerial,serial:'eq-001'})
 ]);
 const preview=(await (await dispatchApi(x,cookie,'/masivo/validar','POST',request)).json());
 assert.equal(preview.valid,false);
 assert.ok(preview.errors.some(e=>e.field==='Serial'&&/repetido/.test(e.message)));
 const confirmed=await dispatchApi(x,cookie,'/masivo/confirmar','POST',request);
 assert.equal(confirmed.status,422);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_mass_batches').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_documents').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_movements').get().n,0);
});
test('Despachos masivos: suma las cantidades de todos los técnicos y bloquea excedentes',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const request=massPayload([
  massRow({technician:'77001122',sap:f.sapBulk,quantity:3}),
  massRow({technician:'77001133',sap:f.sapBulk,quantity:3})
 ]);
 const result=await dispatchApi(x,cookie,'/masivo/validar','POST',request);
 const preview=await result.json();
 assert.equal(preview.valid,false);
 assert.ok(preview.errors.some(e=>e.field==='Existencias'));
 assert.equal((await dispatchApi(x,cookie,'/masivo/confirmar','POST',request)).status,422);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,5);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_documents').get().n,0);
});
test('Despachos masivos: técnico inválido, bodega inactiva y SAP desconocido bloquean lote completo',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const invalid=massPayload([
  massRow({technician:'77001122',sap:f.sapBulk,quantity:1}),
  massRow({technician:'99998888',sap:f.sapBulk,quantity:1}),
  massRow({technician:'77001133',centro:'C300',sap:f.sapBulk,quantity:1}),
  massRow({technician:'77001133',sap:'SAP-99999',quantity:1})
 ]);
 const result=await dispatchApi(x,cookie,'/masivo/validar','POST',invalid);
 const preview=await result.json();
 assert.equal(preview.valid,false);
 assert.ok(preview.errors.some(e=>e.field==='Técnico'));
 assert.ok(preview.errors.some(e=>e.field==='Bodega'));
 assert.ok(preview.errors.some(e=>e.field==='Código SAP'));
 assert.equal((await dispatchApi(x,cookie,'/masivo/confirmar','POST',invalid)).status,422);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_mass_batches').get().n,0);
 assert.equal(x.database.prepare('SELECT COUNT(*) AS n FROM dispatch_movements').get().n,0);
});
test('Despachos masivos: valida origen, permisos, método, límites y formato de documento',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x);
 await fillIngressForDispatch(x,cookie,f);
 const request=massPayload([massRow({sap:f.sapBulk})]);
 assert.equal((await dispatchApi(x,'','/masivo/validar','POST',request)).status,401);
 assert.equal((await dispatchApi(x,cookie,'/masivo/validar','GET')).status,405);
 assert.equal((await dispatchApi(x,cookie,'/masivo/confirmar','POST',request,'https://ajeno.example')).status,403);
 const tooMany=massPayload(Array.from({length:501},()=>massRow({sap:f.sapBulk})));
 assert.equal((await dispatchApi(x,cookie,'/masivo/validar','POST',tooMany)).status,200);
 const invalid=(await (await dispatchApi(x,cookie,'/masivo/validar','POST',tooMany)).json());
 assert.equal(invalid.valid,false);
 assert.equal((await dispatchApi(x,cookie,'/masivo/confirmar','POST',tooMany)).status,422);
 const badId={operation_id:'abc',rows:request.rows};
 assert.equal((await (await dispatchApi(x,cookie,'/masivo/validar','POST',badId)).json()).valid,false);
});
test('Despachos masivos: un técnico y dos bodegas originan dos despachos independientes',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 await fillIngressForDispatch(x,cookie,f);
 const actor=db.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 const other=randomUUID();
 db.prepare('INSERT INTO master_logistics_locations(id,centro,almacen,description,administration,department,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(other,'C201','A002','Bodega adicional','PROPIA','CESAR',1,actor,actor);
 db.prepare('INSERT INTO inventory_bulk_stock(warehouse_id,sap_code,quantity) VALUES (?,?,?)')
  .run(other,f.sapBulk,3);
 const request=massPayload([
  massRow({technician:'77001122',sap:f.sapBulk,quantity:2}),
  massRow({technician:'77001122',centro:'C201',almacen:'A002',sap:f.sapBulk,quantity:3})
 ]);
 const result=await dispatchApi(x,cookie,'/masivo/confirmar','POST',request);
 assert.equal(result.status,200,await result.clone().text());
 const body=await result.json();
 assert.equal(body.totals.dispatches,2);
 assert.equal(body.totals.technicians,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dispatch_documents').get().n,2);
 assert.equal(db.prepare('SELECT quantity FROM inventory_bulk_stock WHERE warehouse_id=?').get(f.destination).quantity,3);
 assert.equal(db.prepare('SELECT quantity FROM inventory_bulk_stock WHERE warehouse_id=?').get(other).quantity,0);
});
test('Despachos masivos: pantalla, plantilla, vista previa, confirmación y lectura de Excel',()=>{
 const html=fs.readFileSync(new URL('../pages/despachos.html',import.meta.url),'utf8');
 const js=fs.readFileSync(new URL('../pages/despachos-masivo.js',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../pages/despachos.css',import.meta.url),'utf8');
 assert.match(html,/id="dispatch-mass-open"/);
 assert.match(html,/id="dispatch-mass-template"/);
 assert.match(html,/id="dispatch-mass-file"/);
 assert.match(html,/id="dispatch-mass-preview"/);
 assert.match(html,/id="dispatch-mass-groups"/);
 assert.match(html,/id="dispatch-mass-confirm"/);
 assert.match(html,/id="dispatch-mass-success-list"/);
 assert.match(html,/despachos-masivo.js/);
 assert.match(js,/async function parseExcel\(file\)/);
 assert.match(js,/PULSO_Plantilla_Despachos_Masivos_Tecnicos.xlsx/);
 assert.match(js,/api\('validar',payload\)/);
 assert.match(js,/api\('confirmar',payload\)/);
 assert.match(js,/operation_id:crypto.randomUUID\(\)/);
 assert.match(js,/renderGroups\(data.groups\|\|\[\]\)/);
 assert.match(css,/\.dispatch-mass-tools/);
});


test('Reinicio 2026-11-11: borra Ingresos y Despachos completos y conserva cada Maestra',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 const actor=db.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 const ingressId=await fillIngressForDispatch(x,cookie,f);
 const draftIngress=await ingNew(x,cookie);
 const dispatchId=await newDispatch(x,cookie);
 assert.equal((await dispatchApi(x,cookie,'/'+dispatchId,'PATCH',dispatchPayload(f))).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+dispatchId+'/confirmar','POST')).status,200);
 const draftDispatch=await newDispatch(x,cookie);
 // Agregar lote masivo confirmado para comprobar sus tablas dependientes.
 const mass=massPayload([massRow({technician:'77001133',sap:f.sapBulk,quantity:1})]);
 assert.equal((await dispatchApi(x,cookie,'/masivo/confirmar','POST',mass)).status,200);
 const tables=['master_personnel','master_sap_catalog','master_logistics_locations','app_users'];
 const before=Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n]));
 assert.ok(before.master_personnel>0);
 assert.ok(before.master_sap_catalog>0);
 assert.ok(before.master_logistics_locations>0);
 assert.equal(before.app_users,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingress_documents').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dispatch_documents').get().n,3);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_movements').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dispatch_movements').get().n,3);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dispatch_mass_batches').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dispatch_serial_assignments').get().n,1);
 assert.ok(db.prepare('SELECT COUNT(*) AS n FROM inventory_bulk_stock').get().n>0);
 // Conservar respaldo temporal es tarea del workflow; la migración NO exporta información.
 db.exec(sql16);
 const cleared=['ingress_documents','ingress_items','ingress_audit','ingress_support_chunks',
  'inventory_serials','inventory_movements','inventory_bulk_stock',
  'dispatch_documents','dispatch_items','dispatch_audit','dispatch_movements',
  'dispatch_serial_assignments','dispatch_mass_batches','dispatch_mass_batch_documents'];
 for(const table of cleared)assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
 for(const table of tables)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,before[table],'Se conservó '+table);
 assert.ok(db.prepare("SELECT id FROM master_personnel WHERE id=?").get(f.tech));
 assert.ok(db.prepare("SELECT id FROM master_logistics_locations WHERE id=?").get(f.destination));
 assert.ok(db.prepare("SELECT id FROM master_sap_catalog WHERE sap_code=?").get(f.sapSerial));
 const check=db.prepare("SELECT * FROM pulso_operational_reset_events WHERE reset_key='REINICIO-INGRESOS-DESPACHOS-2026-11-11'").get();
 assert.ok(check.completed_at);
 assert.equal(check.master_personnel_after,check.master_personnel_before);
 assert.equal(check.master_sap_catalog_after,check.master_sap_catalog_before);
 assert.equal(check.master_locations_after,check.master_locations_before);
 assert.equal(check.app_users_after,check.app_users_before);
 assert.equal(db.prepare("SELECT operational_rows_remaining AS n FROM pulso_operational_reset_checks").get().n,0);
 const triggerNames=['dispatch_document_delete_guard','dispatch_items_delete_guard',
  'ingress_items_registered_delete','ingress_support_registered_delete'];
 for(const name of triggerNames)
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(name),'Recuperado '+name);
 // Reejecutar la migración NO debe borrar datos generados luego del reinicio.
 const laterIngress=await ingNew(x,cookie),laterDispatch=await newDispatch(x,cookie);
 assert.ok(db.prepare('SELECT id FROM ingress_documents WHERE id=?').get(laterIngress));
 assert.ok(db.prepare('SELECT id FROM dispatch_documents WHERE id=?').get(laterDispatch));
 db.exec(sql16);
 assert.ok(db.prepare('SELECT id FROM ingress_documents WHERE id=?').get(laterIngress));
 assert.ok(db.prepare('SELECT id FROM dispatch_documents WHERE id=?').get(laterDispatch));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pulso_operational_reset_events').get().n,1);
});


/* Saldos iniciales: proceso único, aislado de Ingresos ordinarios. */
async function openingApi(x,cookie,path='',method='GET',data=null,origin=root){
 return worker.fetch(x.req('/api/saldos-iniciales'+path,{
  method,origin,headers:{cookie,...(method!=='GET'?{origin}:{})},
  ...(data===null?{}:{data})
 }),x.env);
}
function openingRow({centro='C200',almacen='A001',sap_code='SAP-10002',serial='',
 quantity=1,lot='VALORADO',reception_state='NUEVO',notes=''}={}){
 return {centro,almacen,sap_code,serial,quantity,lot,reception_state,notes};
}
function openingPayload(rows,operation_id=randomUUID()){return {operation_id,rows};}
test('Apertura única: estado libre, acceso protegido y vista previa sin modificar Maestras',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x),db=x.database;
 const data=openingPayload([
  openingRow({sap_code:f.sapSerial,serial:'AP-001'}),
  openingRow({sap_code:f.sapBulk,quantity:12,lot:'NOVALORADO',reception_state:'REMANUFACTURADO'})
 ]);
 assert.equal((await openingApi(x,'','/estado')).status,401);
 assert.equal((await openingApi(x,cookie,'/validar','GET')).status,405);
 assert.equal((await openingApi(x,cookie,'/confirmar','POST',data,'https://externo.example')).status,403);
 const state=await (await openingApi(x,cookie,'/estado')).json();
 assert.equal(state.available,true);assert.equal(state.completed,false);
 const before={wh:db.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,
  sap:db.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n};
 const response=await openingApi(x,cookie,'/validar','POST',data);
 assert.equal(response.status,200);
 const preview=await response.json();
 assert.equal(preview.valid,true,JSON.stringify(preview));
 assert.deepEqual(preview.totals,{lines:2,units:13,warehouses:1,serialized:1});
 assert.equal(preview.groups[0].items[0].serial,'AP-001');
 assert.equal(preview.groups[0].items[1].quantity,12);
 for(const table of ['ingress_documents','ingress_items','inventory_movements',
   'inventory_serials','opening_stock_once'])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n,before.wh);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,before.sap);
});
test('Apertura única: confirma, abastece inventario, permite despachar y bloquea segunda carga',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 const request=openingPayload([
  openingRow({sap_code:f.sapSerial,serial:'AP-001'}),
  openingRow({sap_code:f.sapBulk,quantity:12,lot:'NOVALORADO',reception_state:'REMANUFACTURADO'})
 ]);
 const out=await openingApi(x,cookie,'/confirmar','POST',request);
 assert.equal(out.status,200,await out.clone().text());
 const result=await out.json();
 assert.equal(result.completed,true);
 assert.equal(result.documents.length,1);
 assert.equal(result.totals.units,13);
 const doc=db.prepare('SELECT * FROM ingress_documents').get();
 assert.equal(doc.document_type,'SALDO_INICIAL');
 assert.equal(doc.source_id,doc.destination_id);
 assert.equal(doc.status,'REGISTRADO');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,1);
 const serial=db.prepare("SELECT lot,reception_state,physical_state,status FROM inventory_serials WHERE serial='AP-001'").get();
 assert.deepEqual({...serial},{lot:'VALORADO',reception_state:'NUEVO',physical_state:'BUENO',status:'DISPONIBLE'});
 assert.equal(db.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,12);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
 const state=(await (await openingApi(x,cookie,'/estado')).json());
 assert.equal(state.completed,true);assert.equal(state.available,false);
 const catalog=(await (await dispatchApi(x,cookie,'/catalogos')).json());
 assert.equal(catalog.serials.some(r=>r.serial==='AP-001'),true);
 assert.equal(catalog.bulk.find(r=>r.sap_code===f.sapBulk).quantity,12);
 const replay=await openingApi(x,cookie,'/confirmar','POST',request);
 assert.equal(replay.status,200);
 assert.equal((await replay.json()).replayed,true);
 assert.equal((await openingApi(x,cookie,'/confirmar','POST',openingPayload([openingRow()]))).status,409);
 assert.equal((await openingApi(x,cookie,'/validar','POST',openingPayload([openingRow()]))).status,409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ingress_documents').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM opening_stock_once').get().n,1);
 // Despachar lo abierto a un técnico con el flujo normal.
 const dispatch=await newDispatch(x,cookie);
 const payload={technician_id:f.tech,warehouse_id:f.destination,dispatch_date:'2026-11-11',notes:'',
  items:[{sap_code:f.sapSerial,serial:'AP-001',quantity:1,notes:''},
   {sap_code:f.sapBulk,serial:'',quantity:3,notes:''}]};
 assert.equal((await dispatchApi(x,cookie,'/'+dispatch,'PATCH',payload)).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+dispatch+'/confirmar','POST')).status,200);
 assert.equal(db.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,9);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_serial_assignments').get().n,1);
});
test('Apertura única: serial repetido, lote inválido, SAP desconocido y bodega ajena bloquean todo',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x),db=x.database;
 const request=openingPayload([
  openingRow({sap_code:f.sapSerial,serial:'AP-001'}),
  openingRow({sap_code:f.sapSerial,serial:'ap-001'}),
  openingRow({sap_code:f.sapBulk,lot:'INVALIDO',quantity:4}),
  openingRow({sap_code:'SAP-99999',quantity:2}),
  openingRow({centro:'C100',sap_code:f.sapBulk,quantity:1}),
  openingRow({sap_code:f.sapSerial,serial:''})
 ]);
 const preview=await (await openingApi(x,cookie,'/validar','POST',request)).json();
 assert.equal(preview.valid,false);
 assert.ok(preview.errors.some(x=>x.field==='Serial'&&/repetido/.test(x.message)));
 assert.ok(preview.errors.some(x=>x.field==='Lote'));
 assert.ok(preview.errors.some(x=>x.field==='Código SAP'));
 assert.ok(preview.errors.some(x=>x.field==='Bodega'));
 const response=await openingApi(x,cookie,'/confirmar','POST',request);
 assert.equal(response.status,422);
 for(const table of ['opening_stock_once','opening_stock_documents','ingress_documents',
  'inventory_movements','inventory_serials','inventory_bulk_stock'])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,table);
});
test('Apertura única: nunca permite apertura si ya hay Ingresos o Despachos',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const id=await ingNew(x,cookie);
 const state=await (await openingApi(x,cookie,'/estado')).json();
 assert.equal(state.available,false);assert.equal(state.blocked,true);
 assert.equal((await openingApi(x,cookie,'/confirmar','POST',openingPayload([openingRow()]))).status,409);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM opening_stock_once').get().n,0);
 assert.equal(x.database.prepare('SELECT id FROM ingress_documents WHERE id=?').get(id).id,id);
});
test('Apertura única: la importación no cambia validaciones normales de Ingresos',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=ingFixtures(x);
 const first=openingPayload([openingRow({sap_code:f.sapBulk,quantity:4})]);
 assert.equal((await openingApi(x,cookie,'/confirmar','POST',first)).status,200);
 const id=await ingNew(x,cookie);
 const p=ingPayload(f);
 p.items[0].serial='POST-AP-001';
 assert.equal((await ingApi(x,cookie,'/'+id,'PATCH',p)).status,200);
 assert.equal((await ingApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM ingress_documents').get().n,2);
 assert.equal(x.database.prepare('SELECT quantity FROM inventory_bulk_stock').get().quantity,9);
});
test('Apertura única: UI con Excel, validación, preview, confirmación y cierre irreversible',()=>{
 const html=fs.readFileSync(new URL('../pages/saldos-iniciales.html',import.meta.url),'utf8');
 const js=fs.readFileSync(new URL('../pages/saldos-iniciales.js',import.meta.url),'utf8');
 const original=fs.readFileSync(new URL('../pages/ingresos.html',import.meta.url),'utf8');
 const ingressJs=fs.readFileSync(new URL('../pages/ingresos.js',import.meta.url),'utf8');
 assert.match(html,/id="opening-template"/);
 assert.match(html,/id="opening-file"/);
 assert.match(html,/id="opening-preview"/);
 assert.match(html,/id="opening-ack"/);
 assert.match(html,/id="opening-confirm"/);
 assert.match(html,/id="opening-complete"/);
 assert.match(js,/PULSO_Plantilla_Saldos_Iniciales_Unica_Vez.xlsx/);
 assert.match(js,/api\('\/validar'/);
 assert.match(js,/api\('\/confirmar'/);
 assert.match(js,/operation_id:crypto.randomUUID\(\)/);
 assert.match(original,/id="ingress-opening-link" hidden/);
 assert.match(ingressJs,/ingress-opening-link'\)\.hidden=!state.available/);
});


test('Despachos masivos: acepta identificaciones numéricas de Excel con precisión segura sin alterar seriales',()=>{
 const js=fs.readFileSync(new URL('../pages/despachos-masivo.js',import.meta.url),'utf8');
 const parser=js.match(/function cellText\(cell,index\)\{[\s\S]*?\n \}\n async function parseExcel\(file\)/);
 assert.ok(parser,'El lector de Excel debe existir');
 const cellText=new Function('return ('+parser[0].replace(/\n async function parseExcel\(file\)$/,'').trim()+')')();
 // Excel guarda estos valores como números aunque tengan formato visual Texto (@).
 assert.equal(cellText({value:1234567890,row:2,numFmt:'@'},0),'1234567890');
 assert.equal(cellText({value:1053481,row:2,numFmt:'@'},4),'1053481');
 assert.equal(cellText({value:'1053481-RIO-0001',row:2,numFmt:'@'},5),'1053481-RIO-0001');
 assert.equal(cellText({value:46325,row:2,numFmt:'dd/mm/yyyy'},3),'2026-10-30');
 assert.equal(cellText({value:new Date('2026-10-30T00:00:00.000Z'),row:2},3),'2026-10-30');
 assert.equal(cellText({value:1,row:2},6),'1');
 assert.throws(()=>cellText({value:12345678901234568,row:2},0),/precisión de Excel/);
 assert.throws(()=>cellText({value:1234,row:2},5),/Serial está guardado como número/);
 assert.throws(()=>cellText({value:123,row:2},2),/Almacén o Serial/);
});


function prepareCorrectionFixture(x){
 const db=x.database,actor=db.prepare("SELECT id FROM app_users WHERE email='admin@example.com'").get().id;
 const warehouse=randomUUID();
 db.prepare("INSERT INTO master_logistics_locations(id,centro,almacen,description,administration,department,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(warehouse,'C901','A221','DOMINION SAI','PROPIA','CESAR',1,actor,actor);
 for(const [code,description] of [['1053481','FUENTE POE DC 15W 30V ENERGY LVL6 CBNW'],['4060070','FUENTE 100-240 48V 1.4_1.5A PWR PLUG']]){
  db.prepare("INSERT INTO master_sap_catalog(id,sap_code,description,item_type,serial_profile,unit,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)")
   .run(randomUUID(),code,description,'EQUIPO','CON PERFIL DE SERIE','UND',1,actor,actor);
 }
 return {warehouse};
}
async function registerCorrectionCase(x,cookie,f){
 const input=openingPayload([
  openingRow({centro:'C901',almacen:'A221',sap_code:'1053481',serial:'4060070-VAL-0023',quantity:1,lot:'NOVALORADO',reception_state:'REMANUFACTURADO'}),
  openingRow({centro:'C901',almacen:'A221',sap_code:f.sapBulk,quantity:2,lot:'VALORADO',reception_state:'NUEVO'})
 ]);
 const response=await openingApi(x,cookie,'/confirmar','POST',input);
 assert.equal(response.status,200,await response.clone().text());
 return response.json();
}
test('Corrección puntual del serial: actualiza SAP en ingreso, inventario e historial sin alterar otras existencias',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 const correction=prepareCorrectionFixture(x);
 const opened=await registerCorrectionCase(x,cookie,f);
 assert.equal(opened.totals.units,3);
 const initial= db.prepare("SELECT s.sap_code,i.sap_code AS item_sap,m.sap_code AS movement_sap,w.centro,w.almacen FROM inventory_serials s JOIN ingress_items i ON i.id=s.ingress_item_id JOIN inventory_movements m ON m.ingress_item_id=i.id JOIN master_logistics_locations w ON w.id=s.warehouse_id WHERE s.serial=?").get('4060070-VAL-0023');
 assert.equal(initial.sap_code,'1053481');
 assert.equal(initial.item_sap,'1053481');
 assert.equal(initial.movement_sap,'1053481');
 const masters={
  people:db.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,
  saps:db.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,
  locations:db.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n
 };
 const existing={
  serials:db.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,
  stock:db.prepare('SELECT quantity FROM inventory_bulk_stock WHERE warehouse_id=? AND sap_code=?').get(correction.warehouse,f.sapBulk).quantity,
  movements:db.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n
 };
 db.exec(sql18);
 const corrected= db.prepare("SELECT s.sap_code,i.sap_code AS item_sap,m.sap_code AS movement_sap,s.serial,s.warehouse_id,i.lot,i.reception_state,s.physical_state FROM inventory_serials s JOIN ingress_items i ON i.id=s.ingress_item_id JOIN inventory_movements m ON m.ingress_item_id=i.id WHERE s.serial=?").get('4060070-VAL-0023');
 assert.deepEqual([corrected.sap_code,corrected.item_sap,corrected.movement_sap],['4060070','4060070','4060070']);
 assert.equal(corrected.serial,'4060070-VAL-0023');
 assert.equal(corrected.warehouse_id,correction.warehouse);
 assert.deepEqual([corrected.lot,corrected.reception_state,corrected.physical_state],['NOVALORADO','REMANUFACTURADO','BUENO']);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_serials').get().n,existing.serials);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,existing.movements);
 assert.equal(db.prepare('SELECT quantity FROM inventory_bulk_stock WHERE warehouse_id=? AND sap_code=?').get(correction.warehouse,f.sapBulk).quantity,existing.stock);
 assert.deepEqual([db.prepare('SELECT COUNT(*) n FROM master_personnel').get().n,db.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,db.prepare('SELECT COUNT(*) n FROM master_logistics_locations').get().n],[masters.people,masters.saps,masters.locations]);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_sap_correction_log WHERE completed_at IS NOT NULL').get().n,1);
 assert.throws(()=>db.prepare("UPDATE ingress_items SET sap_code='1053481' WHERE serial='4060070-VAL-0023'").run(),/INGRESO_INMUTABLE/);
 db.exec(sql18);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_sap_correction_log').get().n,1);
 const preview=await dispatchApi(x,cookie,'/masivo/validar','POST',massPayload([
  massRow({technician:'77001122',centro:'C901',almacen:'A221',sap:'4060070',serial:'4060070-VAL-0023',quantity:1})
 ]));
 assert.equal(preview.status,200);
 assert.equal((await preview.json()).valid,true);
});
test('Corrección puntual se detiene sin cambios si el serial no coincide en bodega',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 prepareCorrectionFixture(x);
 const input=openingPayload([
  openingRow({centro:'C200',almacen:'A001',sap_code:'1053481',serial:'4060070-VAL-0023'})
 ]);
 assert.equal((await openingApi(x,cookie,'/confirmar','POST',input)).status,200);
 assert.throws(()=>db.exec(sql18),/CHECK constraint failed/);
 assert.equal(db.prepare("SELECT sap_code FROM inventory_serials WHERE serial=?").get('4060070-VAL-0023').sap_code,'1053481');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_sap_correction_log').get().n,0);
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='ingress_items_registered_update'").get());
});
test('Corrección puntual no edita seriales que ya están asignados a técnicos',async()=>{
 const x=setup(),cookie=await adminCookie(x),f=dispatchFixtures(x),db=x.database;
 const location=prepareCorrectionFixture(x);
 await registerCorrectionCase(x,cookie,f);
 const id=await newDispatch(x,cookie);
 const p={technician_id:f.tech,warehouse_id:location.warehouse,dispatch_date:'2026-11-11',notes:'',
  items:[{sap_code:'1053481',serial:'4060070-VAL-0023',quantity:1,notes:''}]};
 assert.equal((await dispatchApi(x,cookie,'/'+id,'PATCH',p)).status,200);
 assert.equal((await dispatchApi(x,cookie,'/'+id+'/confirmar','POST')).status,200);
 assert.throws(()=>db.exec(sql18),/CHECK constraint failed/);
 assert.equal(db.prepare("SELECT sap_code FROM inventory_serials WHERE serial=?").get('4060070-VAL-0023').sap_code,'1053481');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_sap_correction_log').get().n,0);
});
