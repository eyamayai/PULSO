import { MASTER_TYPES, normalizeMaster, validateBatch } from './validation.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}
async function sameSecret(a, b) {
  const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const x = await digest(a), y = await digest(b);
  let xor = 0; for (let i = 0; i < x.length; i++) xor |= x[i] ^ y[i];
  return xor === 0;
}
async function authorized(request, env) {
  if (!env.MASTER_ADMIN_TOKEN || env.MASTER_ADMIN_TOKEN.length < 32) return false;
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  return sameSecret(auth.slice(7), env.MASTER_ADMIN_TOKEN);
}
const defs = {
  bodegas: { table: 'master_warehouses', pk: 'code', cols: ['code', 'name', 'active'] },
  materiales: { table: 'master_materials', pk: 'sap', cols: ['sap', 'description', 'active'] },
  supervisores: { table: 'master_supervisors', pk: 'identifier', cols: ['identifier', 'name', 'active'] },
  tecnicos: { table: 'master_technicians', pk: 'identifier', cols: ['identifier', 'name', 'supervisor_identifier', 'active'] },
  equipos: { table: 'master_equipment', pk: 'serial', cols: ['serial', 'sap', 'active'] }
};
async function bodyJson(request) {
  if (!/application\/json/i.test(request.headers.get('content-type') || ''))
    throw new Error('Se requiere Content-Type: application/json');
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new Error('JSON demasiado grande (máximo 1 MB)');
  return JSON.parse(raw);
}
async function insertMaster(request, env, type) {
  const spec = defs[type];
  const data = await bodyJson(request);
  const rows = data?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 250)
    return json({ ok: false, error: 'Se requieren entre 1 y 250 registros por carga de maestra' }, 422);
  const normalized = [], errors = [], seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = normalizeMaster(type, rows[i]);
    for (const error of r.errors) errors.push({ fila: i + 2, ...error });
    if (!r.value) continue;
    const key = r.value[spec.pk];
    if (key && seen.has(key)) errors.push({ fila: i + 2, field: spec.pk, message: `Duplicado en la maestra: ${key}` });
    seen.add(key);
    normalized.push(r.value);
  }
  // No se permite crear por este endpoint relaciones ausentes en otras maestras.
  for (let i = 0; i < normalized.length; i++) {
    const row = normalized[i];
    const key = row[spec.pk];
    if (key && await env.DB.prepare(`SELECT 1 FROM ${spec.table} WHERE ${spec.pk} = ?`).bind(key).first())
      errors.push({ fila: i + 2, field: spec.pk, message: `${key} ya existe; edita la maestra explícitamente, no por Excel operativo` });
    if (type === 'equipos' && row.sap && !(await env.DB.prepare('SELECT 1 FROM master_materials WHERE sap = ? AND active = 1').bind(row.sap).first()))
      errors.push({ fila: i + 2, field: 'sap', message: `Primero registra el SAP ${row.sap} en Materiales` });
    if (type === 'tecnicos' && row.supervisor_identifier && !(await env.DB.prepare('SELECT 1 FROM master_supervisors WHERE identifier = ? AND active = 1').bind(row.supervisor_identifier).first()))
      errors.push({ fila: i + 2, field: 'supervisor', message: 'El supervisor aún no existe en su maestra' });
  }
  if (errors.length) return json({ ok: false, error: 'MAESTRA_RECHAZADA', errors }, 409);
  const qs = spec.cols.map(() => '?').join(',');
  const sql = `INSERT INTO ${spec.table} (${spec.cols.join(',')}) VALUES (${qs})`;
  // D1.batch ejecuta el lote de forma transaccional; si falla una fila se revierte el lote.
  await env.DB.batch(normalized.map(r => env.DB.prepare(sql).bind(...spec.cols.map(c => r[c] ?? null))));
  return json({ ok: true, maestra: type, creados: normalized.length }, 201);
}
async function masterCounts(env) {
  const out = {};
  for (const [type, spec] of Object.entries(defs)) {
    const res = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${spec.table}`).first();
    out[type] = Number(res?.total || 0);
  }
  return json({ ok: true, maestras: out, cargas_operativas_habilitadas: false });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET')
      return json({ app: 'PULSO', stage: 'cloudflare-fase-1', status: 'estructura-sin-datos', operational_imports_enabled: false });
    if (!url.pathname.startsWith('/api/')) return json({ error: 'Ruta no encontrada' }, 404);
    // Bloqueo predeterminado: sin secreto de administrador no puede consultar ni escribir maestras.
    if (!env.MASTER_ADMIN_TOKEN || env.MASTER_ADMIN_TOKEN.length < 32)
      return json({ error: 'CONFIGURACION_SEGURA_PENDIENTE', message: 'No hay credencial administrativa configurada' }, 503);
    if (!await authorized(request, env)) return json({ error: 'NO_AUTORIZADO' }, 401);
    if (!env.DB) return json({ error: 'D1_NO_CONFIGURADA' }, 503);
    try {
      if (url.pathname === '/api/maestras/estado' && request.method === 'GET') return await masterCounts(env);
      const match = /^\/api\/maestras\/(bodegas|materiales|supervisores|tecnicos|equipos)$/.exec(url.pathname);
      if (match && request.method === 'POST' && MASTER_TYPES.includes(match[1])) return await insertMaster(request, env, match[1]);
      if (url.pathname === '/api/importaciones/validar' && request.method === 'POST') {
        const body = await bodyJson(request);
        const result = await validateBatch(env.DB, body?.tipo, body?.rows);
        return json(result, result.ok ? 200 : 409);
      }
      if (url.pathname === '/api/importaciones/confirmar' && request.method === 'POST') {
        return json({ ok: false, error: 'OPERACIONES_AUN_NO_HABILITADAS', message: 'La primera fase solo valida. No se guardan operaciones ni se crean entidades a partir del Excel.' }, 423);
      }
      return json({ error: 'Ruta no encontrada o método no permitido' }, 404);
    } catch (e) {
      if (e instanceof SyntaxError) return json({ error: 'JSON_INVALIDO' }, 400);
      if (/Content-Type|JSON demasiado/.test(e.message)) return json({ error: 'ENTRADA_INVALIDA', message: e.message }, 400);
      // Nunca exponer errores de SQL o rutas internas al navegador.
      console.error('PULSO API error', e);
      return json({ error: 'ERROR_INTERNO' }, 500);
    }
  }
};