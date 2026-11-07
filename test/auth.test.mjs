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
const root='https://pulso-mintic.pages.dev';
function setup({legacyWarehouse=false}={}) {
  const database = new DatabaseSync(':memory:'); database.exec(sql); database.exec(sql3); database.exec(sql4); database.exec(sql5); database.exec(sql6); database.exec(sql7); if(!legacyWarehouse){database.exec(sql8);database.exec(sql9);database.exec(sql10);database.exec(sql11);database.exec(sql12);}
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
