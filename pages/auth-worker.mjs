/** PULSO Pages: same-origin authentication, isolated from inventory movement APIs. */
const COOKIE = '__Host-pulso_session';
const SESSION_SECONDS = 8 * 60 * 60;
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' };
const json = (value, status = 200, other = {}) => new Response(JSON.stringify(value), {status, headers: {...jsonHeaders, ...other}});
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const randomBytes = length => crypto.getRandomValues(new Uint8Array(length));
const toBase64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hash = async text => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
const constantTimeHexEqual = (a, b) => {
  if (!/^[a-f0-9]{64}$/i.test(a || '') || !/^[a-f0-9]{64}$/i.test(b || '')) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
async function passwordHash(password, saltHex) {
  if (!/^[0-9a-f]{32}$/i.test(saltHex)) return null;
  const salt = new Uint8Array(saltHex.match(/../g).map(x => Number.parseInt(x, 16)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-512'}, key, 256)));
}
function cookieOf(request) {
  const header = request.headers.get('cookie') || '';
  const value = header.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  const token = value?.slice(COOKIE.length + 1) || '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function setSessionCookie(token) { return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`; }
function clearSessionCookie() { return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`; }
function sameOrigin(request) {
  const site = new URL(request.url);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  return origin === site.origin && (!fetchSite || ['same-origin', 'none'].includes(fetchSite));
}
function userSafe(user) { return { id: user.id, email: user.email, name: user.display_name, role: user.role }; }
async function currentUser(request, env) {
  const token = cookieOf(request);
  if (!token) return null;
  const tokenHash = await hash(token);
  const session = await env.DB.prepare(`SELECT u.id, u.email, u.display_name, u.role
    FROM auth_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1`)
    .bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  return session || null;
}
async function locked(db, keys, now) {
  for (const key of keys) {
    const attempt = await db.prepare('SELECT failures, locked_until FROM auth_attempts WHERE key = ?').bind(key).first();
    if (attempt && Number(attempt.locked_until) > now) return true;
  }
  return false;
}
async function recordFailure(db, keys, now) {
  const stmt = `INSERT INTO auth_attempts (key, failures, updated_at, locked_until) VALUES (?, 1, ?, 0)
    ON CONFLICT(key) DO UPDATE SET
      failures = CASE WHEN updated_at < excluded.updated_at - 900 THEN 1 ELSE failures + 1 END,
      locked_until = CASE
        WHEN updated_at < excluded.updated_at - 900 THEN 0
        WHEN failures + 1 >= ? THEN excluded.updated_at + 900
        ELSE locked_until END,
      updated_at = excluded.updated_at`;
  await db.batch(keys.map((key, i) => db.prepare(stmt).bind(key, now, i === 0 ? 12 : 5)));
}
async function login(request, env) {
  if (!sameOrigin(request)) return json({ok: false, error: 'ORIGEN_NO_AUTORIZADO'}, 403);
  if (!/application\/json/i.test(request.headers.get('content-type') || '')) return json({ok: false, error: 'TIPO_NO_VALIDO'}, 415);
  const body = await request.text();
  if (body.length > 1500) return json({ok: false, error: 'ENTRADA_INVALIDA'}, 400);
  let data;
  try { data = JSON.parse(body); } catch { return json({ok: false, error: 'ENTRADA_INVALIDA'}, 400); }
  const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
  const password = typeof data?.password === 'string' ? data.password : '';
  if (!/^[a-z0-9._+%-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254 || password.length < 1 || password.length > 128)
    return json({ok: false, error: 'CREDENCIALES_INVALIDAS'}, 401);
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'ip-desconocida';
  const keys = ['ip:' + await hash(ip), 'email:' + await hash(email)];
  if (await locked(env.DB, keys, now)) return json({ok: false, error: 'DEMASIADOS_INTENTOS'}, 429, {'retry-after':'900'});
  const user = await env.DB.prepare(`SELECT u.id, u.email, u.display_name, u.role, u.active,
    p.password_hash AS login_hash, p.password_salt AS login_salt, p.password_kdf AS login_kdf
    FROM app_users u LEFT JOIN auth_passwords p ON p.user_id = u.id
    WHERE u.email = ?`).bind(email).first();
  let matches = false;
  if (user && user.active === 1 && user.login_kdf === 'pbkdf2-sha512-100000') {
    const derived = await passwordHash(password, user.login_salt);
    matches = Boolean(derived && constantTimeHexEqual(derived, user.login_hash));
  }
  if (!matches) {
    await recordFailure(env.DB, keys, now);
    return json({ok: false, error: 'CREDENCIALES_INVALIDAS'}, 401);
  }
  await env.DB.batch(keys.map(key => env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key)));
  const token = toBase64url(randomBytes(32));
  const tokenHash = await hash(token);
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, user.id, now, now + SESSION_SECONDS).run();
  return json({ok: true, user: userSafe(user), redirect: '/inicio'}, 200, {'set-cookie': setSessionCookie(token)});
}
async function logout(request, env) {
  if (!sameOrigin(request)) return json({ok: false, error: 'ORIGEN_NO_AUTORIZADO'}, 403);
  const token = cookieOf(request);
  if (token) await env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').bind(Math.floor(Date.now() / 1000), await hash(token)).run();
  return json({ok: true}, 200, {'set-cookie': clearSessionCookie()});
}
function go(to) { return new Response(null, {status: 302, headers: {location: to, 'cache-control': 'private, no-store'}}); }
function securePage(response) {
  const next = new Response(response.body, response);
  next.headers.set('cache-control', 'no-store, private');
  return next;
}

/* Maestras: only ADMIN can read or edit. No registrations or operational imports. */
const DEPARTMENTS = new Set(['CESAR','LA GUAJIRA','SAN ANDRES']);
const PROFILE_TYPES = new Set(['CON PERFIL DE SERIE','SIN PERFIL DE SERIE']);
const CODE_TYPES = new Set(['EQUIPO','MATERIAL']);
const POSITIONS = new Set(['SUPERVISOR','TECNICO']);
const masterBad = (code, status = 400) => json({ok:false,error:code},status);
const trimmed = (v,max=120) => typeof v === 'string' ? v.trim().replace(/\s+/g,' ').slice(0,max+1) : '';
const emailOk = v => !v || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length<=254);
const fieldsOf = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k=>allowed.includes(k));
async function masterBody(request) {
  if (!sameOrigin(request)) return {error: 'ORIGEN_NO_AUTORIZADO',status:403};
  if (!/application\/json/i.test(request.headers.get('content-type')||'')) return {error:'TIPO_NO_VALIDO',status:415};
  const text = await request.text();
  if (text.length>6000) return {error:'DATOS_INVALIDOS',status:400};
  try {
    const data=JSON.parse(text);
    if (!data||typeof data!=='object'||Array.isArray(data)) return {error:'DATOS_INVALIDOS',status:400};
    return {data};
  } catch {return {error:'DATOS_INVALIDOS',status:400};}
}
async function writeAudit(db, actor, entity, id, action, fields) {
  return db.prepare('INSERT INTO master_audit (id,entity,record_id,action,actor_id,changed_fields) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),entity,id,action,actor,JSON.stringify(fields));
}
function normalizePersonnel(d) {
  const o={
    document_number:trimmed(d.document_number,25).toUpperCase(),
    full_name:trimmed(d.full_name,120),
    position:trimmed(d.position,15).toUpperCase(),
    department:trimmed(d.department,25).toUpperCase(),
    zone:trimmed(d.zone,80),
    city_base:trimmed(d.city_base,80),
    supervisor_id:trimmed(d.supervisor_id,80),
    email:trimmed(d.email,254).toLowerCase(),
    phone:trimmed(d.phone,30),
    is_active:d.is_active===false || d.is_active===0 ? 0 : 1
  };
  if (!/^[A-Z0-9-]{4,25}$/.test(o.document_number) ||
      o.full_name.length<3||o.full_name.length>120||
      !POSITIONS.has(o.position)||!DEPARTMENTS.has(o.department)||
      !emailOk(o.email)|| (o.phone && !/^[0-9+(). -]{5,30}$/.test(o.phone))||
      o.zone.length>80||o.city_base.length>80) return null;
  if(o.position==='SUPERVISOR'){
    if(o.zone.length<2||o.supervisor_id) return null;
    o.city_base='';
    o.supervisor_id=null;
  }else{
    if(o.city_base.length<2 || !/^[a-f0-9-]{36}$/i.test(o.supervisor_id)) return null;
    o.zone='';
  }
  return o;
}
function normalizeCatalog(d){
  const o={
    sap_code:trimmed(d.sap_code,50).toUpperCase(),
    description:trimmed(d.description,220),
    item_type:trimmed(d.item_type,25).toUpperCase(),
    serial_profile:trimmed(d.serial_profile,30).toUpperCase(),
    unit:trimmed(d.unit,12).toUpperCase(),
    family:trimmed(d.family,90),
    is_active:d.is_active===false || d.is_active===0 ? 0 : 1
  };
  if(!/^[A-Z0-9][A-Z0-9._/-]{1,49}$/.test(o.sap_code)||
    o.description.length<3||o.description.length>220||
    !CODE_TYPES.has(o.item_type)||!PROFILE_TYPES.has(o.serial_profile)||
    !/^[A-Z0-9]{1,12}$/.test(o.unit)||
    o.family.length>90) return null;
  return o;
}
async function masterHandler(request,env,user,path){
  if(!user) return masterBad('NO_AUTENTICADO',401);
  if(user.role!=='ADMIN') return masterBad('SIN_PERMISOS',403);
  const people=path==='/api/maestras/personal';
  const catalog=path==='/api/maestras/catalogo';
  if(!people&&!catalog)return masterBad('RUTA_NO_DISPONIBLE',404);
  if(request.method==='GET'){
    const result=people
      ? await env.DB.prepare(`SELECT p.id,p.document_number,p.full_name,p.position,p.department,p.zone,p.city_base,
          p.supervisor_id,p.email,p.phone,p.is_active,p.created_at,p.updated_at,
          s.full_name AS supervisor_name FROM master_personnel p LEFT JOIN master_personnel s ON s.id=p.supervisor_id
          ORDER BY p.position DESC,p.full_name COLLATE NOCASE LIMIT 500`).all()
      : await env.DB.prepare(`SELECT id,sap_code,description,item_type,serial_profile,unit,family,is_active,created_at,updated_at
          FROM master_sap_catalog ORDER BY description COLLATE NOCASE LIMIT 500`).all();
    return json({ok:true,items:result.results||[]});
  }
  if(!['POST','PATCH'].includes(request.method))return masterBad('METODO_NO_PERMITIDO',405);
  const payload=await masterBody(request);
  if(payload.error)return masterBad(payload.error,payload.status);
  const data=payload.data;
  const allowed=people
    ? ['id','document_number','full_name','position','department','zone','city_base','supervisor_id','email','phone','is_active']
    : ['id','sap_code','description','item_type','serial_profile','unit','family','is_active'];
  if(!fieldsOf(data,allowed)||!Object.keys(data).length)return masterBad('CAMPOS_NO_VALIDOS');
  const editing=request.method==='PATCH';
  let old=null;
  if(editing){
    if(typeof data.id!=='string'||!/^[a-f0-9-]{36}$/i.test(data.id))return masterBad('ID_INVALIDO');
    old=await env.DB.prepare(people?'SELECT * FROM master_personnel WHERE id=?':'SELECT * FROM master_sap_catalog WHERE id=?')
      .bind(data.id).first();
    if(!old)return masterBad('NO_ENCONTRADO',404);
    const frozen=people?['document_number','position']:['sap_code'];
    if(frozen.some(k=>Object.hasOwn(data,k)&&data[k]!==old[k]))return masterBad('CLAVE_INMUTABLE',409);
  }else if(Object.hasOwn(data,'id'))return masterBad('ID_NO_PERMITIDO');
  const merged={...(old||{}),...data};
  const v=people?normalizePersonnel(merged):normalizeCatalog(merged);
  if(!v)return masterBad('DATOS_INVALIDOS');
  if(people&&v.position==='TECNICO'){
    const boss=await env.DB.prepare(`SELECT id FROM master_personnel WHERE id=? AND position='SUPERVISOR' AND is_active=1`)
      .bind(v.supervisor_id).first();
    if(!boss)return masterBad('SUPERVISOR_NO_VALIDO',422);
  }
  if(people&&editing&&v.position==='SUPERVISOR'&&v.is_active===0&&old.is_active===1){
    const row=await env.DB.prepare(`SELECT id FROM master_personnel WHERE supervisor_id=? AND is_active=1 LIMIT 1`).bind(old.id).first();
    if(row)return masterBad('SUPERVISOR_CON_TECNICOS_ACTIVOS',409);
  }
  const uniqueKey=people?'document_number':'sap_code';
  const table=people?'master_personnel':'master_sap_catalog';
  const dup=await env.DB.prepare(`SELECT id FROM ${table} WHERE ${uniqueKey}=? LIMIT 1`).bind(v[uniqueKey]).first();
  if(dup&&(!old||dup.id!==old.id))return masterBad(people?'IDENTIFICACION_DUPLICADA':'SAP_DUPLICADO',409);
  const keys=Object.keys(v);
  const id=old?.id||crypto.randomUUID();
  const changed=editing?keys.filter(k=>String(v[k])!==String(old[k])):keys;
  if(editing&&!changed.length)return json({ok:true,id,unchanged:true});
  const action=editing && changed.length===1 && changed[0]==='is_active' ? (v.is_active?'ACTIVAR':'DESACTIVAR') : editing ? 'EDITAR':'CREAR';
  const actor=user.id;
  const stmt=editing
    ? env.DB.prepare(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')},updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(...keys.map(k=>v[k]),actor,id)
    : env.DB.prepare(`INSERT INTO ${table} (id,${keys.join(',')},created_by,updated_by) VALUES (${Array(keys.length+3).fill('?').join(',')})`)
        .bind(id,...keys.map(k=>v[k]),actor,actor);
  try{
    await env.DB.batch([stmt,await writeAudit(env.DB,actor,people?'PERSONAL':'CATALOGO_SAP',id,action,changed)]);
  }catch(err){
    if(String(err).includes('UNIQUE'))return masterBad(people?'IDENTIFICACION_DUPLICADA':'SAP_DUPLICADO',409);
    if(String(err).includes('FOREIGN KEY'))return masterBad('REFERENCIA_NO_VALIDA',422);
    throw err;
  }
  return json({ok:true,id,action},editing?200:201);
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/maestras/') || pathname === '/maestras' || pathname === '/maestras.html' || pathname === '/inicio' || pathname === '/inicio.html' || pathname === '/main' || pathname === '/main.html') {
        if (!env.DB) return json({ok: false, error: 'SERVICIO_NO_CONFIGURADO'}, 503);
        if (pathname === '/api/auth/health' && request.method === 'GET') {
          await env.DB.prepare('SELECT id FROM app_users LIMIT 1').first();
          return json({ok: true, service: 'pulso-auth', ready: true});
        }
        if (pathname.startsWith('/api/maestras/')) return await masterHandler(request,env,await currentUser(request,env),pathname);
        if (pathname === '/maestras' || pathname === '/maestras.html') {
          if(request.method!=='GET'&&request.method!=='HEAD')return masterBad('METODO_NO_PERMITIDO',405);
          const user=await currentUser(request,env);
          if(!user)return go('/main');
          if(user.role!=='ADMIN')return go('/inicio');
          return securePage(await env.ASSETS.fetch(request));
        }
        if (pathname === '/api/auth/login' && request.method === 'POST') return await login(request, env);
        if (pathname === '/api/auth/logout' && request.method === 'POST') return await logout(request, env);
        if (pathname === '/api/auth/me' && request.method === 'GET') {
          const user = await currentUser(request, env);
          return user ? json({ok:true, user:userSafe(user)}) : json({ok:false,error:'NO_AUTENTICADO'},401);
        }
        if (pathname === '/inicio' || pathname === '/inicio.html') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json({error:'METODO_NO_PERMITIDO'},405);
          const user = await currentUser(request, env);
          if (!user) return go('/main');
          return securePage(await env.ASSETS.fetch(request));
        }
        if (pathname === '/main' || pathname === '/main.html') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json({error:'METODO_NO_PERMITIDO'},405);
          if (await currentUser(request, env)) return go('/inicio');
          return securePage(await env.ASSETS.fetch(request));
        }
        return json({error: 'RUTA_NO_DISPONIBLE'},404);
      }
      if (pathname.startsWith('/api/')) return json({error:'RUTA_NO_DISPONIBLE'},404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('PULSO auth failure', {path:pathname, error:error instanceof Error ? error.name : 'unknown'});
      return json({ok:false,error:'SERVICIO_TEMPORALMENTE_NO_DISPONIBLE'},503);
    }
  }
};