import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import worker from '../pages/auth-worker.mjs';
const sql = fs.readFileSync(new URL('../cloudflare/migrations/0002_autenticacion.sql', import.meta.url), 'utf8');
const sql3 = fs.readFileSync(new URL('../cloudflare/migrations/0003_auth_passwords_compat.sql', import.meta.url), 'utf8');
const sql4=fs.readFileSync(new URL('../cloudflare/migrations/0004_maestras_personal_y_sap.sql',import.meta.url),'utf8');
const root='https://pulso-mintic.pages.dev';
function setup() {
  const database = new DatabaseSync(':memory:'); database.exec(sql); database.exec(sql3); database.exec(sql4);
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
 x.database.prepare("UPDATE app_users SET role='AUDITOR' WHERE email='admin@example.com'").run();
 assert.equal((await worker.fetch(x.req('/api/maestras/personal',{headers:{cookie}}),x.env)).status,403);
 assert.equal((await worker.fetch(x.req('/maestras',{headers:{cookie}}),x.env)).status,302);
 x.database.prepare("UPDATE app_users SET role='ADMIN' WHERE email='admin@example.com'").run();
 const forbidden=await worker.fetch(x.req('/api/maestras/catalogo',{method:'POST',data:sapItem,origin:'https://ajeno.example',headers:{cookie}}),x.env);
 assert.equal(forbidden.status,403);
 assert.equal(x.database.prepare('SELECT COUNT(*) n FROM master_sap_catalog').get().n,0);
});
