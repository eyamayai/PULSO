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
function canonicalDepartment(value) {
  const v=trimmed(value,60).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  if(v==='GUAJIRA'||v==='LA GUAJIRA')return 'LA GUAJIRA';
  if(v==='SAN ANDRES'||v==='SAN ANDRES Y PROVIDENCIA')return 'SAN ANDRES';
  return v;
}
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
    department:canonicalDepartment(d.department),
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
function parseUnitValueCents(value){
 if(value===null||value===undefined||value==='')return null;
 if(typeof value!=='number'&&typeof value!=='string')return NaN;
 const raw=String(value).trim();
 if(!raw)return null;
 if(!/^[0-9]{1,10}(?:\.[0-9]{1,2})?$/.test(raw))return NaN;
 const [major,minor='']=raw.split('.');
 const cents=Number(major)*100+Number(minor.padEnd(2,'0'));
 return Number.isSafeInteger(cents)&&cents<=999999999999?cents:NaN;
}
function normalizeCatalog(d){
 const valueCents=Object.hasOwn(d,'unit_value')?parseUnitValueCents(d.unit_value):
  (d.unit_value_cents===null||d.unit_value_cents===undefined?null:
   (Number.isSafeInteger(d.unit_value_cents)&&d.unit_value_cents>=0&&d.unit_value_cents<=999999999999?d.unit_value_cents:NaN));
  const o={
    sap_code:trimmed(d.sap_code,50).toUpperCase(),
    description:trimmed(d.description,220),
    item_type:trimmed(d.item_type,25).toUpperCase(),
    serial_profile:trimmed(d.serial_profile,30).toUpperCase(),
    unit:trimmed(d.unit,12).toUpperCase(),
    family:trimmed(d.family,90),
    unit_value_cents:valueCents,
    is_active:d.is_active===false || d.is_active===0 ? 0 : 1
  };
  if(!/^[A-Z0-9][A-Z0-9._/-]{1,49}$/.test(o.sap_code)||
    o.description.length<3||o.description.length>220||
    !CODE_TYPES.has(o.item_type)||!PROFILE_TYPES.has(o.serial_profile)||
    !/^[A-Z0-9]{1,12}$/.test(o.unit)||
    o.family.length>90||Number.isNaN(o.unit_value_cents)) return null;
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
          s.full_name AS supervisor_name,l.user_id AS access_user_id,
          u.role AS access_role,u.active AS access_active,
          CASE WHEN l.user_id IS NULL THEN 'SIN_ACCESO'
               WHEN pass.user_id IS NOT NULL THEN 'CONFIGURADA'
               WHEN EXISTS(SELECT 1 FROM app_user_invitations inv
                 WHERE inv.user_id=l.user_id AND inv.used_at IS NULL
                   AND inv.revoked_at IS NULL AND inv.expires_at>?) THEN 'INVITADO'
               ELSE 'SIN_CLAVE' END AS access_status
          FROM master_personnel p
          LEFT JOIN master_personnel s ON s.id=p.supervisor_id
          LEFT JOIN app_personnel_user_links l ON l.personnel_id=p.id
          LEFT JOIN app_users u ON u.id=l.user_id
          LEFT JOIN auth_passwords pass ON pass.user_id=l.user_id
          ORDER BY p.position DESC,p.full_name COLLATE NOCASE LIMIT 500`).bind(Math.floor(Date.now()/1000)).all()
      : await env.DB.prepare(`SELECT id,sap_code,description,item_type,serial_profile,unit,family,unit_value_cents,is_active,created_at,updated_at
          FROM master_sap_catalog ORDER BY description COLLATE NOCASE LIMIT 500`).all();
    return json({ok:true,items:result.results||[]});
  }
  if(!['POST','PATCH'].includes(request.method))return masterBad('METODO_NO_PERMITIDO',405);
  const payload=await masterBody(request);
  if(payload.error)return masterBad(payload.error,payload.status);
  const data=payload.data;
  const allowed=people
    ? ['id','document_number','full_name','position','department','zone','city_base','supervisor_id','email','phone','is_active']
    : ['id','sap_code','description','item_type','serial_profile','unit','family','unit_value','is_active'];
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


/**
 * Carga masiva de maestras: vista previa y guardado atómico por archivo.
 * La hoja de técnicos referencia supervisores EXISTENTES por identificación.
 * Cada request usa JSON parametrizado para reducir consultas D1.
 */
const IMPORT_MAX_ROWS = 1000;
const IMPORT_MAX_BYTES = 540000;
const IMPORT_TYPES = new Set(['SUPERVISORES','TECNICOS','CATALOGO']);
const IMPORT_COLUMNS = {
  SUPERVISORES:['document_number','full_name','department','zone','email','phone','is_active'],
  TECNICOS:['document_number','full_name','department','city_base','supervisor_document','email','phone','is_active'],
  CATALOGO:['sap_code','description','item_type','serial_profile','unit','family','is_active']
};
// Carga controlada: si el SAP existe se actualiza exclusivamente su valoración.
async function bulkCatalogValues(input,env,user){
 const errors=[],seen=new Map(),source=[];
 const err=(row,field,message)=>{if(errors.length<40)errors.push({row,field,message});};
 for(let i=0;i<input.rows.length;i++){
  const row=i+2,item=input.rows[i];
  if(!fieldsOf(item,['sap_code','description','item_type','serial_profile','unit','family','is_active','unit_value'])){
   err(row,'Columnas','Columnas inesperadas o registro inválido');continue;
  }
  const code=trimmed(item.sap_code,50).toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9._/-]{1,49}$/.test(code)){
   err(row,'Código SAP','Código SAP obligatorio o inválido');continue;
  }
  if(item.is_active!==undefined&&![true,false,0,1].includes(item.is_active)){
   err(row,'Estado','Debe ser Activo o Inactivo');continue;
  }
  const cents=parseUnitValueCents(item.unit_value);
  if(Number.isNaN(cents)){
   err(row,'Valor del equipo','Usa COP sin separador de miles y máximo dos decimales');continue;
  }
  if(seen.has(code)){err(row,'Código SAP','Repetido dentro del Excel (fila '+seen.get(code)+')');continue;}
  seen.set(code,row);source.push({row,code,cents,item});
 }
 const found=source.length?(await env.DB.prepare(
  "SELECT id,sap_code,unit_value_cents FROM master_sap_catalog WHERE sap_code IN (SELECT value FROM json_each(?))"
 ).bind(JSON.stringify(source.map(x=>x.code))).all()).results||[]:[];
 const existing=new Map(found.map(x=>[String(x.sap_code).toUpperCase(),x]));
 const inserts=[],updates=[];let unchanged=0;
 for(const entry of source){
  const old=existing.get(entry.code);
  if(old){
   if(entry.cents===null||old.unit_value_cents===entry.cents){unchanged++;continue;}
   updates.push({id:old.id,audit_id:crypto.randomUUID(),unit_value_cents:entry.cents});
  }else{
   const normalized=normalizeCatalog({...entry.item,sap_code:entry.code});
   if(!normalized){err(entry.row,'Datos','SAP nuevo: diligencia descripción, tipo, perfil y unidad');continue;}
   inserts.push({...normalized,id:crypto.randomUUID(),audit_id:crypto.randomUUID()});
  }
 }
 if(errors.length){
  if(input.mode==='validate')return json({ok:true,valid:false,total:input.rows.length,errors});
  return json({ok:false,error:'ARCHIVO_CON_ERRORES',total:input.rows.length,errors},422);
 }
 const stats={total:input.rows.length,inserted:inserts.length,updated:updates.length,unchanged};
 if(input.mode==='validate')return json({ok:true,valid:true,...stats,errors:[]});
 const statements=[];
 if(inserts.length){
  const fields=['id','sap_code','description','item_type','serial_profile','unit','family','unit_value_cents','is_active'];
  const data=JSON.stringify(inserts),selects=fields.map(k=>"json_extract(value,'$."+k+"')").join(',');
  statements.push(env.DB.prepare(
   'INSERT INTO master_sap_catalog ('+fields.join(',')+',created_by,updated_by) SELECT '+selects+',?,? FROM json_each(?)'
  ).bind(user.id,user.id,data));
  statements.push(env.DB.prepare(
   "INSERT INTO master_audit(id,entity,record_id,action,actor_id,changed_fields) "+
   "SELECT json_extract(value,'$.audit_id'),'CATALOGO_SAP',json_extract(value,'$.id'),'CREAR',?,? FROM json_each(?)"
  ).bind(user.id,JSON.stringify(fields),data));
 }
 if(updates.length){
  const data=JSON.stringify(updates);
  statements.push(env.DB.prepare(
   "UPDATE master_sap_catalog AS t SET unit_value_cents=json_extract(j.value,'$.unit_value_cents'), "+
   "updated_by=?,updated_at=CURRENT_TIMESTAMP FROM json_each(?) AS j WHERE t.id=json_extract(j.value,'$.id')"
  ).bind(user.id,data));
  statements.push(env.DB.prepare(
   "INSERT INTO master_audit(id,entity,record_id,action,actor_id,changed_fields) "+
   "SELECT json_extract(value,'$.audit_id'),'CATALOGO_SAP',json_extract(value,'$.id'),'EDITAR',?,'[\"unit_value_cents\"]' FROM json_each(?)"
  ).bind(user.id,data));
 }
 try{if(statements.length)await env.DB.batch(statements);}
 catch(e){
  if(/UNIQUE|constraint|FOREIGN KEY/i.test(String(e)))return masterBad('CONFLICTO_IMPORTACION',409);
  throw e;
 }
 return json({ok:true,...stats},201);
}
async function bulkImport(request,env,user){
  if(!user)return masterBad('NO_AUTENTICADO',401);
  if(user.role!=='ADMIN')return masterBad('SIN_PERMISOS',403);
  if(request.method!=='POST')return masterBad('METODO_NO_PERMITIDO',405);
  if(!sameOrigin(request))return masterBad('ORIGEN_NO_AUTORIZADO',403);
  if(!/application\/json/i.test(request.headers.get('content-type')||''))return masterBad('TIPO_NO_VALIDO',415);
  const raw=await request.text();
  if(raw.length>IMPORT_MAX_BYTES)return masterBad('ARCHIVO_DEMASIADO_GRANDE',413);
  let input;
  try{input=JSON.parse(raw);}catch{return masterBad('DATOS_INVALIDOS');}
  if(!input||typeof input!=='object'||Array.isArray(input)||
     !['validate','commit'].includes(input.mode)||!IMPORT_TYPES.has(input.kind)||
     !Array.isArray(input.rows)||input.rows.length<1||input.rows.length>IMPORT_MAX_ROWS ||
     Object.keys(input).some(k=>!['kind','mode','rows'].includes(k)))return masterBad('ARCHIVO_INVALIDO');
  if(input.kind==='CATALOGO')return bulkCatalogValues(input,env,user);
  const kind=input.kind, personal=kind!=='CATALOGO';
  const allowed=IMPORT_COLUMNS[kind];
  const errors=[];
  const addError=(row,field,reason)=>{if(errors.length<40)errors.push({row,field,message:reason});};
  const keys=new Map();
  const normalized=[];
  const placeholder='00000000-0000-4000-8000-000000000000';
  for(let i=0;i<input.rows.length;i++){
    const row=i+2,rawItem=input.rows[i];
    if(!fieldsOf(rawItem,allowed)){
      addError(row,'Columnas','Columnas inesperadas o registro no válido');
      continue;
    }
    if(rawItem.is_active!==undefined&&![true,false,0,1].includes(rawItem.is_active)){
      addError(row,'Estado','El estado debe ser Activo o Inactivo');
      continue;
    }
    const data=personal?normalizePersonnel({
      ...rawItem,
      position:kind==='SUPERVISORES'?'SUPERVISOR':'TECNICO',
      supervisor_id:kind==='TECNICOS'?placeholder:''
    }):normalizeCatalog({...rawItem,unit:rawItem.unit||'UND'});
    if(!data){
      if(personal&&!DEPARTMENTS.has(canonicalDepartment(rawItem.department))){
        addError(row,'Departamento','Departamento no reconocido. Usa Cesar, Guajira o San Andrés');
      }else{
        addError(row,'Datos','Falta información o existe un valor/formato inválido');
      }
      continue;
    }
    if(kind==='TECNICOS'){
      const supervisorDoc=trimmed(rawItem.supervisor_document,25).toUpperCase();
      if(!/^[A-Z0-9-]{4,25}$/.test(supervisorDoc)){
        addError(row,'Identificación Supervisor','Debes indicar la identificación del supervisor');
        continue;
      }
      data.supervisor_document=supervisorDoc;
    }
    const key=personal?data.document_number:data.sap_code;
    if(keys.has(key)){addError(row,personal?'Identificación':'Código SAP','Duplicado dentro del archivo (fila '+keys.get(key)+')');continue;}
    keys.set(key,row);
    data.id=crypto.randomUUID();
    data.audit_id=crypto.randomUUID();
    normalized.push(data);
  }
  if(normalized.length){
    const table=personal?'master_personnel':'master_sap_catalog';
    const column=personal?'document_number':'sap_code';
    const existing=await env.DB.prepare(
      `SELECT ${column} AS code FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify([...keys.keys()])).all();
    for(const found of existing.results||[]){
      const key=String(found.code).toUpperCase();
      addError(keys.get(key)||2,personal?'Identificación':'Código SAP',
        personal?'Identificación ya registrada en la maestra':'Código SAP ya registrado en la maestra');
    }
    if(kind==='TECNICOS'){
      const docs=[...new Set(normalized.map(r=>r.supervisor_document))];
      const supervisors=await env.DB.prepare(
        `SELECT id,document_number,is_active FROM master_personnel
           WHERE position='SUPERVISOR' AND document_number IN (SELECT value FROM json_each(?))`
      ).bind(JSON.stringify(docs)).all();
      const bosses=new Map((supervisors.results||[]).filter(b=>b.is_active===1).map(b=>[b.document_number.toUpperCase(),b.id]));
      for(const item of normalized){
        const id=bosses.get(item.supervisor_document);
        if(!id)addError(keys.get(item.document_number),'Identificación Supervisor','Supervisor no registrado o inactivo');
        else item.supervisor_id=id;
        delete item.supervisor_document;
      }
    }
  }
  if(errors.length){
    if(input.mode==='validate')return json({ok:true,valid:false,total:input.rows.length,errors});
    return json({ok:false,error:'ARCHIVO_CON_ERRORES',total:input.rows.length,errors},422);
  }
  if(input.mode==='validate')return json({ok:true,valid:true,total:normalized.length,errors:[]});
  const fields=personal
    ? ['id','document_number','full_name','position','department','zone','city_base','supervisor_id','email','phone','is_active']
    : ['id','sap_code','description','item_type','serial_profile','unit','family','is_active'];
  const jsonRows=JSON.stringify(normalized);
  const selects=fields.map(k=>`json_extract(value,'$.${k}')`).join(',');
  const table=personal?'master_personnel':'master_sap_catalog';
  const entity=personal?'PERSONAL':'CATALOGO_SAP';
  const insert=env.DB.prepare(
    `INSERT INTO ${table} (${fields.join(',')},created_by,updated_by)
      SELECT ${selects},?,? FROM json_each(?)`
  ).bind(user.id,user.id,jsonRows);
  const audit=env.DB.prepare(
    `INSERT INTO master_audit(id,entity,record_id,action,actor_id,changed_fields)
      SELECT json_extract(value,'$.audit_id'),? ,json_extract(value,'$.id'),'CREAR',?,?
      FROM json_each(?)`
  ).bind(entity,user.id,JSON.stringify(fields),jsonRows);
  try {
    await env.DB.batch([insert,audit]);
  } catch(e) {
    if(/UNIQUE|constraint|FOREIGN KEY|SUPERVISOR_/i.test(String(e))){
      return masterBad('CONFLICTO_IMPORTACION',409);
    }
    throw e;
  }
  return json({ok:true,inserted:normalized.length,total:normalized.length},201);
}


/* Gestión de cuentas: acceso independiente de las fichas operativas. */
const USER_ROLES = new Set(['ADMIN','SUPERVISOR','TECNICO','AUDITOR']);
const INVITATION_SECONDS = 48 * 60 * 60;
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
function userError(code, status=400){return json({ok:false,error:code},status);}
function userEmail(value){
  const email=trimmed(value,254).toLowerCase();
  return /^[a-z0-9._+%-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)&&email.length<=254 ? email : null;
}
function userDetail(data){
  const name=trimmed(data.display_name,120);
  const role=trimmed(data.role,30).toUpperCase();
  const doc=trimmed(data.document_number,25).toUpperCase();
  const job=trimmed(data.job_title,100);
  const phone=trimmed(data.phone,30);
  if(name.length<3||name.length>120||!USER_ROLES.has(role)||
     (doc&&!/^[A-Z0-9-]{4,25}$/.test(doc))||
     job.length>100||(phone&&!/^[0-9+(). -]{5,30}$/.test(phone)))return null;
  return {display_name:name,role,document_number:doc||null,job_title:job,phone};
}
function createInviteData(id,actor,purpose,now){
  const token=toBase64url(randomBytes(32));
  return {token,id,actor,purpose,now,expiry:now+INVITATION_SECONDS};
}
async function userAudit(db,userId,actorId,action,fields){
  return db.prepare('INSERT INTO app_user_audit (id,user_id,actor_id,action,changed_fields) VALUES (?,?,?,?,?)')
    .bind(crypto.randomUUID(),userId,actorId,action,JSON.stringify(fields));
}
async function inviteStatements(db,info){
  const tokenHash=await hash(info.token);
  return [
    db.prepare('UPDATE app_user_invitations SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL')
      .bind(info.now,info.id),
    db.prepare('INSERT INTO app_user_invitations (token_hash,user_id,purpose,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .bind(tokenHash,info.id,info.purpose,info.actor,info.now,info.expiry),
    await userAudit(db,info.id,info.actor,info.purpose==='ACTIVAR'?'INVITAR':'RESTABLECER',['invitacion'])
  ];
}
function invitationLink(request,token){
  const origin=new URL(request.url).origin;
  // El token en # no llega al servidor ni a las cabeceras HTTP en el GET.
  return origin+'/activar#'+token;
}
async function userManagement(request,env,user,path){
  if(!user)return userError('NO_AUTENTICADO',401);
  if(user.role!=='ADMIN')return userError('SIN_PERMISOS',403);
  if(request.method==='GET'&&path==='/api/usuarios'){
    const result=await env.DB.prepare(
      "SELECT u.id,u.email,u.display_name,u.role,u.active,u.created_at,"+
      "d.document_number,d.job_title,d.phone,l.personnel_id,"+
      "CASE WHEN p.user_id IS NOT NULL THEN 'CONFIGURADA' WHEN EXISTS ("+
      "SELECT 1 FROM app_user_invitations i WHERE i.user_id=u.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?) "+
      "THEN 'INVITADO' ELSE 'SIN_CLAVE' END AS credential_status "+
      "FROM app_users u LEFT JOIN app_user_details d ON d.user_id=u.id "+
      "LEFT JOIN auth_passwords p ON p.user_id=u.id "+
      "LEFT JOIN app_personnel_user_links l ON l.user_id=u.id "+
      "ORDER BY u.created_at,u.display_name COLLATE NOCASE LIMIT 500"
    ).bind(Math.floor(Date.now()/1000)).all();
    return json({ok:true,items:result.results||[],current_user_id:user.id,roles:[...USER_ROLES]});
  }
  if(request.method!=='POST'&&request.method!=='PATCH')return userError('METODO_NO_PERMITIDO',405);
  const parsed=await adminJson(request,3200);
  if(parsed.error)return userError(parsed.error,parsed.status);
  const data=parsed.data;
  const now=Math.floor(Date.now()/1000);
  if(path==='/api/usuarios/invitaciones'){
    if(request.method!=='POST'||!fieldsOf(data,['id'])||typeof data.id!=='string')return userError('DATOS_INVALIDOS');
    const account=await env.DB.prepare('SELECT id,active FROM app_users WHERE id=?').bind(data.id).first();
    if(!account)return userError('USUARIO_NO_ENCONTRADO',404);
    const existing=await env.DB.prepare('SELECT user_id FROM auth_passwords WHERE user_id=?').bind(data.id).first();
    const purpose=existing?'RESTABLECER':'ACTIVAR';
    if(existing&&account.active!==1)return userError('USUARIO_INACTIVO',409);
    const info=createInviteData(account.id,user.id,purpose,now);
    await env.DB.batch(await inviteStatements(env.DB,info));
    return json({ok:true,link:invitationLink(request,info.token),expires_hours:48,purpose},201);
  }
  if(path!=='/api/usuarios')return userError('RUTA_NO_DISPONIBLE',404);
  if(request.method==='POST'){
    if(!fieldsOf(data,['email','display_name','role','document_number','job_title','phone']))
      return userError('CAMPOS_NO_VALIDOS');
    const email=userEmail(data.email);
    const v=userDetail(data);
    if(!email||!v||!v.document_number)return userError('DATOS_INVALIDOS');
    const id=crypto.randomUUID(),info=createInviteData(id,user.id,'ACTIVAR',now);
    const stmts=[
      env.DB.prepare("INSERT INTO app_users (id,email,display_name,password_hash,password_salt,password_kdf,role,active) "+
        "VALUES (?,?,?,'','','pbkdf2-sha512-220000',?,0)")
        .bind(id,email,v.display_name,v.role),
      env.DB.prepare('INSERT INTO app_user_details (user_id,document_number,job_title,phone) VALUES (?,?,?,?)')
        .bind(id,v.document_number,v.job_title,v.phone),
      await userAudit(env.DB,id,user.id,'CREAR',['email','display_name','role','document_number','job_title','phone']),
      ...(await inviteStatements(env.DB,info)).slice(1)
    ];
    try{await env.DB.batch(stmts);}
    catch(e){
      if(/UNIQUE|constraint/i.test(String(e)))return userError('USUARIO_O_IDENTIFICACION_DUPLICADA',409);
      throw e;
    }
    return json({ok:true,id,link:invitationLink(request,info.token),expires_hours:48},201);
  }
  if(!fieldsOf(data,['id','display_name','role','document_number','job_title','phone','active'])||
    typeof data.id!=='string'||!(/^[a-f0-9-]{36}$/i.test(data.id)))return userError('DATOS_INVALIDOS');
  const current=await env.DB.prepare(
    'SELECT u.id,u.display_name,u.role,u.active,d.document_number,d.job_title,d.phone FROM app_users u '+
    'LEFT JOIN app_user_details d ON d.user_id=u.id WHERE u.id=?'
  ).bind(data.id).first();
  if(!current)return userError('USUARIO_NO_ENCONTRADO',404);
  if(own(data,'active')&&typeof data.active!=='boolean')return userError('DATOS_INVALIDOS');
  const v=userDetail({
    display_name:own(data,'display_name')?data.display_name:current.display_name,
    role:own(data,'role')?data.role:current.role,
    document_number:own(data,'document_number')?data.document_number:current.document_number,
    job_title:own(data,'job_title')?data.job_title:current.job_title,
    phone:own(data,'phone')?data.phone:current.phone
  });
  if(!v)return userError('DATOS_INVALIDOS');
  const active=own(data,'active')?(data.active?1:0):current.active;
  if(user.id===current.id && (v.role!==current.role || active!==current.active))
    return userError('NO_MODIFICAR_AUTOPERMISOS',409);
  if(active===1 && current.active!==1){
    const credential=await env.DB.prepare('SELECT user_id FROM auth_passwords WHERE user_id=?').bind(current.id).first();
    if(!credential)return userError('CUENTA_SIN_CLAVE',409);
  }
  const fields=['display_name','role','document_number','job_title','phone','active'];
  const changed=fields.filter(k=>String(k==='active'?active:v[k])!==String(current[k]));
  if(!changed.length)return json({ok:true,unchanged:true});
  let action='EDITAR';
  if(changed.length===1&&changed[0]==='active') action=active?'ACTIVAR':'DESACTIVAR';
  const stmts=[
    env.DB.prepare('UPDATE app_users SET display_name=?,role=?,active=? WHERE id=?')
      .bind(v.display_name,v.role,active,current.id),
    env.DB.prepare('INSERT INTO app_user_details (user_id,document_number,job_title,phone) VALUES (?,?,?,?) '+
      'ON CONFLICT(user_id) DO UPDATE SET document_number=excluded.document_number,job_title=excluded.job_title,phone=excluded.phone,updated_at=CURRENT_TIMESTAMP')
      .bind(current.id,v.document_number,v.job_title,v.phone),
    await userAudit(env.DB,current.id,user.id,action,changed)
  ];
  if(v.role!==current.role||active!==current.active)
    stmts.push(env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now,current.id));
  // Una cuenta desactivada o con perfil modificado no conservará enlaces anteriores.
  if((active===0&&current.active!==0)||v.role!==current.role)
    stmts.push(env.DB.prepare('UPDATE app_user_invitations SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL')
      .bind(now,current.id));
  try{await env.DB.batch(stmts);}
  catch(e){
    if(String(e).includes('ULTIMO_ADMINISTRADOR'))return userError('ULTIMO_ADMINISTRADOR',409);
    if(/UNIQUE|constraint/i.test(String(e)))return userError('IDENTIFICACION_DUPLICADA',409);
    throw e;
  }
  return json({ok:true,id:current.id,action});
}
async function adminJson(request,max=3200){
  if(!sameOrigin(request))return {error:'ORIGEN_NO_AUTORIZADO',status:403};
  if(!/application\/json/i.test(request.headers.get('content-type')||''))return {error:'TIPO_NO_VALIDO',status:415};
  const body=await request.text();
  if(body.length>max)return {error:'DATOS_INVALIDOS',status:400};
  try {
    const data=JSON.parse(body);
    if(!data||typeof data!=='object'||Array.isArray(data))return {error:'DATOS_INVALIDOS',status:400};
    return {data};
  }catch{return {error:'DATOS_INVALIDOS',status:400};}
}
async function acceptInvitation(request,env){
  if(request.method!=='POST')return userError('METODO_NO_PERMITIDO',405);
  const parsed=await adminJson(request,1800);
  if(parsed.error)return userError(parsed.error,parsed.status);
  const data=parsed.data;
  if(!fieldsOf(data,['token','email','password'])||
     typeof data.token!=='string'||!(/^[A-Za-z0-9_-]{43}$/.test(data.token))||
     typeof data.password!=='string'||data.password.length<14||data.password.length>128||
     !/[A-Z]/.test(data.password)||!/[a-z]/.test(data.password)||
     !/[0-9]/.test(data.password)||!(/[^A-Za-z0-9]/.test(data.password)))
    return userError('DATOS_INVALIDOS');
  const email=userEmail(data.email);
  if(!email)return userError('DATOS_INVALIDOS');
  const tokenHash=await hash(data.token);
  const now=Math.floor(Date.now()/1000);
  const invitation=await env.DB.prepare(
    'SELECT i.user_id,i.purpose,u.email,u.active FROM app_user_invitations i '+
    'JOIN app_users u ON u.id=i.user_id '+
    'WHERE i.token_hash=? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?'
  ).bind(tokenHash,now).first();
  if(!invitation||invitation.email.toLowerCase()!==email ||
     (invitation.purpose==='RESTABLECER'&&invitation.active!==1) ||
     (invitation.purpose==='ACTIVAR'&&invitation.active===1))
    return userError('INVITACION_NO_VALIDA',400);
  const salt=hex(randomBytes(16));
  const derived=await passwordHash(data.password,salt);
  if(!derived)return userError('DATOS_INVALIDOS');
  // Todas las operaciones permanecen dentro de una transacción D1.
  // La primera escritura comprueba nuevamente que la invitación no haya sido consumida.
  const validPredicate='SELECT i.user_id FROM app_user_invitations i WHERE i.token_hash=? AND '+
    'i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?';
  const stmts=[
    env.DB.prepare("INSERT INTO auth_passwords(user_id,password_hash,password_salt,password_kdf) "+
      "SELECT i.user_id,?,?,'pbkdf2-sha512-100000' FROM app_user_invitations i "+
      "WHERE i.token_hash=? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>? "+
      "ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,password_salt=excluded.password_salt,"+
      "password_kdf=excluded.password_kdf,updated_at=CURRENT_TIMESTAMP")
      .bind(derived,salt,tokenHash,now),
    env.DB.prepare('UPDATE app_users SET active=1 WHERE id IN ('+validPredicate+')').bind(tokenHash,now),
    env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id IN ('+validPredicate+') AND revoked_at IS NULL')
      .bind(now,tokenHash,now),
    env.DB.prepare("INSERT INTO app_user_audit(id,user_id,actor_id,action,changed_fields) "+
      "SELECT ?,i.user_id,i.user_id,'ACEPTAR_INVITACION','[\"password\"]' FROM app_user_invitations i "+
      "WHERE i.token_hash=? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?")
      .bind(crypto.randomUUID(),tokenHash,now),
    env.DB.prepare('UPDATE app_user_invitations SET used_at=? WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?')
      .bind(now,tokenHash,now)
  ];
  const outcome=await env.DB.batch(stmts);
  if(!(outcome[0]?.meta?.changes ?? outcome[0]?.changes))return userError('INVITACION_NO_VALIDA',400);
  return json({ok:true,redirect:'/main'});
}


/* Vinculación opcional: datos de Personal se reutilizan, la cuenta se crea sin contraseña.
 * Se permite acceso solo tras invitación explícita, y se rechaza cualquier duplicado.
 * La validación es preliminar; commit vuelve a comprobar y usa una transacción D1.
 */
async function linkPersonnelToUsers(request,env,user) {
  if(!user)return userError('NO_AUTENTICADO',401);
  if(user.role!=='ADMIN')return userError('SIN_PERMISOS',403);
  if(request.method!=='POST')return userError('METODO_NO_PERMITIDO',405);
  const parsed=await adminJson(request,18000);
  if(parsed.error)return userError(parsed.error,parsed.status);
  const data=parsed.data;
  if(!fieldsOf(data,['mode','assignments'])||
     !['validate','commit'].includes(data.mode)||
     !Array.isArray(data.assignments)||
     data.assignments.length<1||data.assignments.length>80)return userError('DATOS_INVALIDOS');
  const selection=new Map();
  for(const entry of data.assignments){
    if(!fieldsOf(entry,['personnel_id','role'])||
       typeof entry.personnel_id!=='string'||
       !/^[a-f0-9-]{36}$/i.test(entry.personnel_id)||
       typeof entry.role!=='string'||!USER_ROLES.has(entry.role)||
       selection.has(entry.personnel_id))return userError('SELECCION_INVALIDA');
    selection.set(entry.personnel_id,entry.role);
  }
  const ids=[...selection.keys()];
  const found=await env.DB.prepare(
    "SELECT p.id,p.document_number,p.full_name,p.position,p.email,p.phone,p.is_active,"+
    "l.user_id FROM master_personnel p "+
    "LEFT JOIN app_personnel_user_links l ON l.personnel_id=p.id "+
    "WHERE p.id IN (SELECT value FROM json_each(?))"
  ).bind(JSON.stringify(ids)).all();
  const people=new Map((found.results||[]).map(x=>[x.id,x]));
  const issues=[],seenEmail=new Map();
  const eligible=[];
  for(const id of ids){
    const person=people.get(id);
    if(!person){issues.push({personnel_id:id,name:'Registro no encontrado',error:'PERSONAL_NO_EXISTE'});continue;}
    const error=person.user_id?'YA_TIENE_ACCESO':person.is_active!==1?'PERSONAL_INACTIVO':null;
    const email=userEmail(person.email);
    const invalidEmail=!email?'CORREO_REQUERIDO':null;
    const doc=String(person.document_number||'').trim().toUpperCase();
    const invalidDocument=!/^[A-Z0-9-]{4,25}$/.test(doc)?'IDENTIFICACION_INVALIDA':null;
    const duplicateEmail=email&&seenEmail.has(email)?'CORREO_REPETIDO_EN_SELECCION':null;
    if(error||invalidEmail||invalidDocument||duplicateEmail){
      issues.push({personnel_id:id,name:person.full_name,error:error||invalidEmail||invalidDocument||duplicateEmail});
    }else {
      seenEmail.set(email,id);
      eligible.push({...person,email,document_number:doc,role:selection.get(id)});
    }
  }
  if(eligible.length){
    const emails=JSON.stringify(eligible.map(p=>p.email));
    const docs=JSON.stringify(eligible.map(p=>p.document_number));
    const conflicts=await env.DB.prepare(
      "SELECT u.email,d.document_number FROM app_users u "+
      "LEFT JOIN app_user_details d ON d.user_id=u.id "+
      "WHERE u.email IN (SELECT value FROM json_each(?)) "+
      "OR d.document_number IN (SELECT value FROM json_each(?))"
    ).bind(emails,docs).all();
    const existingEmails=new Set((conflicts.results||[]).map(c=>String(c.email).toLowerCase()));
    const existingDocs=new Set((conflicts.results||[]).map(c=>String(c.document_number||'').toUpperCase()));
    for(const p of eligible){
      if(existingEmails.has(p.email)||existingDocs.has(p.document_number))
        issues.push({personnel_id:p.id,name:p.full_name,error:existingEmails.has(p.email)?'CORREO_YA_TIENE_USUARIO':'DOCUMENTO_YA_TIENE_USUARIO'});
    }
  }
  if(issues.length){
    if(data.mode==='validate')return json({ok:true,valid:false,total:ids.length,errors:issues});
    return json({ok:false,error:'VINCULACION_CON_ERRORES',total:ids.length,errors:issues},422);
  }
  if(data.mode==='validate')return json({ok:true,valid:true,total:ids.length,errors:[]});
  const now=Math.floor(Date.now()/1000);
  const entries=[];
  for(const p of eligible){
    const token=toBase64url(randomBytes(32));
    entries.push({
      user_id:crypto.randomUUID(),personnel_id:p.id,role:p.role,
      email:p.email,display_name:p.full_name,document_number:p.document_number,
      job_title:p.position==='SUPERVISOR'?'Supervisor':'Técnico',
      phone:p.phone||'',token_hash:await hash(token),
      audit_create:crypto.randomUUID(),audit_invite:crypto.randomUUID(),
      link:invitationLink(request,token)
    });
  }
  const input=JSON.stringify(entries);
  const extracted=key=>"json_extract(value,'$."+key+"')";
  const fromJson=' FROM json_each(?)';
  const stmts=[
    env.DB.prepare(
      "INSERT INTO app_users(id,email,display_name,password_hash,password_salt,password_kdf,role,active) "+
      "SELECT "+['user_id','email','display_name'].map(extracted).join(',')+
      ",'','','pbkdf2-sha512-220000',"+extracted('role')+",0"+fromJson
    ).bind(input),
    env.DB.prepare(
      "INSERT INTO app_user_details(user_id,document_number,job_title,phone) "+
      "SELECT "+['user_id','document_number','job_title','phone'].map(extracted).join(',')+fromJson
    ).bind(input),
    env.DB.prepare(
      "INSERT INTO app_personnel_user_links(personnel_id,user_id,linked_by) "+
      "SELECT "+extracted('personnel_id')+","+extracted('user_id')+",?"+fromJson
    ).bind(user.id,input),
    env.DB.prepare(
      "INSERT INTO app_user_invitations(token_hash,user_id,purpose,created_by,created_at,expires_at) "+
      "SELECT "+extracted('token_hash')+","+extracted('user_id')+",'ACTIVAR',?,?,?"+fromJson
    ).bind(user.id,now,now+INVITATION_SECONDS,input),
    env.DB.prepare(
      "INSERT INTO app_user_audit(id,user_id,actor_id,action,changed_fields) "+
      "SELECT "+extracted('audit_create')+","+extracted('user_id')+",?,'CREAR','[\"personal\"]'"+fromJson
    ).bind(user.id,input),
    env.DB.prepare(
      "INSERT INTO app_user_audit(id,user_id,actor_id,action,changed_fields) "+
      "SELECT "+extracted('audit_invite')+","+extracted('user_id')+",?,'INVITAR','[\"invitacion\"]'"+fromJson
    ).bind(user.id,input)
  ];
  try {await env.DB.batch(stmts);}
  catch(err) {
    if(/UNIQUE|constraint|FOREIGN KEY/i.test(String(err)))
      return userError('CONFLICTO_VINCULACION',409);
    throw err;
  }
  return json({
    ok:true,created:entries.length,
    invitations:entries.map(e=>({
      personnel_id:e.personnel_id,email:e.email,name:e.display_name,role:e.role,link:e.link
    }))
  },201);
}


/* Maestra única: PROPIA es destino de Ingresos, ALIADO es remitente.
 * Estas reglas operativas se aplicarán nuevamente en el endpoint de Ingresos.
 * Dar de alta un registro nunca crea inventario ni movimientos.
 */
const WAREHOUSE_ADMIN = new Set(['PROPIA','ALIADO']);
// Mantener los 3 departamentos operativos de Personal y las bodegas propias;
// los aliados pueden tener centros en todo Colombia.
const NATIONAL_WAREHOUSE_DEPARTMENTS = new Set(["AMAZONAS","ANTIOQUIA","ARAUCA","ATLANTICO","BOLIVAR","BOYACA","CALDAS","CAQUETA","CASANARE","CAUCA","CESAR","CHOCO","CORDOBA","CUNDINAMARCA","GUAINIA","GUAVIARE","HUILA","LA GUAJIRA","MAGDALENA","META","NARINO","NORTE DE SANTANDER","PUTUMAYO","QUINDIO","RISARALDA","SAN ANDRES","SANTANDER","SUCRE","TOLIMA","VALLE DEL CAUCA","VAUPES","VICHADA","BOGOTA D.C."]);
function canonicalWarehouseDepartment(value){
  const department=canonicalDepartment(value);
  const compact=department.replace(/[.,]/g,' ').replace(/\s+/g,' ').trim();
  if(['BOGOTA','BOGOTA DC','BOGOTA D C','DISTRITO CAPITAL','BOGOTA DISTRITO CAPITAL'].includes(compact))
    return 'BOGOTA D.C.';
  return department;
}
function warehouseDepartmentAllowed(administration,department){
  return administration==='PROPIA' ? DEPARTMENTS.has(department)
    : administration==='ALIADO' && NATIONAL_WAREHOUSE_DEPARTMENTS.has(department);
}
const WAREHOUSE_FIELDS = ['centro','almacen','description','administration','department','is_active'];
function normalizeWarehouse(data) {
  if(data.is_active!==undefined && ![true,false,0,1].includes(data.is_active))return null;
  const record={
    centro:trimmed(data.centro,30).toUpperCase(),
    almacen:trimmed(data.almacen,30).toUpperCase(),
    description:trimmed(data.description,160),
    administration:trimmed(data.administration,15).toUpperCase(),
    department:canonicalWarehouseDepartment(data.department),
    is_active:data.is_active===0||data.is_active===false?0:1
  };
  const warehouseCode=/^[A-Z0-9][A-Z0-9._/-]{0,29}$/;
  if(!warehouseCode.test(record.centro)||!warehouseCode.test(record.almacen)||
     record.description.length<3||record.description.length>160||
     !WAREHOUSE_ADMIN.has(record.administration)||
     !warehouseDepartmentAllowed(record.administration,record.department))return null;
  return record;
}
async function warehouseHandler(request,env,user) {
  if(!user)return masterBad('NO_AUTENTICADO',401);
  if(user.role!=='ADMIN')return masterBad('SIN_PERMISOS',403);
  if(request.method==='GET'){
    const qs=new URL(request.url).searchParams;
    if([...qs.keys()].some(k=>!['administration','active'].includes(k)))return masterBad('FILTRO_NO_VALIDO');
    const administration=qs.get('administration');
    if(administration!==null&&!WAREHOUSE_ADMIN.has(administration))return masterBad('FILTRO_NO_VALIDO');
    const active=qs.get('active');
    if(active!==null&&!['1','0'].includes(active))return masterBad('FILTRO_NO_VALIDO');
    const rows=await env.DB.prepare(
      "SELECT id,centro,almacen,description,administration,department,is_active,created_at,updated_at "+
      "FROM master_logistics_locations WHERE (? IS NULL OR administration=?) AND (? IS NULL OR is_active=?) "+
      "ORDER BY department,description COLLATE NOCASE LIMIT 2000"
    ).bind(administration,administration,active===null?null:Number(active),active===null?null:Number(active)).all();
    return json({ok:true,items:rows.results||[]});
  }
  if(!['POST','PATCH'].includes(request.method))return masterBad('METODO_NO_PERMITIDO',405);
  const parsed=await masterBody(request);
  if(parsed.error)return masterBad(parsed.error,parsed.status);
  const input=parsed.data;
  if(!fieldsOf(input,['id',...WAREHOUSE_FIELDS]))return masterBad('CAMPOS_NO_VALIDOS');
  const editing=request.method==='PATCH';
  let old=null;
  if(editing){
    if(typeof input.id!=='string'||!/^[0-9a-f-]{36}$/i.test(input.id))
      return masterBad('ID_INVALIDO');
    old=await env.DB.prepare('SELECT * FROM master_logistics_locations WHERE id=?').bind(input.id).first();
    if(!old)return masterBad('BODEGA_NO_ENCONTRADA',404);
    // Centro y Almacén identifican un almacén SAP: no se cambian tras crearlo.
    if((Object.hasOwn(input,'centro')&&trimmed(input.centro,30).toUpperCase()!==old.centro)||
       (Object.hasOwn(input,'almacen')&&trimmed(input.almacen,30).toUpperCase()!==old.almacen))
      return masterBad('CLAVE_INMUTABLE',409);
  }else if(Object.hasOwn(input,'id'))return masterBad('ID_NO_PERMITIDO');
  const value=normalizeWarehouse({...old,...input});
  if(!value)return masterBad('DATOS_BODEGA_INVALIDOS',400);
  const existing=await env.DB.prepare('SELECT id FROM master_logistics_locations WHERE centro=? AND almacen=? LIMIT 1')
    .bind(value.centro,value.almacen).first();
  if(existing&&(!old||existing.id!==old.id))return masterBad('CENTRO_ALMACEN_DUPLICADO',409);
  const keys=Object.keys(value),id=old?.id||crypto.randomUUID(),actor=user.id;
  const changed=old?keys.filter(k=>String(value[k])!==String(old[k])):keys;
  if(old&&!changed.length)return json({ok:true,unchanged:true,id});
  const action=old&&changed.length===1&&changed[0]==='is_active'
    ?(value.is_active?'ACTIVAR':'DESACTIVAR'):old?'EDITAR':'CREAR';
  const stmt=editing
    ?env.DB.prepare('UPDATE master_logistics_locations SET '+keys.map(k=>k+'=?').join(',')+
      ',updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(...keys.map(k=>value[k]),actor,id)
    :env.DB.prepare('INSERT INTO master_logistics_locations(id,'+keys.join(',')+',created_by,updated_by) VALUES ('+
      Array(keys.length+3).fill('?').join(',')+')').bind(id,...keys.map(k=>value[k]),actor,actor);
  const audit=env.DB.prepare(
    'INSERT INTO master_warehouse_audit(id,warehouse_id,action,actor_id,changed_fields) VALUES (?,?,?,?,?)'
  ).bind(crypto.randomUUID(),id,action,actor,JSON.stringify(changed));
  try{await env.DB.batch([stmt,audit]);}
  catch(e){
    if(/UNIQUE|constraint/i.test(String(e)))return masterBad('CENTRO_ALMACEN_DUPLICADO',409);
    throw e;
  }
  return json({ok:true,id,action},editing?200:201);
}
async function bulkWarehouses(request,env,user){
  if(!user)return masterBad('NO_AUTENTICADO',401);
  if(user.role!=='ADMIN')return masterBad('SIN_PERMISOS',403);
  if(request.method!=='POST')return masterBad('METODO_NO_PERMITIDO',405);
  if(!sameOrigin(request))return masterBad('ORIGEN_NO_AUTORIZADO',403);
  if(!/application\/json/i.test(request.headers.get('content-type')||''))return masterBad('TIPO_NO_VALIDO',415);
  const raw=await request.text();
  if(raw.length>540000)return masterBad('ARCHIVO_DEMASIADO_GRANDE',413);
  let input;
  try{input=JSON.parse(raw);}catch{return masterBad('DATOS_INVALIDOS');}
  if(!input||typeof input!=='object'||Array.isArray(input)||
     !fieldsOf(input,['mode','rows','kind'])||
     input.kind!=='BODEGAS'||!['validate','commit'].includes(input.mode)||
     !Array.isArray(input.rows)||!input.rows.length||input.rows.length>1000)
     return masterBad('ARCHIVO_INVALIDO');
  const errors=[],normalized=[],keys=new Map();
  const addError=(row,field,message)=>{if(errors.length<40)errors.push({row,field,message});};
  for(let i=0;i<input.rows.length;i++){
    const r=input.rows[i],row=i+2;
    if(!fieldsOf(r,WAREHOUSE_FIELDS)){
      addError(row,'Columnas','El archivo tiene columnas desconocidas');continue;
    }
    const v=normalizeWarehouse(r);
    if(!v){
      const administration=trimmed(r.administration,15).toUpperCase();
      const department=canonicalWarehouseDepartment(r.department);
      if(!WAREHOUSE_ADMIN.has(administration))
        addError(row,'Administración','Solo PROPIA o ALIADO');
      else if(!NATIONAL_WAREHOUSE_DEPARTMENTS.has(department))
        addError(row,'Departamento','Departamento colombiano no reconocido');
      else if(administration==='PROPIA'&&!DEPARTMENTS.has(department))
        addError(row,'Departamento','Las bodegas PROPIAS solo admiten Cesar, La Guajira o San Andrés');
      else addError(row,'Datos','Centro, Almacén, Descripción o Estado inválidos');
      continue;
    }
    const key=v.centro+'|'+v.almacen;
    if(keys.has(key)){addError(row,'Centro + Almacén','Duplicado en este archivo; fila '+keys.get(key));continue;}
    keys.set(key,row);
    normalized.push({...v,id:crypto.randomUUID(),audit_id:crypto.randomUUID()});
  }
  if(normalized.length){
    const existing=await env.DB.prepare(
      "SELECT centro,almacen FROM master_logistics_locations "+
      "WHERE centro || '|' || almacen IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify([...keys.keys()])).all();
    for(const record of existing.results||[]){
      const key=record.centro.toUpperCase()+'|'+record.almacen.toUpperCase();
      addError(keys.get(key)||2,'Centro + Almacén','Esta combinación ya existe en Maestras');
    }
  }
  if(errors.length){
    if(input.mode==='validate')return json({ok:true,valid:false,total:input.rows.length,errors});
    return json({ok:false,error:'ARCHIVO_CON_ERRORES',total:input.rows.length,errors},422);
  }
  if(input.mode==='validate')return json({ok:true,valid:true,total:input.rows.length,errors:[]});
  const jsonRows=JSON.stringify(normalized);
  const cols=['id',...WAREHOUSE_FIELDS];
  const selects=cols.map(k=>"json_extract(value,'$."+k+"')").join(',');
  const insert=env.DB.prepare(
    'INSERT INTO master_logistics_locations('+cols.join(',')+',created_by,updated_by) '+
    'SELECT '+selects+',?,? FROM json_each(?)'
  ).bind(user.id,user.id,jsonRows);
  const audit=env.DB.prepare(
    "INSERT INTO master_warehouse_audit(id,warehouse_id,action,actor_id,changed_fields) "+
    "SELECT json_extract(value,'$.audit_id'),json_extract(value,'$.id'),'CREAR',?,? FROM json_each(?)"
  ).bind(user.id,JSON.stringify(WAREHOUSE_FIELDS),jsonRows);
  try{await env.DB.batch([insert,audit]);}
  catch(e){
    if(/UNIQUE|constraint|FOREIGN KEY/i.test(String(e)))
      return masterBad('CONFLICTO_IMPORTACION',409);
    throw e;
  }
  return json({ok:true,inserted:normalized.length,total:normalized.length},201);
}


/* INGRESOS: validación de borradores y contabilización atómica en SQLite D1.
 * La validación de pantalla es informativa: los triggers D1 vuelven a validar
 * dentro de la transacción que inserta seriales, stock y movimientos.
 */
const ING_DOCUMENT_TYPES = new Set(['NUMERO_PEDIDO']);
const ING_PDF_MAX = 5 * 1024 * 1024;
const ING_PDF_CHUNK = 128 * 1024;
const ING_MAX_ITEMS = 500;
const ING_ID = /^[0-9a-f-]{36}$/i;
const ingBad = (error,status=400,extra={})=>json({ok:false,error,...extra},status);
const ingOwn = (o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function ingDate(s){
  if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
  const [y,m,d]=s.split('-').map(Number);
  if(y<2000||y>2100)return false;
  const date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y&&date.getUTCMonth()+1===m&&date.getUTCDate()===d;
}
async function ingBody(request,max=350000){
  if(!sameOrigin(request))return {error:'ORIGEN_NO_AUTORIZADO',status:403};
  if(!/application\/json/i.test(request.headers.get('content-type')||''))
    return {error:'TIPO_NO_VALIDO',status:415};
  const str=await request.text();
  if(str.length>max)return {error:'SOLICITUD_DEMASIADO_GRANDE',status:413};
  try{
    const data=JSON.parse(str);
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('bad');
    return {data};
  }catch{return {error:'DATOS_INVALIDOS',status:400};}
}
const ingDocKeys=['document_type','document_number','document_date','received_date','source_id','destination_id','notes'];
function ingNormalizeDocument(doc){
  if(!doc||typeof doc!=='object'||Array.isArray(doc)||!fieldsOf(doc,ingDocKeys))return null;
  const result={
    document_type:trimmed(doc.document_type,35).toUpperCase(),
    document_number:trimmed(doc.document_number,90),
    document_date:trimmed(doc.document_date,10),
    received_date:trimmed(doc.received_date,10),
    source_id:doc.source_id||null,
    destination_id:doc.destination_id||null,
    notes:trimmed(doc.notes,500)
  };
  if(Object.values(result).some(x=>typeof x==='string' && x.length>500)||
     result.document_number.length>90||result.notes.length>500||
     (result.document_type&&!ING_DOCUMENT_TYPES.has(result.document_type))||
     (result.document_date&&!ingDate(result.document_date))||
     (result.received_date&&!ingDate(result.received_date))||
     (result.source_id&&!ING_ID.test(result.source_id))||
     (result.destination_id&&!ING_ID.test(result.destination_id)))return null;
  return result;
}
function ingNormalizeItems(items){
  if(!Array.isArray(items)||items.length>ING_MAX_ITEMS)return null;
  const output=[];
  for(const record of items){
    if(!record||typeof record!=='object'||Array.isArray(record)||
       !fieldsOf(record,['sap_code','serial','quantity','lot','reception_state','notes']))return null;
    const sap_code=trimmed(record.sap_code,50).toUpperCase();
    const serial=trimmed(record.serial,100).toUpperCase();
    const notes=trimmed(record.notes,240);
    const lot=trimmed(record.lot,30).toUpperCase();
    const reception_state=trimmed(record.reception_state,30).toUpperCase();
    const quantity=Number(record.quantity);
    if(sap_code.length>50||serial.length>100||notes.length>240||
       !Number.isInteger(quantity)||quantity>1000000||quantity< -1000000||
       (lot!==''&&!['VALORADO','NOVALORADO'].includes(lot))||
       (reception_state!==''&&!['NUEVO','REMANUFACTURADO'].includes(reception_state)))return null;
    output.push({id:crypto.randomUUID(),position:output.length+1,sap_code,serial,quantity,
      lot,reception_state,notes});
  }
  return output;
}
async function ingGet(db,id){
  const document=await db.prepare(
    "SELECT d.*,src.description AS source_description,src.centro AS source_centro,src.almacen AS source_almacen,"+
    "dst.description AS destination_description,dst.centro AS destination_centro,dst.almacen AS destination_almacen,"+
    "u.display_name AS author_name FROM ingress_documents d "+
    "LEFT JOIN master_logistics_locations src ON src.id=d.source_id "+
    "LEFT JOIN master_logistics_locations dst ON dst.id=d.destination_id "+
    "LEFT JOIN app_users u ON u.id=d.created_by WHERE d.id=?"
  ).bind(id).first();
  if(!document)return null;
  const list=await db.prepare(
    "SELECT i.id,i.position,i.sap_code,i.serial,i.quantity,i.lot,i.reception_state,i.physical_state,i.availability_state,i.notes,"+
    "s.description AS sap_description,s.serial_profile,s.unit,s.item_type "+
    "FROM ingress_items i LEFT JOIN master_sap_catalog s ON s.sap_code=i.sap_code "+
    "WHERE i.ingress_id=? ORDER BY i.position"
  ).bind(id).all();
  return {document,items:list.results||[]};
}
async function ingValidate(db,document,items){
  const errors=[],warnings=[];
  const add=(code,message,step,index=null)=>errors.push({code,message,step,index,blocking:true});
  const documentType=String(document.document_type||'');
  if(!ING_DOCUMENT_TYPES.has(documentType))add('DOCUMENTO_TIPO','El tipo de documento debe ser Número de Pedido.',1);
  if(!String(document.document_number||'').trim())add('DOCUMENTO_NUMERO','Ingresa el número de pedido.',1);
  if(!ingDate(document.document_date))add('DOCUMENTO_FECHA','Indica una fecha válida del documento.',1);
  if(!ingDate(document.received_date))add('INGRESO_FECHA','Indica una fecha de ingreso válida.',1);
  const ids=[document.source_id,document.destination_id].filter(Boolean);
  const locations=(await db.prepare(
    'SELECT id,description,administration,is_active FROM master_logistics_locations WHERE id IN (SELECT value FROM json_each(?))'
  ).bind(JSON.stringify(ids)).all()).results||[];
  const warehouse=new Map(locations.map(x=>[x.id,x]));
  const origin=warehouse.get(document.source_id);
  const destination=warehouse.get(document.destination_id);
  if(!origin||origin.administration!=='ALIADO'||origin.is_active!==1)
    add('ORIGEN_INVALIDO','Selecciona un almacén ALIADO activo como remitente.',1);
  if(!destination||destination.administration!=='PROPIA'||destination.is_active!==1)
    add('DESTINO_INVALIDO','Selecciona una bodega PROPIA activa como destino.',1);
  if(!document.support_size)warnings.push({code:'PDF_OPCIONAL',message:'Ingreso sin PDF de soporte. Puedes continuar.',step:1});
  if(!items.length)add('ITEMS_VACIOS','Agrega al menos un ítem para registrar el ingreso.',2);
  const sapCodes=[...new Set(items.map(i=>i.sap_code).filter(Boolean))];
  const catalog=(await db.prepare(
    'SELECT sap_code,description,serial_profile,unit,is_active FROM master_sap_catalog WHERE sap_code IN (SELECT value FROM json_each(?))'
  ).bind(JSON.stringify(sapCodes)).all()).results||[];
  const sapMap=new Map(catalog.map(x=>[x.sap_code,x]));
  const seen=new Set(),serials=[];
  let unitCount=0,serialized=0;
  for(let index=0;index<items.length;index++){
    const item=items[index],n=index+1;
    const sap=sapMap.get(item.sap_code);
    if(!sap||sap.is_active!==1){
      add('SAP_INVALIDO','Ítem '+n+': el código SAP no existe o está inactivo.',2,index);
    }
    if(!Number.isInteger(item.quantity)||item.quantity<1){
      add('CANTIDAD_INVALIDA','Ítem '+n+': la cantidad debe ser un entero positivo.',2,index);
    }else unitCount+=item.quantity;
    if(!['VALORADO','NOVALORADO'].includes(item.lot))
      add('LOTE_INVALIDO','Ítem '+n+': selecciona el lote VALORADO o NOVALORADO.',2,index);
    if(!['NUEVO','REMANUFACTURADO'].includes(item.reception_state))
      add('ESTADO_RECEPCION_INVALIDO','Ítem '+n+': selecciona Nuevo o Remanufacturado.',2,index);
    if(item.physical_state!=='BUENO'||item.availability_state!=='DISPONIBLE')
      add('ESTADO_INICIAL_INVALIDO','Ítem '+n+': el estado inicial debe ser BUENO y DISPONIBLE.',2,index);
    const serial=String(item.serial||'').trim().toUpperCase();
    if(sap?.serial_profile==='CON PERFIL DE SERIE'&&
       (!serial||['SIN PERFIL DE SERIE','N/A','NA','SIN SERIAL'].includes(serial)))
      add('SERIAL_OBLIGATORIO','Ítem '+n+': registra el serial obligatorio.',2,index);
    if(serial&&item.quantity!==1)
      add('CANTIDAD_SERIAL','Ítem '+n+': cada serial corresponde a una sola unidad (cantidad 1).',2,index);
    if(serial){
      serialized++;
      if(seen.has(serial))add('SERIAL_REPETIDO','Ítem '+n+': el serial se repite en este documento.',2,index);
      seen.add(serial);serials.push(serial);
    }
  }
  if(serials.length){
    const current=(await db.prepare(
      'SELECT serial FROM inventory_serials WHERE serial COLLATE NOCASE IN (SELECT value FROM json_each(?))'
    ).bind(JSON.stringify(serials)).all()).results||[];
    const duplicated=new Set(current.map(x=>x.serial.toUpperCase()));
    for(let index=0;index<items.length;index++){
      const serial=String(items[index].serial||'').trim().toUpperCase();
      if(serial&&duplicated.has(serial))
        add('SERIAL_EXISTENTE','Ítem '+(index+1)+': el serial ya está registrado en PULSO.',2,index);
    }
  }
  return {valid:errors.length===0,errors,warnings,
    totals:{lines:items.length,units:unitCount,serialized,
      unprofiled:items.length-serialized,blocked:errors.length,observed:warnings.length}};
}
async function ingAudit(db,id,user,action,details={}){
  return db.prepare('INSERT INTO ingress_audit(id,ingress_id,actor_id,action,details) VALUES (?,?,?,?,?)')
    .bind(crypto.randomUUID(),id,user,action,JSON.stringify(details));
}
async function ingresosHandler(request,env,user,path){
  if(!user)return ingBad('NO_AUTENTICADO',401);
  // Los roles operativos se autorizarán por módulo cuando existan permisos granulares.
  if(user.role!=='ADMIN')return ingBad('SIN_PERMISOS',403);
  const method=request.method,db=env.DB;
  if(path==='/api/ingresos/catalogos'){
    if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
    const [warehouses,sap]=await Promise.all([
      db.prepare("SELECT id,centro,almacen,description,administration,department FROM master_logistics_locations WHERE is_active=1 ORDER BY administration,description COLLATE NOCASE LIMIT 2000").all(),
      db.prepare("SELECT sap_code,description,serial_profile,unit,item_type FROM master_sap_catalog WHERE is_active=1 ORDER BY sap_code LIMIT 3000").all()
    ]);
    return json({ok:true,warehouses:warehouses.results||[],catalog:sap.results||[]});
  }
  if(path==='/api/ingresos'){
    if(method==='GET'){
      const list=await db.prepare(
        "SELECT d.id,d.reference,d.status,d.document_type,d.document_number,d.received_date,d.created_at,d.updated_at,"+
        "d.support_size,src.description AS source_description,dst.description AS destination_description,"+
        "(SELECT COUNT(*) FROM ingress_items i WHERE i.ingress_id=d.id) AS item_count,"+
        "(SELECT COALESCE(SUM(i.quantity),0) FROM ingress_items i WHERE i.ingress_id=d.id) AS total_units "+
        "FROM ingress_documents d LEFT JOIN master_logistics_locations src ON src.id=d.source_id "+
        "LEFT JOIN master_logistics_locations dst ON dst.id=d.destination_id "+
        "ORDER BY d.created_at DESC,d.id DESC LIMIT 500"
      ).all();
      return json({ok:true,items:list.results||[]});
    }
    if(method==='POST'){
      if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
      const id=crypto.randomUUID();
      await db.batch([
        db.prepare('INSERT INTO ingress_documents(id,created_by,updated_by) VALUES (?,?,?)').bind(id,user.id,user.id),
        await ingAudit(db,id,user.id,'CREAR_BORRADOR')
      ]);
      return json({ok:true,id,status:'BORRADOR'},201);
    }
    return ingBad('METODO_NO_PERMITIDO',405);
  }
  const match=/^\/api\/ingresos\/([0-9a-f-]{36})(?:\/(validar|confirmar|soporte))?$/i.exec(path);
  if(!match)return ingBad('RUTA_NO_DISPONIBLE',404);
  const id=match[1],action=match[2]||'';
  if(!ING_ID.test(id))return ingBad('ID_INVALIDO',400);
  let item=await ingGet(db,id);
  if(!item)return ingBad('INGRESO_NO_ENCONTRADO',404);
  const doc=item.document;
  if(action==='soporte'){
    if(method==='GET'){
      if(!doc.support_size)return ingBad('SIN_SOPORTE',404);
      const parts=(await db.prepare('SELECT bytes FROM ingress_support_chunks WHERE ingress_id=? ORDER BY chunk_index').bind(id).all()).results||[];
      const total=parts.reduce((sum,p)=>sum+p.bytes.byteLength,0);
      if(total!==doc.support_size)return ingBad('SOPORTE_INCOMPLETO',503);
      const binary=new Uint8Array(total);let offset=0;
      for(const p of parts){binary.set(p.bytes,offset);offset+=p.bytes.byteLength;}
      const filename=(doc.support_filename||'soporte.pdf').replace(/[^a-zA-Z0-9._ -]/g,'_');
      return new Response(binary,{status:200,headers:{
        'content-type':'application/pdf','content-length':String(total),
        'content-disposition':'attachment; filename="'+filename+'"',
        'cache-control':'private, no-store','x-content-type-options':'nosniff',
        'content-security-policy':'sandbox'
      }});
    }
    if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
    if(doc.status!=='BORRADOR')return ingBad('INGRESO_INMUTABLE',409);
    if(method==='DELETE'){
      await db.batch([
        db.prepare('DELETE FROM ingress_support_chunks WHERE ingress_id=?').bind(id),
        db.prepare("UPDATE ingress_documents SET support_filename='',support_size=0,support_sha256='',updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?").bind(user.id,id),
        await ingAudit(db,id,user.id,'QUITAR_PDF')
      ]);
      return json({ok:true});
    }
    if(method!=='POST')return ingBad('METODO_NO_PERMITIDO',405);
    if(!/^application\/pdf(?:\s*;.*)?$/i.test(request.headers.get('content-type')||''))
      return ingBad('PDF_REQUERIDO',415);
    const statedSize=Number(request.headers.get('content-length')||0);
    if(statedSize>ING_PDF_MAX)return ingBad('PDF_DEMASIADO_GRANDE',413);
    const bytes=new Uint8Array(await request.arrayBuffer());
    if(bytes.byteLength>ING_PDF_MAX||!bytes.byteLength)return ingBad('PDF_DEMASIADO_GRANDE',413);
    if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')
      return ingBad('PDF_INVALIDO',400);
    const name=(request.headers.get('x-file-name')||'soporte.pdf').replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,110);
    if(!/\.pdf$/i.test(name))return ingBad('PDF_INVALIDO',400);
    const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
    const stmts=[db.prepare('DELETE FROM ingress_support_chunks WHERE ingress_id=?').bind(id)];
    for(let i=0;i<bytes.length;i+=ING_PDF_CHUNK){
      stmts.push(db.prepare('INSERT INTO ingress_support_chunks(ingress_id,chunk_index,bytes) VALUES (?,?,?)')
        .bind(id,Math.floor(i/ING_PDF_CHUNK),bytes.slice(i,i+ING_PDF_CHUNK)));
    }
    stmts.push(db.prepare('UPDATE ingress_documents SET support_filename=?,support_size=?,support_sha256=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=? AND status=?')
      .bind(name,bytes.byteLength,digest,user.id,id,'BORRADOR'));
    stmts.push(await ingAudit(db,id,user.id,'ADJUNTAR_PDF',{name,size:bytes.byteLength,sha256:digest}));
    try{await db.batch(stmts);}
    catch(e){return ingBad('PDF_NO_GUARDADO',409);}
    return json({ok:true,name,size:bytes.byteLength,sha256:digest},201);
  }
  if(action==='validar'){
    if(method!=='GET'&&method!=='POST')return ingBad('METODO_NO_PERMITIDO',405);
    if(method==='POST'&&!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
    if(doc.status!=='BORRADOR')return ingBad('INGRESO_YA_REGISTRADO',409);
    const validation=await ingValidate(db,doc,item.items);
    return json({ok:true,validation});
  }
  if(action==='confirmar'){
    if(method!=='POST')return ingBad('METODO_NO_PERMITIDO',405);
    if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
    if(doc.status!=='BORRADOR')return ingBad('INGRESO_YA_REGISTRADO',409);
    const validation=await ingValidate(db,doc,item.items);
    if(!validation.valid)return ingBad('VALIDACION_BLOQUEANTE',422,{validation});
    const now=new Date();
    const ref='ING-'+now.toISOString().slice(0,10).replace(/-/g,'')+'-'+id.slice(0,8).toUpperCase();
    try{
      const results=await db.batch([
        db.prepare("UPDATE ingress_documents SET status='REGISTRADO',reference=?,registered_by=?,registered_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=? AND status='BORRADOR'")
          .bind(ref,user.id,user.id,id),
        await ingAudit(db,id,user.id,'REGISTRAR',{reference:ref,lines:item.items.length,units:validation.totals.units})
      ]);
      if((results[0]?.meta?.changes??results[0]?.changes)!==1)
        return ingBad('INGRESO_YA_REGISTRADO',409);
    }catch(e){
      // No se filtran detalles de la consulta SQL ni errores internos.
      return ingBad('REVALIDAR_INGRESO',409);
    }
    return json({ok:true,id,reference:ref,status:'REGISTRADO',totals:validation.totals});
  }
  if(action)return ingBad('RUTA_NO_DISPONIBLE',404);
  if(method==='GET'){
    // La revisión de duplicados solo aplica a borradores, nunca a registros ya contabilizados.
    const validation=doc.status==='BORRADOR'?await ingValidate(db,doc,item.items):null;
    return json({ok:true,...item,validation});
  }
  if(method==='DELETE'){
    if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
    if(doc.status!=='BORRADOR')return ingBad('INGRESO_INMUTABLE',409);
    try{
      // Una sola transacción. La condición BORRADOR impide borrar un ingreso
      // confirmado, incluso si su estado cambiara entre la lectura y el DELETE.
      const results=await db.batch([
        db.prepare('DELETE FROM ingress_support_chunks WHERE ingress_id=?').bind(id),
        db.prepare('DELETE FROM ingress_items WHERE ingress_id=?').bind(id),
        db.prepare('DELETE FROM ingress_audit WHERE ingress_id=?').bind(id),
        db.prepare("DELETE FROM ingress_documents WHERE id=? AND status='BORRADOR'").bind(id)
      ]);
      if((results[3]?.meta?.changes??results[3]?.changes)!==1)
        return ingBad('INGRESO_INMUTABLE',409);
    }catch{
      return ingBad('INGRESO_INMUTABLE',409);
    }
    return json({ok:true,deleted:true,id});
  }
  if(method!=='PATCH')return ingBad('METODO_NO_PERMITIDO',405);
  if(doc.status!=='BORRADOR')return ingBad('INGRESO_INMUTABLE',409);
  const parsed=await ingBody(request);
  if(parsed.error)return ingBad(parsed.error,parsed.status);
  if(!fieldsOf(parsed.data,['document','items'])||!ingOwn(parsed.data,'document')||!ingOwn(parsed.data,'items'))
    return ingBad('DATOS_INVALIDOS');
  const normalized=ingNormalizeDocument(parsed.data.document);
  const items=ingNormalizeItems(parsed.data.items);
  if(!normalized||!items)return ingBad('DATOS_INVALIDOS');
  const values=Object.values(normalized);
  const itemRows=JSON.stringify(items);
  const update=db.prepare(
    'UPDATE ingress_documents SET '+Object.keys(normalized).map(k=>k+'=?').join(',')+
    ',updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?'
  ).bind(...values,user.id,id,'BORRADOR');
  const deleteItems=db.prepare('DELETE FROM ingress_items WHERE ingress_id=?').bind(id);
  const insertItems=db.prepare(
    "INSERT INTO ingress_items(id,ingress_id,position,sap_code,serial,quantity,notes,lot,reception_state,physical_state,availability_state) "+
    "SELECT json_extract(value,'$.id'),?,json_extract(value,'$.position'),"+
    "json_extract(value,'$.sap_code'),json_extract(value,'$.serial'),"+
    "json_extract(value,'$.quantity'),json_extract(value,'$.notes'),"+
    "json_extract(value,'$.lot'),json_extract(value,'$.reception_state'),'BUENO','DISPONIBLE' "+
    "FROM json_each(?)"
  ).bind(id,itemRows);
  try{
    await db.batch([update,deleteItems,insertItems,
      await ingAudit(db,id,user.id,'GUARDAR_BORRADOR',{items:items.length})]);
  }catch{return ingBad('NO_SE_PUDO_GUARDAR',409);}
  item=await ingGet(db,id);
  return json({ok:true,id,status:'BORRADOR',validation:await ingValidate(db,item.document,item.items)});
}


/* DESPACHOS. Asignación de inventario PROPIO a técnicos de Personal.
 * Los seriales se reservan en una tabla distinta para mantener intactos
 * los registros originales de Ingresos y hacer comprobaciones atómicas. */
async function dispatchGet(db,id){
 const document=await db.prepare(
  "SELECT d.*,p.full_name AS technician_name,p.document_number AS technician_document,"+
  "p.department AS technician_department,p.city_base AS technician_city,p.zone AS technician_zone,"+
  "sup.full_name AS supervisor_name,w.centro,w.almacen,w.description AS warehouse_name "+
  "FROM dispatch_documents d LEFT JOIN master_personnel p ON p.id=d.technician_id "+
  "LEFT JOIN master_personnel sup ON sup.id=p.supervisor_id "+
  "LEFT JOIN master_logistics_locations w ON w.id=d.warehouse_id WHERE d.id=?"
 ).bind(id).first();
 if(!document)return null;
 const result=await db.prepare(
  "SELECT i.id,i.position,i.sap_code,i.serial,i.quantity,i.notes,s.description AS sap_description,"+
  "inv.lot,inv.reception_state,inv.physical_state "+
  "FROM dispatch_items i LEFT JOIN master_sap_catalog s ON s.sap_code=i.sap_code "+
  "LEFT JOIN inventory_serials inv ON inv.serial=i.serial COLLATE NOCASE AND trim(i.serial)<>'' "+
  "WHERE i.dispatch_id=? ORDER BY i.position"
 ).bind(id).all();
 return {document,items:result.results||[]};
}
function dispatchNormalize(data){
 if(!fieldsOf(data,['technician_id','warehouse_id','dispatch_date','notes','items']))return null;
 const technician_id=trimmed(data.technician_id,50);
 const warehouse_id=trimmed(data.warehouse_id,50);
 const dispatch_date=trimmed(data.dispatch_date,20);
 const notes=trimmed(data.notes,500);
 if((dispatch_date&&!ingDate(dispatch_date))||notes.length>500)return null;
 if(!Array.isArray(data.items)||data.items.length>500)return null;
 const items=[];
 for(const [index,row] of data.items.entries()){
  if(!fieldsOf(row,['sap_code','serial','quantity','notes']))return null;
  const sap_code=trimmed(row.sap_code,50).toUpperCase();
  const serial=trimmed(row.serial,100).toUpperCase();
  const remark=trimmed(row.notes,240);
  const quantity=Number(row.quantity);
  if(!Number.isInteger(quantity)||quantity<0||quantity>1000000||
    sap_code.length>50||serial.length>100||remark.length>240)return null;
  items.push({id:crypto.randomUUID(),position:index+1,sap_code,serial,quantity,notes:remark});
 }
 return {technician_id:technician_id||null,warehouse_id:warehouse_id||null,dispatch_date,notes,items};
}
async function dispatchValidate(db,doc,items){
 const errors=[],warnings=[];
 const add=(code,message,step,index=null)=>errors.push({code,message,step,index,blocking:true});
 if(!ingDate(doc.dispatch_date))add('FECHA_INVALIDA','Indica la fecha del despacho.',1);
 const tech=doc.technician_id?await db.prepare(
  "SELECT id FROM master_personnel WHERE id=? AND position='TECNICO' AND is_active=1"
 ).bind(doc.technician_id).first():null;
 if(!tech)add('TECNICO_INVALIDO','Selecciona un técnico activo de la Maestra Personal.',1);
 const warehouse=doc.warehouse_id?await db.prepare(
  "SELECT id FROM master_logistics_locations WHERE id=? AND administration='PROPIA' AND is_active=1"
 ).bind(doc.warehouse_id).first():null;
 if(!warehouse)add('BODEGA_INVALIDA','Selecciona una bodega propia activa.',1);
 if(!items.length)add('SIN_ITEMS','Selecciona al menos un equipo o material.',2);
 const sapKeys=[...new Set(items.map(i=>i.sap_code).filter(Boolean))];
 const saps=sapKeys.length?(await db.prepare(
  "SELECT sap_code,serial_profile,description FROM master_sap_catalog WHERE is_active=1 AND sap_code IN (SELECT value FROM json_each(?))"
 ).bind(JSON.stringify(sapKeys)).all()).results||[]:[];
 const catalog=new Map(saps.map(x=>[x.sap_code,x]));
 const serialValues=[...new Set(items.map(i=>i.serial).filter(Boolean))];
 const stocks=serialValues.length?(await db.prepare(
  "SELECT inv.serial,inv.sap_code,inv.warehouse_id,inv.status,ass.serial AS assigned "+
  "FROM inventory_serials inv LEFT JOIN dispatch_serial_assignments ass ON ass.serial=inv.serial COLLATE NOCASE "+
  "WHERE inv.serial COLLATE NOCASE IN (SELECT value FROM json_each(?))"
 ).bind(JSON.stringify(serialValues)).all()).results||[]:[];
 const serialMap=new Map(stocks.map(x=>[x.serial.toUpperCase(),x]));
 const bulk=(await db.prepare(
  "SELECT sap_code,quantity FROM inventory_bulk_stock WHERE warehouse_id=?"
 ).bind(doc.warehouse_id||'').all()).results||[];
 const bulkMap=new Map(bulk.map(x=>[x.sap_code,Number(x.quantity)]));
 const counts=new Map(),seen=new Set();let units=0,serials=0;
 for(let i=0;i<items.length;i++){
  const it=items[i],n=i+1,sap=catalog.get(it.sap_code);
  if(!sap)add('SAP_INVALIDO','Ítem '+n+': SAP no registrado o inactivo.',2,i);
  if(!Number.isInteger(it.quantity)||it.quantity<1)add('CANTIDAD_INVALIDA','Ítem '+n+': indica cantidad positiva.',2,i);
  else units+=it.quantity;
  if(!it.serial&&sap?.serial_profile==='CON PERFIL DE SERIE')
   add('SERIAL_OBLIGATORIO','Ítem '+n+': debes seleccionar un serial.',2,i);
  if(it.serial){
   serials++;
   if(it.quantity!==1)add('CANTIDAD_SERIAL','Ítem '+n+': cada serial corresponde a una unidad.',2,i);
   if(seen.has(it.serial))add('SERIAL_REPETIDO','Ítem '+n+': serial repetido en este despacho.',2,i);
   seen.add(it.serial);
   const found=serialMap.get(it.serial);
   if(!found||found.sap_code!==it.sap_code||found.warehouse_id!==doc.warehouse_id||
       found.status!=='DISPONIBLE'||found.assigned)
    add('SERIAL_NO_DISPONIBLE','Ítem '+n+': el serial no está disponible en la bodega.',2,i);
  }else if(it.quantity>0)counts.set(it.sap_code,(counts.get(it.sap_code)||0)+it.quantity);
 }
 for(const [sap,qty] of counts){
  if(qty>(bulkMap.get(sap)||0))
   add('SIN_EXISTENCIAS','El SAP '+sap+' requiere '+qty+' unidades, pero la bodega no tiene suficientes.',2);
 }
 return {valid:errors.length===0,errors,warnings,
   totals:{lines:items.length,units,serialized:serials,bulk:items.length-serials,blocked:errors.length}};
}

/* Despachos masivos: la vista previa no escribe; la confirmación escribe TODOS los
   despachos y movimientos en una única transacción D1. Límite: 500 filas / 500 despachos. */
async function dispatchMassPrepare(db,input){
 const errors=[],rows=[],groups=new Map(),serialSet=new Set(),bulkTotals=new Map();
 const fail=(row,field,message)=>{if(errors.length<100)errors.push({row,field,message});};
 if(!input||!fieldsOf(input,['operation_id','rows'])||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input.operation_id||''))||
    !Array.isArray(input.rows)||!input.rows.length||input.rows.length>500)
  return {valid:false,errors:[{row:0,field:'Archivo',message:'Se requieren entre 1 y 500 filas y un identificador válido.'}]};
 const keys=['technician_document','centro','almacen','dispatch_date','sap_code','serial','quantity','notes'];
 for(let i=0;i<input.rows.length;i++){
  const raw=input.rows[i],line=i+2;
  if(!fieldsOf(raw,keys)){fail(line,'Columnas','La fila tiene columnas inesperadas o datos inválidos.');continue;}
  const row={
   line,technician_document:trimmed(raw.technician_document,25).toUpperCase(),
   centro:trimmed(raw.centro,30).toUpperCase(),almacen:trimmed(raw.almacen,30).toUpperCase(),
   dispatch_date:trimmed(raw.dispatch_date,10),
   sap_code:trimmed(raw.sap_code,50).toUpperCase(),
   serial:trimmed(raw.serial,100).toUpperCase(),
   quantity:Number(raw.quantity),notes:trimmed(raw.notes,240)
  };
  if(!/^[A-Z0-9-]{4,25}$/.test(row.technician_document)){fail(line,'Identificación técnico','Identificación requerida o inválida.');continue;}
  if(!/^[A-Z0-9._/-]{1,30}$/.test(row.centro)||!/^[A-Z0-9._/-]{1,30}$/.test(row.almacen)){
   fail(line,'Bodega','Centro y Almacén son obligatorios.');continue;
  }
  if(!ingDate(row.dispatch_date)){fail(line,'Fecha de despacho','Usa AAAA-MM-DD con una fecha válida.');continue;}
  if(!/^[A-Z0-9][A-Z0-9._/-]{1,49}$/.test(row.sap_code)){fail(line,'Código SAP','Código SAP obligatorio o inválido.');continue;}
  if(!Number.isInteger(row.quantity)||row.quantity<1||row.quantity>1000000){
   fail(line,'Cantidad','La cantidad debe ser un entero positivo.');continue;
  }
  if(row.serial&&row.quantity!==1){fail(line,'Cantidad','Cada serial corresponde a una unidad (cantidad 1).');continue;}
  if(String(raw.notes||'').trim().length>240||String(raw.serial||'').trim().length>100){
   fail(line,'Observaciones / Serial','Se excedió la longitud permitida.');continue;
  }
  if(row.serial){
   if(serialSet.has(row.serial))fail(line,'Serial','El serial está repetido en otra fila del Excel.');
   serialSet.add(row.serial);
  }
  rows.push(row);
 }
 if(rows.length){
  const [technicians,warehouses,saps,serials]=await Promise.all([
   db.prepare("SELECT id,document_number,full_name FROM master_personnel WHERE position='TECNICO' AND is_active=1 AND document_number IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(rows.map(r=>r.technician_document))])).all(),
   db.prepare("SELECT id,centro,almacen,description FROM master_logistics_locations WHERE administration='PROPIA' AND is_active=1").all(),
   db.prepare("SELECT sap_code,description,serial_profile FROM master_sap_catalog WHERE is_active=1 AND sap_code IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(rows.map(r=>r.sap_code))])).all(),
   db.prepare(
    "SELECT inv.serial,inv.sap_code,inv.warehouse_id,inv.status,assign.serial AS assigned "+
    "FROM inventory_serials inv LEFT JOIN dispatch_serial_assignments assign ON assign.serial=inv.serial COLLATE NOCASE "+
    "WHERE inv.serial COLLATE NOCASE IN (SELECT value FROM json_each(?))"
   ).bind(JSON.stringify([...serialSet])).all()
  ]);
  const people=new Map((technicians.results||[]).map(p=>[String(p.document_number).toUpperCase(),p]));
  const locations=new Map((warehouses.results||[]).map(w=>[(String(w.centro)+'|'+String(w.almacen)).toUpperCase(),w]));
  const catalog=new Map((saps.results||[]).map(i=>[i.sap_code,i]));
  const available=new Map((serials.results||[]).map(i=>[String(i.serial).toUpperCase(),i]));
  // Consultar únicamente las bodegas mencionadas: el catálogo de ubicaciones es unívoco Centro/Almacén.
  const wanted=[...new Set(rows.map(r=>locations.get(r.centro+'|'+r.almacen)?.id).filter(Boolean))];
  const stockList=wanted.length?(await db.prepare(
   "SELECT warehouse_id,sap_code,quantity FROM inventory_bulk_stock WHERE warehouse_id IN (SELECT value FROM json_each(?))"
  ).bind(JSON.stringify(wanted)).all()).results||[]:[];
  const bulkStock=new Map(stockList.map(r=>[r.warehouse_id+'|'+r.sap_code,Number(r.quantity)]));
  for(const row of rows){
   const p=people.get(row.technician_document),w=locations.get(row.centro+'|'+row.almacen),sap=catalog.get(row.sap_code);
   if(!p)fail(row.line,'Técnico','El técnico no existe, está inactivo o no tiene cargo TÉCNICO.');
   if(!w)fail(row.line,'Bodega','El Centro / Almacén no corresponde a una bodega propia activa.');
   if(!sap)fail(row.line,'Código SAP','El SAP no está en la maestra o está inactivo.');
   if(sap?.serial_profile==='CON PERFIL DE SERIE'&&!row.serial)
    fail(row.line,'Serial','Este SAP requiere un serial.');
   if(row.serial){
    const state=available.get(row.serial);
    if(!state||state.status!=='DISPONIBLE'||state.assigned||state.sap_code!==row.sap_code||
       (w&&state.warehouse_id!==w.id))
     fail(row.line,'Serial','El serial no existe o no está disponible en esa bodega para este SAP.');
   }else if(w&&sap){
    const stockKey=w.id+'|'+row.sap_code;
    bulkTotals.set(stockKey,(bulkTotals.get(stockKey)||0)+row.quantity);
   }
   if(!p||!w||!sap)continue;
   const key=p.id+'|'+w.id+'|'+row.dispatch_date;
   if(!groups.has(key))groups.set(key,{
    technician_id:p.id,technician_document:row.technician_document,technician_name:p.full_name,
    warehouse_id:w.id,warehouse_label:w.centro+' / '+w.almacen+' · '+w.description,
    dispatch_date:row.dispatch_date,items:[]
   });
   groups.get(key).items.push({
    sap_code:row.sap_code,sap_description:sap.description,
    serial:row.serial,quantity:row.quantity,notes:row.notes,line:row.line
   });
  }
  for(const [key,total] of bulkTotals){
   if(total>(bulkStock.get(key)||0)){
    const representative=rows.find(r=>locations.get(r.centro+'|'+r.almacen)?.id+'|'+r.sap_code===key);
    fail(representative?.line||0,'Existencias','Se solicitan '+total+' unidades del SAP '+key.split('|').slice(1).join('|')+
      ' en una bodega con '+(bulkStock.get(key)||0)+' disponibles. Se sumaron TODOS los técnicos.');
   }
  }
 }
 if(groups.size>500)fail(0,'Despachos','Máximo 500 despachos por archivo.');
 const summaries=[...groups.values()].map(g=>({
  technician_document:g.technician_document,technician_name:g.technician_name,
  warehouse_label:g.warehouse_label,dispatch_date:g.dispatch_date,
  item_count:g.items.length,units:g.items.reduce((s,it)=>s+it.quantity,0),items:g.items
 }));
 return {valid:errors.length===0,errors,groups:[...groups.values()],summaries,
  totals:{lines:input.rows.length,dispatches:groups.size,
   technicians:new Set([...groups.values()].map(g=>g.technician_id)).size,
   units:rows.reduce((sum,r)=>sum+r.quantity,0)}};
}
async function dispatchMassExisting(db,id,hash,userId){
 const batch=await db.prepare("SELECT content_sha,created_by FROM dispatch_mass_batches WHERE id=?").bind(id).first();
 if(!batch)return null;
 if(batch.content_sha!==hash||batch.created_by!==userId)return ingBad('LOTE_YA_UTILIZADO',409);
 const result=await db.prepare(
  "SELECT d.id,d.reference,d.dispatch_date,p.full_name AS technician_name,p.document_number AS technician_document,"+
  "w.centro,w.almacen,"+
  "(SELECT count(*) FROM dispatch_items i WHERE i.dispatch_id=d.id) AS item_count,"+
  "(SELECT coalesce(sum(i.quantity),0) FROM dispatch_items i WHERE i.dispatch_id=d.id) AS units "+
  "FROM dispatch_mass_batch_documents b JOIN dispatch_documents d ON d.id=b.dispatch_id "+
  "JOIN master_personnel p ON p.id=d.technician_id "+
  "JOIN master_logistics_locations w ON w.id=d.warehouse_id "+
  "WHERE b.batch_id=? ORDER BY p.full_name,d.reference"
 ).bind(id).all();
 const dispatches=result.results||[];
 return json({ok:true,confirmed:true,replayed:true,operation_id:id,
  dispatches,totals:{
   dispatches:dispatches.length,technicians:new Set(dispatches.map(d=>d.technician_document)).size,
   lines:dispatches.reduce((s,d)=>s+Number(d.item_count),0),
   units:dispatches.reduce((s,d)=>s+Number(d.units),0)}});
}
async function dispatchMassHandler(request,env,user,path){
 if(request.method!=='POST')return ingBad('METODO_NO_PERMITIDO',405);
 const input=await ingBody(request,650000);
 if(input.error)return ingBad(input.error,input.status);
 const data=input.data,operationId=String(data.operation_id||'');
 // Hash de contenido canónico para reintentos seguros tras pérdida de respuesta.
 if(!data||!Array.isArray(data.rows)||data.rows.length<1)
  return ingBad('ARCHIVO_INVALIDO',400);
 const canonical=JSON.stringify(data.rows);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
 const hash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
 const isCommit=path.endsWith('/confirmar');
 if(isCommit&&/^[0-9a-f-]{36}$/i.test(operationId)){
  const previous=await dispatchMassExisting(env.DB,operationId,hash,user.id);
  if(previous)return previous;
 }
 const preview=await dispatchMassPrepare(env.DB,data);
 if(!preview.valid){
  if(isCommit)return ingBad('CARGA_MASIVA_INVALIDA',422,{validation:{
   valid:false,errors:preview.errors,totals:preview.totals}});
  return json({ok:true,valid:false,errors:preview.errors,
   totals:preview.totals||{lines:data.rows.length,dispatches:0,technicians:0,units:0},
   groups:preview.summaries||[]});
 }
 if(!isCommit)return json({ok:true,valid:true,errors:[],totals:preview.totals,groups:preview.summaries});
 const now=new Date().toISOString().slice(0,10).replace(/-/g,'');
 const docs=preview.groups.map(g=>{
  const id=crypto.randomUUID();
  return {id,reference:'DES-'+now+'-'+id.slice(0,8).toUpperCase(),
   technician_id:g.technician_id,warehouse_id:g.warehouse_id,dispatch_date:g.dispatch_date,
   notes:'Asignación por carga masiva',items:g.items};
 });
 const itemRows=docs.flatMap(doc=>doc.items.map((item,position)=>({
  id:crypto.randomUUID(),dispatch_id:doc.id,position:position+1,
  sap_code:item.sap_code,serial:item.serial,quantity:item.quantity,notes:item.notes
 })));
 const slimDocs=docs.map(({items,...rest})=>rest);
 const docJson=JSON.stringify(slimDocs),itemJson=JSON.stringify(itemRows);
 const statements=[
  env.DB.prepare("INSERT INTO dispatch_mass_batches(id,content_sha,created_by) VALUES (?,?,?)")
   .bind(operationId,hash,user.id),
  env.DB.prepare(
   "INSERT INTO dispatch_documents(id,reference,technician_id,warehouse_id,dispatch_date,notes,created_by,updated_by) "+
   "SELECT json_extract(value,'$.id'),json_extract(value,'$.reference'),json_extract(value,'$.technician_id'),"+
   "json_extract(value,'$.warehouse_id'),json_extract(value,'$.dispatch_date'),json_extract(value,'$.notes'),?,? "+
   "FROM json_each(?)"
  ).bind(user.id,user.id,docJson),
  env.DB.prepare(
   "INSERT INTO dispatch_items(id,dispatch_id,position,sap_code,serial,quantity,notes) "+
   "SELECT json_extract(value,'$.id'),json_extract(value,'$.dispatch_id'),json_extract(value,'$.position'),"+
   "json_extract(value,'$.sap_code'),json_extract(value,'$.serial'),json_extract(value,'$.quantity'),"+
   "json_extract(value,'$.notes') FROM json_each(?)"
  ).bind(itemJson)
 ];
 // La confirmación masiva se realiza con UNA consulta SQL, no una por despacho.
 // Esto mantiene el total de consultas muy por debajo del límite por petición de D1.
 // Los triggers de inventario siguen verificando CADA despacho fila a fila, dentro
 // de la misma transacción: cualquier error revierte todos los despachos.
 statements.push(env.DB.prepare(
  "UPDATE dispatch_documents SET status='DESPACHADO',confirmed_by=?,confirmed_at=CURRENT_TIMESTAMP,"+
  "updated_at=CURRENT_TIMESTAMP WHERE status='BORRADOR' "+
  "AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))"
 ).bind(user.id,docJson));
 statements.push(env.DB.prepare(
  "INSERT INTO dispatch_audit(id,dispatch_id,actor_id,action,details) "+
  "SELECT lower(hex(randomblob(16))),json_extract(value,'$.id'),?,'DESPACHAR',? FROM json_each(?)"
 ).bind(user.id,JSON.stringify({source:'MASIVO',operation_id:operationId}),docJson));
 statements.push(env.DB.prepare(
  "INSERT INTO dispatch_mass_batch_documents(batch_id,dispatch_id) "+
  "SELECT ?,json_extract(value,'$.id') FROM json_each(?)"
 ).bind(operationId,docJson));
 try{await env.DB.batch(statements);}
 catch(error){
  const existing=await dispatchMassExisting(env.DB,operationId,hash,user.id);
  if(existing)return existing;
  return ingBad('CARGA_MASIVA_REVALIDAR',409);
 }
 return dispatchMassExisting(env.DB,operationId,hash,user.id);
}

/* Importación de saldos iniciales de única ejecución.
 * La apertura produce Ingresos identificables como SALDO_INICIAL y deja intactas Maestras.
 * Nunca habilita una segunda apertura, ni siquiera después de nuevos despliegues. */
async function openingState(db){
 const [opened,ing,des,serial,bulk,moves,dispatchMoves]=await Promise.all([
  db.prepare("SELECT key,operation_id,content_sha,completed_at,document_count,item_count,total_units FROM opening_stock_once WHERE key='APERTURA-2026-11-11'").first(),
  db.prepare("SELECT count(*) AS n FROM ingress_documents").first(),
  db.prepare("SELECT count(*) AS n FROM dispatch_documents").first(),
  db.prepare("SELECT count(*) AS n FROM inventory_serials").first(),
  db.prepare("SELECT count(*) AS n FROM inventory_bulk_stock WHERE quantity>0").first(),
  db.prepare("SELECT count(*) AS n FROM inventory_movements").first(),
  db.prepare("SELECT count(*) AS n FROM dispatch_movements").first()
 ]);
 const operational=Number(ing?.n||0)+Number(des?.n||0)+Number(serial?.n||0)+
  Number(bulk?.n||0)+Number(moves?.n||0)+Number(dispatchMoves?.n||0);
 return {completed:!!opened,available:!opened&&operational===0,
  blocked:!opened&&operational>0,record:opened?{
   completed_at:opened.completed_at,
   documents:opened.document_count,items:opened.item_count,units:opened.total_units
  }:null};
}
function openingNormalize(input){
 const errors=[],valid=[],serials=new Set();
 const fail=(row,field,message)=>{if(errors.length<90)errors.push({row,field,message});};
 if(!input||!fieldsOf(input,['operation_id','rows'])||
   !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input.operation_id||''))||
   !Array.isArray(input.rows)||input.rows.length<1||input.rows.length>2500)
  return {errors:[{row:0,field:'Archivo',message:'La plantilla admite entre 1 y 2500 filas por apertura.'}],rows:[]};
 const keys=['centro','almacen','sap_code','serial','quantity','lot','reception_state','notes'];
 for(let i=0;i<input.rows.length;i++){
  const raw=input.rows[i],line=i+2;
  if(!fieldsOf(raw,keys)){fail(line,'Columnas','Campos no reconocidos. Usa la plantilla de saldos iniciales.');continue;}
  const source={};
  for(const key of keys){
   if(typeof raw[key]==='object'&&raw[key]!==null){fail(line,key,'No se permiten valores complejos.');continue;}
   source[key]=String(raw[key]??'').trim();
  }
  if(keys.some(key=>source[key]===undefined))continue;
  const row={line,
   centro:source.centro.toUpperCase(),almacen:source.almacen.toUpperCase(),
   sap_code:source.sap_code.toUpperCase(),serial:source.serial.toUpperCase(),
   quantity:Number(raw.quantity),
   lot:source.lot.toUpperCase(),reception_state:source.reception_state.toUpperCase(),
   notes:source.notes
  };
  if(!row.centro||!row.almacen||row.centro.length>30||row.almacen.length>30){
   fail(line,'Bodega','Centro y Almacén son obligatorios y no pueden superar 30 caracteres.');
  }
  if(!row.sap_code||row.sap_code.length>50)fail(line,'Código SAP','Debe indicar el código SAP existente en Maestras.');
  if(row.serial.length>100)fail(line,'Serial','Máximo 100 caracteres.');
  if(!Number.isInteger(row.quantity)||row.quantity<1||row.quantity>1000000)
   fail(line,'Cantidad','La cantidad debe ser un entero de 1 a 1.000.000.');
  if(row.serial&&row.quantity!==1)fail(line,'Cantidad','Un serial corresponde a una sola unidad.');
  if(!['VALORADO','NOVALORADO'].includes(row.lot))
   fail(line,'Lote','Solo VALORADO o NOVALORADO.');
  if(!['NUEVO','REMANUFACTURADO'].includes(row.reception_state))
   fail(line,'Estado de recepción','Solo NUEVO o REMANUFACTURADO.');
  if(row.notes.length>240)fail(line,'Observaciones','Máximo 240 caracteres.');
  if(row.serial){
   if(serials.has(row.serial))fail(line,'Serial','El serial está repetido en el archivo.');
   serials.add(row.serial);
  }
  valid.push(row);
 }
 return {errors,rows:valid,serials:[...serials]};
}
async function openingPrepare(db,input){
 const normalized=openingNormalize(input);
 const errors=[...normalized.errors],rows=normalized.rows;
 const add=(row,field,message)=>{if(errors.length<90)errors.push({row,field,message});};
 const groups=new Map(),existingSerials=[];
 if(!rows.length)return {valid:false,errors,groups:[],totals:{lines:0,units:0,warehouses:0}};
 const [warehouseResults,sapResults,serialResult]=await Promise.all([
  db.prepare("SELECT id,centro,almacen,description FROM master_logistics_locations WHERE is_active=1 AND administration='PROPIA'").all(),
  db.prepare("SELECT sap_code,description,serial_profile FROM master_sap_catalog WHERE is_active=1 AND sap_code IN (SELECT value FROM json_each(?))")
   .bind(JSON.stringify([...new Set(rows.map(r=>r.sap_code))])).all(),
  normalized.serials.length?
   db.prepare("SELECT serial FROM inventory_serials WHERE serial COLLATE NOCASE IN (SELECT value FROM json_each(?))").bind(JSON.stringify(normalized.serials)).all():
   Promise.resolve({results:[]})
 ]);
 const whs=new Map((warehouseResults.results||[]).map(w=>[(w.centro+'|'+w.almacen).toUpperCase(),w]));
 const saps=new Map((sapResults.results||[]).map(s=>[s.sap_code,s]));
 for(const r of serialResult.results||[])existingSerials.push(String(r.serial).toUpperCase());
 const existing=new Set(existingSerials);
 for(const row of rows){
  const wh=whs.get(row.centro+'|'+row.almacen),sap=saps.get(row.sap_code);
  if(!wh)add(row.line,'Bodega','No existe una bodega propia activa con ese Centro y Almacén.');
  if(!sap)add(row.line,'Código SAP','El SAP no existe o está inactivo en Equipos y materiales.');
  if(sap?.serial_profile==='CON PERFIL DE SERIE'&&!row.serial)
   add(row.line,'Serial','Este SAP requiere serial; cada unidad debe tener su propia fila.');
  if(row.serial&&existing.has(row.serial))
   add(row.line,'Serial','Este serial ya existe en el inventario.');
  if(!wh||!sap)continue;
  if(!groups.has(wh.id))groups.set(wh.id,{warehouse_id:wh.id,
   warehouse_label:wh.centro+' / '+wh.almacen+' · '+wh.description,
   centro:wh.centro,almacen:wh.almacen,items:[],units:0});
  const group=groups.get(wh.id);
  group.items.push({...row,sap_description:sap.description});
  group.units+=Number.isFinite(row.quantity)?row.quantity:0;
 }
 if(groups.size>150)add(0,'Bodegas','Máximo 150 bodegas en una misma apertura.');
 const totals={lines:rows.length,units:rows.reduce((x,r)=>x+(Number.isFinite(r.quantity)?r.quantity:0),0),
  warehouses:groups.size,serialized:rows.filter(r=>!!r.serial).length};
 return {valid:errors.length===0,errors,groups:[...groups.values()],totals};
}
async function openingExisting(db,input,user){
 const row=await db.prepare("SELECT * FROM opening_stock_once WHERE key='APERTURA-2026-11-11'").first();
 if(!row)return null;
 const canonical=JSON.stringify(input.rows||[]);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
 const hash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(row.operation_id!==input.operation_id||row.content_sha!==hash||row.actor_id!==user.id)
  return ingBad('APERTURA_YA_REALIZADA',409,{completed_at:row.completed_at});
 const docs=await db.prepare(
  "SELECT d.id,d.reference,d.document_number,d.destination_id,w.description AS warehouse_name "+
  "FROM opening_stock_documents o JOIN ingress_documents d ON d.id=o.ingress_id "+
  "JOIN master_logistics_locations w ON w.id=d.destination_id WHERE o.key=? ORDER BY w.description"
 ).bind('APERTURA-2026-11-11').all();
 return json({ok:true,completed:true,replayed:true,documents:docs.results||[],totals:{
  warehouses:row.document_count,lines:row.item_count,units:row.total_units},completed_at:row.completed_at});
}
async function openingHandler(request,env,user,path){
 if(!user)return ingBad('NO_AUTENTICADO',401);
 if(user.role!=='ADMIN')return ingBad('SIN_PERMISOS',403);
 const db=env.DB,method=request.method;
 if(path==='/api/saldos-iniciales/estado'){
  if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
  return json({ok:true,...await openingState(db)});
 }
 if(path==='/api/saldos-iniciales/catalogos'){
  if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
  const [wh,sap]=await Promise.all([
   db.prepare("SELECT centro,almacen,description FROM master_logistics_locations WHERE is_active=1 AND administration='PROPIA' ORDER BY centro,almacen").all(),
   db.prepare("SELECT sap_code,description,serial_profile FROM master_sap_catalog WHERE is_active=1 ORDER BY sap_code LIMIT 5000").all()
  ]);
  return json({ok:true,warehouses:wh.results||[],catalog:sap.results||[]});
 }
 const isPreview=path==='/api/saldos-iniciales/validar';
 const isCommit=path==='/api/saldos-iniciales/confirmar';
 if(!isPreview&&!isCommit)return ingBad('RUTA_NO_DISPONIBLE',404);
 if(method!=='POST')return ingBad('METODO_NO_PERMITIDO',405);
 const parsed=await ingBody(request,1250000);
 if(parsed.error)return ingBad(parsed.error,parsed.status);
 const input=parsed.data;
 if(!Array.isArray(input.rows))return ingBad('ARCHIVO_INVALIDO',400);
 if(isCommit){
  const replay=await openingExisting(db,input,user);
  if(replay)return replay;
 }
 const state=await openingState(db);
 if(!state.available)return ingBad(state.completed?'APERTURA_YA_REALIZADA':'APERTURA_REQUIERE_INVENTARIO_VACIO',409);
 const prepared=await openingPrepare(db,input);
 if(!isCommit)return json({ok:true,...prepared});
 if(!prepared.valid)return ingBad('APERTURA_INVALIDA',422,{validation:{
  valid:false,errors:prepared.errors,totals:prepared.totals}});
 const canonical=JSON.stringify(input.rows);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
 const contentSha=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
 const documents=prepared.groups.map(g=>{
  const id=crypto.randomUUID();
  return {id,warehouse_id:g.warehouse_id,
   document_number:'APERTURA-20261111-'+g.centro+'-'+g.almacen,
   items:g.items};
 });
 const bulkItems=documents.flatMap(d=>d.items.map((it,position)=>({
  id:crypto.randomUUID(),ingress_id:d.id,position:position+1,
  sap_code:it.sap_code,serial:it.serial,quantity:it.quantity,lot:it.lot,
  reception_state:it.reception_state,physical_state:'BUENO',availability_state:'DISPONIBLE',notes:it.notes
 })));
 const docJson=JSON.stringify(documents.map(({items,...rest})=>rest));
 const itemsJson=JSON.stringify(bulkItems);
 const statements=[
  db.prepare(
   "INSERT INTO opening_stock_once(key,operation_id,content_sha,actor_id,document_count,item_count,total_units) "+
   "SELECT 'APERTURA-2026-11-11',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ingress_documents) "+
   "AND NOT EXISTS(SELECT 1 FROM dispatch_documents) "+
   "AND NOT EXISTS(SELECT 1 FROM inventory_serials) "+
   "AND NOT EXISTS(SELECT 1 FROM inventory_bulk_stock WHERE quantity>0) "+
   "AND NOT EXISTS(SELECT 1 FROM inventory_movements) "+
   "AND NOT EXISTS(SELECT 1 FROM dispatch_movements)"
  ).bind(input.operation_id,contentSha,user.id,documents.length,bulkItems.length,prepared.totals.units),
  db.prepare(
   "INSERT INTO ingress_documents(id,document_type,document_number,document_date,received_date,source_id,destination_id,notes,created_by,updated_by) "+
   "SELECT json_extract(value,'$.id'),'SALDO_INICIAL',json_extract(value,'$.document_number'),"+
   "'2026-11-11','2026-11-11',json_extract(value,'$.warehouse_id'),json_extract(value,'$.warehouse_id'),"+
   "'Saldo inicial de inventario · carga única 2026-11-11',?,? FROM json_each(?)"
  ).bind(user.id,user.id,docJson),
  db.prepare(
   "INSERT INTO ingress_items(id,ingress_id,position,sap_code,serial,quantity,lot,reception_state,physical_state,availability_state,notes) "+
   "SELECT json_extract(value,'$.id'),json_extract(value,'$.ingress_id'),json_extract(value,'$.position'),"+
   "json_extract(value,'$.sap_code'),json_extract(value,'$.serial'),json_extract(value,'$.quantity'),"+
   "json_extract(value,'$.lot'),json_extract(value,'$.reception_state'),'BUENO','DISPONIBLE',json_extract(value,'$.notes') "+
   "FROM json_each(?)"
  ).bind(itemsJson)
 ];
 for(const doc of documents)
  statements.push(db.prepare(
   "UPDATE ingress_documents SET status='REGISTRADO',reference=?,registered_by=?,registered_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP "+
   "WHERE id=? AND status='BORRADOR'"
  ).bind('ING-20261111-'+doc.id.slice(0,8).toUpperCase(),user.id,doc.id));
 statements.push(db.prepare(
  "INSERT INTO ingress_audit(id,ingress_id,actor_id,action,details) "+
  "SELECT lower(hex(randomblob(16))),json_extract(value,'$.id'),?,'REGISTRAR',? FROM json_each(?)"
 ).bind(user.id,JSON.stringify({source:'SALDO_INICIAL',date:'2026-11-11'}),docJson));
 statements.push(db.prepare(
  "INSERT INTO opening_stock_documents(key,ingress_id) "+
  "SELECT 'APERTURA-2026-11-11',json_extract(value,'$.id') FROM json_each(?) "+
  "WHERE EXISTS(SELECT 1 FROM opening_stock_once WHERE key='APERTURA-2026-11-11')"
 ).bind(docJson));
 try{await db.batch(statements);}
 catch{
  const replay=await openingExisting(db,input,user);
  if(replay)return replay;
  return ingBad('APERTURA_NO_CONFIRMADA',409);
 }
 return openingExisting(db,input,user);
}


/* Claro WFM: el reporte de consumo (Sheet2) es la fuente de OT, técnico y SAP.
 * Sheet1 aporta exclusivamente el serial interno cuando Claro omite el serial.
 * Nunca se altera stock de bodega al consumir: se descontó en Despachos. */
async function consumptionPrepare(db,input){
 const errors=[],rows=[],duplicateKeys=new Set(),reportSerials=new Set();
 const add=(row,field,message)=>{if(errors.length<120)errors.push({row,field,message});};
 const allowed=['line','technician_document','centro','almacen','sap_code','ot','wfm_id',
  'consumption_date','quantity','reported_serial','support','lot'];
 if(!input||!fieldsOf(input,['operation_id','filename','rows'])||
  !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(String(input.operation_id||''))||
  !Array.isArray(input.rows)||input.rows.length<1||input.rows.length>500)
  return {valid:false,errors:[{row:0,field:'Archivo',message:'Se requieren entre 1 y 500 consumos y un identificador válido.'}]};
 for(let index=0;index<input.rows.length;index++){
  const raw=input.rows[index],line=Number(raw?.line)||index+2;
  if(!fieldsOf(raw,allowed)){add(line,'Formato','Fila con campos no admitidos.');continue;}
  const get=(name,max)=>String(raw[name]??'').trim().toUpperCase().slice(0,max);
  const support=raw.support&&typeof raw.support==='object'&&!Array.isArray(raw.support)?raw.support:null;
  if(support&&!fieldsOf(support,['sap_code','ot','wfm_id','technician_document','serial','serial_profile'])){
   add(line,'Sheet1','Datos auxiliares inesperados.');continue;
  }
  const row={line,
   technician_document:get('technician_document',25),centro:get('centro',30),
   almacen:get('almacen',30),sap_code:get('sap_code',50),ot:get('ot',40),
   wfm_id:get('wfm_id',40).replace(/^7K/,''),
   consumption_date:get('consumption_date',10),quantity:Number(raw.quantity),
   reported_serial:get('reported_serial',100),lot:get('lot',20),
   support:support?{
    sap_code:String(support.sap_code??'').trim().toUpperCase(),
    ot:String(support.ot??'').trim().toUpperCase(),
    wfm_id:String(support.wfm_id??'').trim().toUpperCase().replace(/^7K/,''),
    technician_document:String(support.technician_document??'').trim().toUpperCase(),
    serial:String(support.serial??'').trim().toUpperCase(),
    serial_profile:String(support.serial_profile??'').trim().toUpperCase()
   }:null
  };
  if(!/^[0-9A-Z-]{4,25}$/.test(row.technician_document))add(line,'Técnico','Identificación inválida.');
  if(!row.centro||!row.almacen)add(line,'Bodega','Centro y Almacén obligatorios.');
  if(!row.sap_code)add(line,'SAP','Código SAP vacío.');
  if(!/^OT[0-9A-Z-]{4,38}$/.test(row.ot))add(line,'OT','Orden de trabajo inválida.');
  if(!/^[0-9A-Z-]{1,40}$/.test(row.wfm_id))add(line,'ID WFM','Identificador WFM obligatorio.');
  if(!ingDate(row.consumption_date))add(line,'Fecha','La fecha debe ser AAAA-MM-DD.');
  if(!Number.isInteger(row.quantity)||row.quantity<1||row.quantity>1000000)
   add(line,'Cantidad','Debe ser un entero positivo.');
  if(row.reported_serial&&row.quantity!==1)add(line,'Cantidad','Un serial corresponde a una unidad.');
  if(row.lot&&!['VALORADO','NOVALORADO'].includes(row.lot))add(line,'Lote','Lote no reconocido.');
  if(row.support){
   const sp=row.support;
   if(sp.sap_code!==row.sap_code||sp.ot!==row.ot||sp.wfm_id!==row.wfm_id||
      sp.technician_document!==row.technician_document)
    add(line,'Sheet1','No coincide SAP, OT, técnico o ID WFM entre las dos hojas.');
   if(row.reported_serial&&sp.serial&&row.reported_serial!==sp.serial)
    add(line,'Serial','El serial reportado en Sheet2 no coincide con Sheet1.');
  }
  row.internal_serial=row.reported_serial||row.support?.serial||'';
  if(!row.reported_serial&&row.support&&!row.internal_serial)
   add(line,'Serial','El registro de Sheet1 no aporta serial interno.');
  if(row.internal_serial&&row.quantity!==1)add(line,'Cantidad','El serial interno requiere cantidad 1.');
  row.source_key=[
   row.technician_document,row.ot,row.wfm_id,row.sap_code,row.internal_serial||'SIN_SERIAL'
  ].join('|');
  if(duplicateKeys.has(row.source_key))add(line,'Duplicado','El consumo se repite dentro del archivo.');
  duplicateKeys.add(row.source_key);
  if(row.internal_serial){
   if(reportSerials.has(row.internal_serial))add(line,'Serial','El serial está repetido en este reporte.');
   reportSerials.add(row.internal_serial);
  }
  rows.push(row);
 }
 if(!rows.length)return {valid:false,errors,groups:[],totals:{lines:0,units:0,technicians:0,ots:0}};
 const docs=[...new Set(rows.map(x=>x.technician_document))],saps=[...new Set(rows.map(x=>x.sap_code))];
 const [peopleResult,sapResult,assignedResult,consumedResult]=await Promise.all([
  db.prepare("SELECT id,document_number,full_name FROM master_personnel WHERE position='TECNICO' AND is_active=1 AND document_number COLLATE NOCASE IN (SELECT value FROM json_each(?))")
   .bind(JSON.stringify(docs)).all(),
  db.prepare("SELECT sap_code,description,serial_profile FROM master_sap_catalog WHERE sap_code IN (SELECT value FROM json_each(?))")
   .bind(JSON.stringify(saps)).all(),
  db.prepare(
   "SELECT m.dispatch_item_id,m.dispatch_id,m.technician_id,m.sap_code,m.serial,m.quantity,"+
   "p.document_number AS technician_document,d.reference AS dispatch_reference,"+
   "w.centro,w.almacen,IFNULL(a.serial,'') AS assigned_serial "+
   "FROM dispatch_movements m "+
   "JOIN dispatch_documents d ON d.id=m.dispatch_id AND d.status='DESPACHADO' "+
   "JOIN master_personnel p ON p.id=m.technician_id "+
   "JOIN master_logistics_locations w ON w.id=m.warehouse_id "+
   "LEFT JOIN dispatch_serial_assignments a ON a.dispatch_item_id=m.dispatch_item_id "+
   "WHERE p.document_number COLLATE NOCASE IN (SELECT value FROM json_each(?)) "+
   "AND m.sap_code IN (SELECT value FROM json_each(?)) LIMIT 12000"
  ).bind(JSON.stringify(docs),JSON.stringify(saps)).all(),
  db.prepare(
   "SELECT c.dispatch_item_id,c.quantity,c.internal_serial,c.source_key "+
   "FROM consumption_items c JOIN master_personnel p ON p.id=c.technician_id "+
   "WHERE p.document_number COLLATE NOCASE IN (SELECT value FROM json_each(?)) "+
   "AND c.sap_code IN (SELECT value FROM json_each(?)) LIMIT 12000"
  ).bind(JSON.stringify(docs),JSON.stringify(saps)).all()
 ]);
 const persons=new Map((peopleResult.results||[]).map(p=>[String(p.document_number).toUpperCase(),p]));
 const catalog=new Map((sapResult.results||[]).map(p=>[String(p.sap_code).toUpperCase(),p]));
 const assigned=assignedResult.results||[],consumed=consumedResult.results||[];
 const taken=new Map(),usedKeys=new Set(consumed.map(c=>c.source_key)),usedSerials=new Set();
 for(const c of consumed){
  taken.set(c.dispatch_item_id,(taken.get(c.dispatch_item_id)||0)+Number(c.quantity));
  if(c.internal_serial)usedSerials.add(String(c.internal_serial).toUpperCase());
 }
 const pending=new Map(),groups=new Map();
 for(const row of rows){
  const person=persons.get(row.technician_document),sap=catalog.get(row.sap_code);
  if(!person)add(row.line,'Técnico','El técnico no está activo en Maestras.');
  if(!sap)add(row.line,'SAP','El SAP no está registrado en Maestras.');
  if(sap?.serial_profile==='CON PERFIL DE SERIE'&&!row.reported_serial)
   add(row.line,'Serial','Claro debe reportar serial para equipos CON PERFIL DE SERIE.');
  if(sap?.serial_profile==='SIN PERFIL DE SERIE'&&!row.reported_serial&&row.support&&
     row.support.serial_profile&&row.support.serial_profile!=='SIN PERFIL DE SERIE')
   add(row.line,'Perfil','Sheet1 no coincide con el perfil SIN PERFIL DE SERIE de la maestra.');
  if(usedKeys.has(row.source_key))add(row.line,'Duplicado','Esta OT / SAP / ID WFM ya fue consumida.');
  if(row.internal_serial&&usedSerials.has(row.internal_serial))
   add(row.line,'Serial','Este serial interno ya fue consumido anteriormente.');
  const candidates=assigned.filter(m=>
   String(m.technician_document).toUpperCase()===row.technician_document &&
   String(m.sap_code).toUpperCase()===row.sap_code &&
   String(m.centro).toUpperCase()===row.centro && String(m.almacen).toUpperCase()===row.almacen &&
   String(m.serial||'').toUpperCase()===row.internal_serial
  );
  if(candidates.length!==1){
   add(row.line,'Despacho',candidates.length?
    'Existen asignaciones ambiguas del SAP para este técnico y bodega.':
    'No existe equipo disponible asignado a este técnico con ese SAP, serial y bodega.');
   continue;
  }
  const match=candidates[0];
  if(row.internal_serial&&!match.assigned_serial)
   add(row.line,'Serial','El serial no figura como asignado al técnico.');
  const used=(taken.get(match.dispatch_item_id)||0)+(pending.get(match.dispatch_item_id)||0);
  if(Number(match.quantity)-used<row.quantity)
   add(row.line,'Cantidad','Se intenta consumir más unidades de las asignadas y pendientes.');
  pending.set(match.dispatch_item_id,(pending.get(match.dispatch_item_id)||0)+row.quantity);
  const enriched={...row,technician_id:person?.id||'',technician_name:person?.full_name||'',
   sap_description:sap?.description||'',dispatch_item_id:match.dispatch_item_id,
   dispatch_reference:match.dispatch_reference,
   source:row.reported_serial?'SERIAL_CLARO':row.internal_serial?'SERIAL_SHEET1':'SIN_SERIAL'};
  const gkey=row.technician_document;
  if(!groups.has(gkey))groups.set(gkey,{technician_name:enriched.technician_name,
   technician_document:gkey,items:[],units:0});
  groups.get(gkey).items.push(enriched);groups.get(gkey).units+=row.quantity;
 }
 const totals={lines:rows.length,units:rows.reduce((sum,x)=>sum+(Number.isInteger(x.quantity)?x.quantity:0),0),
  technicians:groups.size,ots:new Set(rows.map(x=>x.ot)).size,
  recovered:rows.filter(r=>!r.reported_serial&&r.internal_serial).length};
 return {valid:errors.length===0,errors,groups:[...groups.values()],totals,
  items:[...groups.values()].flatMap(g=>g.items)};
}
async function consumptionExisting(db,input,actor){
 const result=await db.prepare("SELECT * FROM consumption_batches WHERE operation_id=?").bind(input.operation_id).first();
 if(!result)return null;
 const contentHash=await hash(JSON.stringify(input.rows));
 if(contentHash!==result.content_sha||actor.id!==result.actor_id)
  return ingBad('LOTE_CONSUMOS_YA_UTILIZADO',409);
 const rows=await db.prepare(
  "SELECT c.ot,c.wfm_id,c.sap_code,c.internal_serial,c.reported_serial,c.quantity,c.consumo_fecha,"+
  "p.full_name AS technician_name,p.document_number AS technician_document "+
  "FROM consumption_items c JOIN master_personnel p ON p.id=c.technician_id "+
  "WHERE c.batch_id=? ORDER BY c.source_row"
 ).bind(result.id).all();
 return json({ok:true,confirmed:true,replayed:true,items:rows.results||[],
  totals:{lines:(rows.results||[]).length,
   units:(rows.results||[]).reduce((sum,r)=>sum+Number(r.quantity),0)}});
}
async function consumptionHandler(request,env,user,path){
 if(!user)return ingBad('NO_AUTENTICADO',401);
 if(user.role!=='ADMIN')return ingBad('SIN_PERMISOS',403);
 const db=env.DB,method=request.method;
 if(path==='/api/consumos'){
  if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
  const [batches,summary]=await Promise.all([
   db.prepare(
    "SELECT b.id,b.source_filename,b.created_at,COUNT(c.id) AS lines,"+
    "COALESCE(SUM(c.quantity),0) AS units,COUNT(DISTINCT c.technician_id) AS technicians "+
    "FROM consumption_batches b LEFT JOIN consumption_items c ON c.batch_id=b.id "+
    "GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100"
   ).all(),
   db.prepare(
    "SELECT (SELECT COUNT(*) FROM consumption_items) AS lines,"+
    "(SELECT COALESCE(SUM(quantity),0) FROM consumption_items) AS units,"+
    "(SELECT COUNT(DISTINCT technician_id) FROM consumption_items) AS technicians,"+
    "(SELECT COUNT(*) FROM consumption_batches) AS reports"
   ).first()
  ]);
  return json({ok:true,items:batches.results||[],summary});
 }
 if(path.startsWith('/api/consumos/lote/')){
  if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
  const id=path.split('/').pop();
  if(!/^[0-9a-f-]{36}$/i.test(id))return ingBad('LOTE_NO_ENCONTRADO',404);
  const header=await db.prepare("SELECT * FROM consumption_batches WHERE id=?").bind(id).first();
  if(!header)return ingBad('LOTE_NO_ENCONTRADO',404);
  const rows=await db.prepare(
   "SELECT c.ot,c.wfm_id,c.sap_code,s.description AS sap_description,c.internal_serial,"+
   "c.reported_serial,c.quantity,c.consumo_fecha,c.centro,c.almacen,p.full_name AS technician_name,"+
   "p.document_number AS technician_document,d.reference AS dispatch_reference "+
   "FROM consumption_items c JOIN master_personnel p ON p.id=c.technician_id "+
   "JOIN master_sap_catalog s ON s.sap_code=c.sap_code "+
   "JOIN dispatch_items i ON i.id=c.dispatch_item_id JOIN dispatch_documents d ON d.id=i.dispatch_id "+
   "WHERE c.batch_id=? ORDER BY c.source_row"
  ).bind(id).all();
  return json({ok:true,header,items:rows.results||[]});
 }
 const preview=path==='/api/consumos/validar',commit=path==='/api/consumos/confirmar';
 if(!preview&&!commit)return ingBad('RUTA_NO_DISPONIBLE',404);
 if(method!=='POST')return ingBad('METODO_NO_PERMITIDO',405);
 const parsed=await ingBody(request,1400000);
 if(parsed.error)return ingBad(parsed.error,parsed.status);
 const input=parsed.data;
 if(!Array.isArray(input?.rows)||!input.rows.length||input.rows.length>500)
  return ingBad('ARCHIVO_INVALIDO',400);
 if(commit){
  const previous=await consumptionExisting(db,input,user);
  if(previous)return previous;
 }
 const checked=await consumptionPrepare(db,input);
 if(!preview&&!checked.valid)
  return ingBad('CONSUMOS_INVALIDOS',422,{validation:{
   valid:false,errors:checked.errors,totals:checked.totals,groups:checked.groups}});
 if(preview)return json({ok:true,...checked,items:undefined});
 const id=input.operation_id,contentHash=await hash(JSON.stringify(input.rows));
 const jsonRows=JSON.stringify(checked.items.map(it=>({
  id:crypto.randomUUID(),batch_id:id,dispatch_item_id:it.dispatch_item_id,technician_id:it.technician_id,
  sap_code:it.sap_code,ot:it.ot,wfm_id:it.wfm_id,centro:it.centro,almacen:it.almacen,
  consumo_fecha:it.consumption_date,quantity:it.quantity,reported_serial:it.reported_serial,
  internal_serial:it.internal_serial,source_key:it.source_key,lot:it.lot,source_row:it.line
 })));
 try{
  await db.batch([
   db.prepare(
    "INSERT INTO consumption_batches(id,operation_id,content_sha,source_filename,actor_id) VALUES(?,?,?,?,?)"
   ).bind(id,id,contentHash,String(input.filename||'Reporte WFM').slice(0,150),user.id),
   db.prepare(
    "INSERT INTO consumption_items(id,batch_id,dispatch_item_id,technician_id,sap_code,ot,wfm_id,centro,almacen,"+
    "consumo_fecha,quantity,reported_serial,internal_serial,source_key,lot,source_row) "+
    "SELECT json_extract(value,'$.id'),json_extract(value,'$.batch_id'),"+
    "json_extract(value,'$.dispatch_item_id'),json_extract(value,'$.technician_id'),"+
    "json_extract(value,'$.sap_code'),json_extract(value,'$.ot'),json_extract(value,'$.wfm_id'),"+
    "json_extract(value,'$.centro'),json_extract(value,'$.almacen'),"+
    "json_extract(value,'$.consumo_fecha'),json_extract(value,'$.quantity'),"+
    "json_extract(value,'$.reported_serial'),json_extract(value,'$.internal_serial'),"+
    "json_extract(value,'$.source_key'),json_extract(value,'$.lot'),"+
    "json_extract(value,'$.source_row') FROM json_each(?)"
   ).bind(jsonRows)
  ]);
 }catch{
  const prior=await consumptionExisting(db,input,user);
  if(prior)return prior;
  return ingBad('CONSUMOS_CAMBIARON_REVALIDAR',409);
 }
 return consumptionExisting(db,input,user);
}

async function dispatchHandler(request,env,user,path){
 if(!user)return ingBad('NO_AUTENTICADO',401);
 if(user.role!=='ADMIN')return ingBad('SIN_PERMISOS',403);
 const db=env.DB,method=request.method;
 if(path==='/api/despachos/masivo/validar'||path==='/api/despachos/masivo/confirmar')
  return dispatchMassHandler(request,env,user,path);
 if(path==='/api/despachos/catalogos'){
  if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
  const [people,warehouses,serials,bulk]=await Promise.all([
   db.prepare(
    "SELECT p.id,p.document_number,p.full_name,p.department,p.city_base,p.zone,s.full_name AS supervisor_name "+
    "FROM master_personnel p LEFT JOIN master_personnel s ON s.id=p.supervisor_id "+
    "WHERE p.position='TECNICO' AND p.is_active=1 ORDER BY p.full_name COLLATE NOCASE LIMIT 2500").all(),
   // Solo bodegas propias con saldo asignable, no cualquier bodega activa.
   // UNION ALL suma seriales libres y material no serializado con stock positivo.
   db.prepare(
    "WITH stock AS ("+
    "SELECT inv.warehouse_id,COUNT(*) AS units FROM inventory_serials inv "+
    "JOIN master_sap_catalog sap ON sap.sap_code=inv.sap_code "+
    "LEFT JOIN dispatch_serial_assignments assigned ON assigned.serial=inv.serial COLLATE NOCASE "+
    "WHERE inv.status='DISPONIBLE' AND assigned.serial IS NULL AND sap.is_active=1 "+
    "GROUP BY inv.warehouse_id "+
    "UNION ALL "+
    "SELECT b.warehouse_id,SUM(b.quantity) AS units FROM inventory_bulk_stock b "+
    "JOIN master_sap_catalog sap ON sap.sap_code=b.sap_code "+
    "WHERE b.quantity>0 AND sap.is_active=1 GROUP BY b.warehouse_id), "+
    "available AS (SELECT warehouse_id,SUM(units) AS available_units FROM stock GROUP BY warehouse_id) "+
    "SELECT w.id,w.centro,w.almacen,w.description,a.available_units "+
    "FROM master_logistics_locations w JOIN available a ON a.warehouse_id=w.id "+
    "WHERE w.administration='PROPIA' AND w.is_active=1 AND a.available_units>0 "+
    "ORDER BY w.description COLLATE NOCASE LIMIT 2500"
   ).all(),
   db.prepare(
    "SELECT inv.serial,inv.sap_code,inv.warehouse_id,inv.lot,inv.reception_state,inv.physical_state,"+
    "s.description FROM inventory_serials inv JOIN master_sap_catalog s ON s.sap_code=inv.sap_code "+
    "LEFT JOIN dispatch_serial_assignments a ON a.serial=inv.serial COLLATE NOCASE "+
    "WHERE inv.status='DISPONIBLE' AND a.serial IS NULL AND s.is_active=1 "+
    "ORDER BY inv.created_at DESC LIMIT 5000").all(),
   db.prepare(
    "SELECT b.warehouse_id,b.sap_code,b.quantity,s.description FROM inventory_bulk_stock b "+
    "JOIN master_sap_catalog s ON s.sap_code=b.sap_code WHERE b.quantity>0 AND s.is_active=1 "+
    "ORDER BY s.description LIMIT 5000").all()
  ]);
  return json({ok:true,technicians:people.results||[],warehouses:warehouses.results||[],
    serials:serials.results||[],bulk:bulk.results||[]});
 }
 // Vistas independientes de consulta, sin efectuar movimientos de inventario.
 if(path==='/api/despachos/consultas'){
  if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
  const [technicians,equipment]=await Promise.all([
   db.prepare(
    "SELECT m.technician_id,p.full_name AS technician_name,p.document_number AS technician_document,"+
    "COUNT(DISTINCT m.dispatch_id) AS dispatch_count,"+
    "COALESCE(SUM(m.quantity-COALESCE((SELECT SUM(c.quantity) FROM consumption_items c WHERE c.dispatch_item_id=m.dispatch_item_id),0)),0) AS assigned_units,"+
    "MAX(d.dispatch_date) AS last_dispatch "+
    "FROM dispatch_movements m JOIN dispatch_documents d ON d.id=m.dispatch_id "+
    "JOIN master_personnel p ON p.id=m.technician_id "+
    "WHERE d.status='DESPACHADO' "+
    "AND m.quantity>COALESCE((SELECT SUM(c.quantity) FROM consumption_items c WHERE c.dispatch_item_id=m.dispatch_item_id),0) "+
    "AND (trim(m.serial)='' OR EXISTS("+
    "SELECT 1 FROM dispatch_serial_assignments a WHERE a.dispatch_item_id=m.dispatch_item_id)) "+
    "GROUP BY m.technician_id,p.full_name,p.document_number "+
    "ORDER BY assigned_units DESC,p.full_name COLLATE NOCASE LIMIT 2500"
   ).all(),
   db.prepare(
    "SELECT m.dispatch_id,d.reference,d.dispatch_date,m.technician_id,"+
    "p.full_name AS technician_name,p.document_number AS technician_document,"+
    "m.sap_code,s.description AS sap_description,m.serial,"+
    "(m.quantity-COALESCE((SELECT SUM(c.quantity) FROM consumption_items c WHERE c.dispatch_item_id=m.dispatch_item_id),0)) AS quantity,"+
    "w.description AS warehouse_name "+
    "FROM dispatch_movements m JOIN dispatch_documents d ON d.id=m.dispatch_id "+
    "JOIN master_personnel p ON p.id=m.technician_id "+
    "LEFT JOIN master_sap_catalog s ON s.sap_code=m.sap_code "+
    "LEFT JOIN master_logistics_locations w ON w.id=m.warehouse_id "+
    "WHERE d.status='DESPACHADO' "+
    "AND m.quantity>COALESCE((SELECT SUM(c.quantity) FROM consumption_items c WHERE c.dispatch_item_id=m.dispatch_item_id),0) "+
    "AND (trim(m.serial)='' OR EXISTS("+
    "SELECT 1 FROM dispatch_serial_assignments a WHERE a.dispatch_item_id=m.dispatch_item_id)) "+
    "ORDER BY d.dispatch_date DESC,m.created_at DESC,m.id DESC LIMIT 2500"
   ).all()
  ]);
  return json({ok:true,technicians:technicians.results||[],equipment:equipment.results||[]});
 }
 if(path==='/api/despachos'){
  if(method==='GET'){
   const [r,stocks,bulk,assign,technicians,assignedTotal]=await Promise.all([
    db.prepare(
     "SELECT d.id,d.reference,d.status,d.dispatch_date,d.created_at,d.notes,d.technician_id,"+
     "p.full_name AS technician_name,p.document_number AS technician_document,"+
     "w.description AS warehouse_name,"+
     "(SELECT count(*) FROM dispatch_items i WHERE i.dispatch_id=d.id) AS item_count,"+
     "(SELECT coalesce(sum(i.quantity),0) FROM dispatch_items i WHERE i.dispatch_id=d.id) AS total_units "+
     "FROM dispatch_documents d LEFT JOIN master_personnel p ON p.id=d.technician_id "+
     "LEFT JOIN master_logistics_locations w ON w.id=d.warehouse_id "+
     "ORDER BY d.created_at DESC,d.id DESC LIMIT 500"
    ).all(),
    db.prepare("SELECT count(*) AS n FROM inventory_serials s LEFT JOIN dispatch_serial_assignments a ON a.serial=s.serial COLLATE NOCASE WHERE s.status='DISPONIBLE' AND a.serial IS NULL").first(),
    db.prepare("SELECT coalesce(sum(quantity),0) AS n FROM inventory_bulk_stock").first(),
    db.prepare("SELECT count(*) AS n FROM dispatch_serial_assignments a WHERE NOT EXISTS (SELECT 1 FROM consumption_items c WHERE c.internal_serial=a.serial COLLATE NOCASE)").first(),
    db.prepare("SELECT count(DISTINCT m.technician_id) AS n FROM dispatch_movements m WHERE m.quantity>COALESCE((SELECT SUM(c.quantity) FROM consumption_items c WHERE c.dispatch_item_id=m.dispatch_item_id),0)").first(),
    db.prepare("SELECT COALESCE(SUM(m.quantity-COALESCE((SELECT SUM(c.quantity) FROM consumption_items c WHERE c.dispatch_item_id=m.dispatch_item_id),0)),0) AS n FROM dispatch_movements m").first()
   ]);
   return json({ok:true,items:r.results||[],metrics:{
    available:Number(stocks?.n||0)+Number(bulk?.n||0),
    assigned:Number(assign?.n||0),
    assigned_total:Number(assignedTotal?.n||0),
    technicians:Number(technicians?.n||0),
    drafts:(r.results||[]).filter(i=>i.status==='BORRADOR').length
   }});
  }
  if(method==='POST'){
   if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
   const id=crypto.randomUUID();
   await db.batch([
    db.prepare('INSERT INTO dispatch_documents(id,created_by,updated_by) VALUES (?,?,?)').bind(id,user.id,user.id),
    db.prepare("INSERT INTO dispatch_audit(id,dispatch_id,actor_id,action) VALUES (?,?,?,'CREAR_BORRADOR')").bind(crypto.randomUUID(),id,user.id)
   ]);
   return json({ok:true,id,status:'BORRADOR'},201);
  }
  return ingBad('METODO_NO_PERMITIDO',405);
 }
 const match=/^\/api\/despachos\/([0-9a-f-]{36})(?:\/(validar|confirmar))?$/i.exec(path);
 if(!match)return ingBad('RUTA_NO_DISPONIBLE',404);
 const id=match[1],action=match[2]||'';
 const item=await dispatchGet(db,id);
 if(!item)return ingBad('DESPACHO_NO_ENCONTRADO',404);
 const doc=item.document;
 if(action==='validar'){
  if(method!=='GET')return ingBad('METODO_NO_PERMITIDO',405);
  if(doc.status!=='BORRADOR')return ingBad('DESPACHO_INMUTABLE',409);
  return json({ok:true,validation:await dispatchValidate(db,doc,item.items)});
 }
 if(action==='confirmar'){
  if(method!=='POST')return ingBad('METODO_NO_PERMITIDO',405);
  if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
  if(doc.status!=='BORRADOR')return ingBad('DESPACHO_INMUTABLE',409);
  const validation=await dispatchValidate(db,doc,item.items);
  if(!validation.valid)return ingBad('VALIDACION_BLOQUEANTE',422,{validation});
  const ref='DES-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+id.slice(0,8).toUpperCase();
  try{
   const response=await db.batch([
    db.prepare(
     "UPDATE dispatch_documents SET status='DESPACHADO',reference=?,confirmed_by=?,confirmed_at=CURRENT_TIMESTAMP,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='BORRADOR'"
    ).bind(ref,user.id,user.id,id),
    db.prepare("INSERT INTO dispatch_audit(id,dispatch_id,actor_id,action,details) VALUES (?,?,?,'DESPACHAR',?)")
     .bind(crypto.randomUUID(),id,user.id,JSON.stringify(validation.totals))
   ]);
   if((response[0]?.meta?.changes??response[0]?.changes)!==1)return ingBad('DESPACHO_INMUTABLE',409);
  }catch{return ingBad('EXISTENCIAS_CAMBIARON',409);}
  return json({ok:true,id,reference:ref,status:'DESPACHADO',totals:validation.totals});
 }
 if(action)return ingBad('RUTA_NO_DISPONIBLE',404);
 if(method==='GET')return json({ok:true,...item,
   validation:doc.status==='BORRADOR'?await dispatchValidate(db,doc,item.items):null});
 if(method==='DELETE'){
  if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
  if(doc.status!=='BORRADOR')return ingBad('DESPACHO_INMUTABLE',409);
  try{
   const res=await db.batch([
    db.prepare('DELETE FROM dispatch_items WHERE dispatch_id=?').bind(id),
    db.prepare('DELETE FROM dispatch_audit WHERE dispatch_id=?').bind(id),
    db.prepare("DELETE FROM dispatch_documents WHERE id=? AND status='BORRADOR'").bind(id)
   ]);
   if((res[2]?.meta?.changes??res[2]?.changes)!==1)return ingBad('DESPACHO_INMUTABLE',409);
  }catch{return ingBad('DESPACHO_INMUTABLE',409);}
  return json({ok:true,deleted:true});
 }
 if(method!=='PATCH')return ingBad('METODO_NO_PERMITIDO',405);
 if(doc.status!=='BORRADOR')return ingBad('DESPACHO_INMUTABLE',409);
 const parsed=await ingBody(request);
 if(parsed.error)return ingBad(parsed.error,parsed.status);
 const normalized=dispatchNormalize(parsed.data);
 if(!normalized)return ingBad('DATOS_INVALIDOS',400);
 const rows=JSON.stringify(normalized.items);
 try{
  await db.batch([
   db.prepare(
    'UPDATE dispatch_documents SET technician_id=?,warehouse_id=?,dispatch_date=?,notes=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?'
   ).bind(normalized.technician_id,normalized.warehouse_id,normalized.dispatch_date,normalized.notes,user.id,id,'BORRADOR'),
   db.prepare('DELETE FROM dispatch_items WHERE dispatch_id=?').bind(id),
   db.prepare(
    "INSERT INTO dispatch_items(id,dispatch_id,position,sap_code,serial,quantity,notes) "+
    "SELECT json_extract(value,'$.id'),?,json_extract(value,'$.position'),json_extract(value,'$.sap_code'),"+
    "json_extract(value,'$.serial'),json_extract(value,'$.quantity'),json_extract(value,'$.notes') FROM json_each(?)"
   ).bind(id,rows),
   db.prepare("INSERT INTO dispatch_audit(id,dispatch_id,actor_id,action) VALUES (?,?,?,'GUARDAR_BORRADOR')").bind(crypto.randomUUID(),id,user.id)
  ]);
 }catch{return ingBad('NO_SE_PUDO_GUARDAR',409);}
 const updated=await dispatchGet(db,id);
 return json({ok:true,id,status:'BORRADOR',validation:await dispatchValidate(db,updated.document,updated.items)});
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname.startsWith('/api/consumos') || pathname === '/consumos' || pathname === '/consumos.html' || pathname.startsWith('/api/saldos-iniciales') || pathname === '/saldos-iniciales' || pathname === '/saldos-iniciales.html' || pathname.startsWith('/api/despachos') || pathname === '/despachos' || pathname === '/despachos.html' || pathname.startsWith('/api/ingresos') || pathname === '/ingresos' || pathname === '/ingresos.html' || pathname.startsWith('/api/auth/') || pathname.startsWith('/api/usuarios') || pathname.startsWith('/api/maestras/') || pathname === '/maestras' || pathname === '/maestras.html' || pathname === '/activar' || pathname === '/activar.html' || pathname === '/inicio' || pathname === '/inicio.html' || pathname === '/main' || pathname === '/main.html') {
        if (!env.DB) return json({ok: false, error: 'SERVICIO_NO_CONFIGURADO'}, 503);
        if (pathname === '/api/auth/health' && request.method === 'GET') {
          await env.DB.prepare('SELECT id FROM app_users LIMIT 1').first();
          return json({ok: true, service: 'pulso-auth', ready: true});
        }
        if(pathname.startsWith('/api/saldos-iniciales'))
          return await openingHandler(request,env,await currentUser(request,env),pathname);
        if(pathname==='/saldos-iniciales'||pathname==='/saldos-iniciales.html'){
          if(request.method!=='GET'&&request.method!=='HEAD')return ingBad('METODO_NO_PERMITIDO',405);
          const person=await currentUser(request,env);
          if(!person)return go('/main');
          if(person.role!=='ADMIN')return go('/inicio');
          return securePage(await env.ASSETS.fetch(request));
        }
        if(pathname.startsWith('/api/consumos'))
          return await consumptionHandler(request,env,await currentUser(request,env),pathname);
        if(pathname==='/consumos'||pathname==='/consumos.html'){
          if(request.method!=='GET'&&request.method!=='HEAD')return ingBad('METODO_NO_PERMITIDO',405);
          const person=await currentUser(request,env);
          if(!person)return go('/main');
          if(person.role!=='ADMIN')return go('/inicio');
          return securePage(await env.ASSETS.fetch(request));
        }
        if(pathname.startsWith('/api/despachos'))
          return await dispatchHandler(request,env,await currentUser(request,env),pathname);
        if(pathname==='/despachos'||pathname==='/despachos.html'){
          if(request.method!=='GET'&&request.method!=='HEAD')return ingBad('METODO_NO_PERMITIDO',405);
          const person=await currentUser(request,env);
          if(!person)return go('/main');
          if(person.role!=='ADMIN')return go('/inicio');
          return securePage(await env.ASSETS.fetch(request));
        }
        if(pathname.startsWith('/api/ingresos'))
          return await ingresosHandler(request,env,await currentUser(request,env),pathname);
        if(pathname==='/ingresos'||pathname==='/ingresos.html'){
          if(request.method!=='GET'&&request.method!=='HEAD')return ingBad('METODO_NO_PERMITIDO',405);
          const person=await currentUser(request,env);
          if(!person)return go('/main');
          if(person.role!=='ADMIN')return go('/inicio');
          return securePage(await env.ASSETS.fetch(request));
        }
        if (pathname === '/api/auth/activar') return await acceptInvitation(request,env);
        if (pathname==='/api/usuarios/vincular-personal')
          return await linkPersonnelToUsers(request,env,await currentUser(request,env));
        if (pathname==='/api/usuarios'||pathname==='/api/usuarios/invitaciones')
          return await userManagement(request,env,await currentUser(request,env),pathname);
        if (pathname==='/activar'||pathname==='/activar.html') {
          if(request.method!=='GET'&&request.method!=='HEAD')return userError('METODO_NO_PERMITIDO',405);
          const page=securePage(await env.ASSETS.fetch(request));
          page.headers.set('referrer-policy','no-referrer');
          return page;
        }
        if (pathname==='/api/maestras/bodegas/import') return await bulkWarehouses(request,env,await currentUser(request,env));
        if (pathname==='/api/maestras/bodegas') return await warehouseHandler(request,env,await currentUser(request,env));
        if (pathname === '/api/maestras/import') return await bulkImport(request,env,await currentUser(request,env));
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