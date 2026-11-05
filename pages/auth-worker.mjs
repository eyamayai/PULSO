/** PULSO Pages: same-origin authentication, isolated from inventory movement APIs. */
const COOKIE = '__Host-pulso_session';
const SESSION_SECONDS = 8 * 60 * 60;
const PBKDF2_ITERATIONS = 220_000;
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
  const user = await env.DB.prepare('SELECT id, email, display_name, role, password_hash, password_salt, password_kdf, active FROM app_users WHERE email = ?').bind(email).first();
  let matches = false;
  if (user && user.active === 1 && user.password_kdf === 'pbkdf2-sha512-220000') {
    const derived = await passwordHash(password, user.password_salt);
    matches = Boolean(derived && constantTimeHexEqual(derived, user.password_hash));
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
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname.startsWith('/api/auth/') || pathname === '/inicio' || pathname === '/inicio.html' || pathname === '/main' || pathname === '/main.html') {
        if (!env.DB) return json({ok: false, error: 'SERVICIO_NO_CONFIGURADO'}, 503);
        if (pathname === '/api/auth/health' && request.method === 'GET') {
          await env.DB.prepare('SELECT id FROM app_users LIMIT 1').first();
          return json({ok: true, service: 'pulso-auth', ready: true});
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