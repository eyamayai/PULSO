import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import worker from '../pages/auth-worker.mjs';
const sql = fs.readFileSync(new URL('../cloudflare/migrations/0002_autenticacion.sql', import.meta.url), 'utf8');
const sql3 = fs.readFileSync(new URL('../cloudflare/migrations/0003_auth_passwords_compat.sql', import.meta.url), 'utf8');
const root='https://pulso-mintic.pages.dev';
function setup() {
  const database = new DatabaseSync(':memory:'); database.exec(sql); database.exec(sql3);
  const wrap = stmt => {
    let args=[];
    return {
      bind(...values){ args=values;return this; },
      async first(){return database.prepare(stmt).get(...args)||null},
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
