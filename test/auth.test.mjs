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
const root='https://pulso-mintic.pages.dev';
function setup() {
  const database = new DatabaseSync(':memory:'); database.exec(sql); database.exec(sql3); database.exec(sql4); database.exec(sql5); database.exec(sql6); database.exec(sql7);
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
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,0);
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
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,2);
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
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,0);
  r=await warehouseImport(x,cookie,[...rows,{...warehouse('9999','0001'),administration:'OTRA'}],'commit');
  assert.equal(r.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,0);
  r=await warehouseImport(x,cookie,[...rows,rows[1]],'commit');
  assert.equal(r.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,0);
  r=await warehouseImport(x,cookie,rows,'commit');
  assert.equal(r.status,201);
  assert.equal((await r.json()).inserted,120);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,120);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouse_audit').get().n,120);
  assert.equal(x.database.prepare("SELECT COUNT(*) n FROM master_warehouses WHERE administration='PROPIA'").get().n,60);
  r=await warehouseImport(x,cookie,rows,'commit');
  assert.equal(r.status,422);
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,120);
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
  assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_warehouses').get().n,0);
});
