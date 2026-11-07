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
const ING_DOCUMENT_TYPES = new Set(['ORDEN_COMPRA','FACTURA','REMISION','ACTA_ENTREGA','OTRO']);
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
       !fieldsOf(record,['sap_code','serial','quantity','notes']))return null;
    const sap_code=trimmed(record.sap_code,50).toUpperCase();
    const serial=trimmed(record.serial,100).toUpperCase();
    const notes=trimmed(record.notes,240);
    const quantity=Number(record.quantity);
    if(sap_code.length>50||serial.length>100||notes.length>240||
       !Number.isInteger(quantity)||quantity>1000000||quantity< -1000000)return null;
    output.push({id:crypto.randomUUID(),position:output.length+1,sap_code,serial,quantity,notes});
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
    "SELECT i.id,i.position,i.sap_code,i.serial,i.quantity,i.notes,"+
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
  if(!ING_DOCUMENT_TYPES.has(documentType))add('DOCUMENTO_TIPO','Selecciona el tipo de documento.',1);
  if(!String(document.document_number||'').trim())add('DOCUMENTO_NUMERO','Ingresa el número de documento.',1);
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
    const validation=await ingValidate(db,doc,item.items);
    return json({ok:true,...item,validation});
  }
  if(method==='DELETE'){
    if(!sameOrigin(request))return ingBad('ORIGEN_NO_AUTORIZADO',403);
    if(doc.status!=='BORRADOR')return ingBad('INGRESO_INMUTABLE',409);
    await db.batch([
      db.prepare('DELETE FROM ingress_support_chunks WHERE ingress_id=?').bind(id),
      db.prepare('DELETE FROM ingress_items WHERE ingress_id=?').bind(id),
      db.prepare('DELETE FROM ingress_audit WHERE ingress_id=?').bind(id),
      db.prepare("DELETE FROM ingress_documents WHERE id=? AND status='BORRADOR'").bind(id)
    ]);
    return json({ok:true});
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
    "INSERT INTO ingress_items(id,ingress_id,position,sap_code,serial,quantity,notes) "+
    "SELECT json_extract(value,'$.id'),?,json_extract(value,'$.position'),"+
    "json_extract(value,'$.sap_code'),json_extract(value,'$.serial'),"+
    "json_extract(value,'$.quantity'),json_extract(value,'$.notes') "+
    "FROM json_each(?)"
  ).bind(id,itemRows);
  try{
    await db.batch([update,deleteItems,insertItems,
      await ingAudit(db,id,user.id,'GUARDAR_BORRADOR',{items:items.length})]);
  }catch{return ingBad('NO_SE_PUDO_GUARDAR',409);}
  item=await ingGet(db,id);
  return json({ok:true,id,status:'BORRADOR',validation:await ingValidate(db,item.document,item.items)});
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname.startsWith('/api/ingresos') || pathname === '/ingresos' || pathname === '/ingresos.html' || pathname.startsWith('/api/auth/') || pathname.startsWith('/api/usuarios') || pathname.startsWith('/api/maestras/') || pathname === '/maestras' || pathname === '/maestras.html' || pathname === '/activar' || pathname === '/activar.html' || pathname === '/inicio' || pathname === '/inicio.html' || pathname === '/main' || pathname === '/main.html') {
        if (!env.DB) return json({ok: false, error: 'SERVICIO_NO_CONFIGURADO'}, 503);
        if (pathname === '/api/auth/health' && request.method === 'GET') {
          await env.DB.prepare('SELECT id FROM app_users LIMIT 1').first();
          return json({ok: true, service: 'pulso-auth', ready: true});
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