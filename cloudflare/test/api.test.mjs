import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('salud es pública pero nunca habilita importaciones', async () => {
  const r = await worker.fetch(new Request('https://pulso.example/api/health'), {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).operational_imports_enabled, false);
});
test('sin secreto administrativo no expone consultas ni acepta modificaciones', async () => {
  const r = await worker.fetch(new Request('https://pulso.example/api/importaciones/validar', {method:'POST'}), {});
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'CONFIGURACION_SEGURA_PENDIENTE');
});
test('con secreto y sin autorización no permite consultas ni importaciones', async () => {
  const r = await worker.fetch(new Request('https://pulso.example/api/maestras/estado'), {MASTER_ADMIN_TOKEN: 'x'.repeat(40),DB:{}});
  assert.equal(r.status, 401);
});
test('confirmar importación queda siempre bloqueado aun con autorización administrativa', async () => {
  const secret = 'x'.repeat(40);
  const r = await worker.fetch(new Request('https://pulso.example/api/importaciones/confirmar', { method:'POST', headers:{Authorization:'Bearer '+secret}}), {MASTER_ADMIN_TOKEN:secret,DB:{}});
  assert.equal(r.status, 423);
  assert.equal((await r.json()).error, 'OPERACIONES_AUN_NO_HABILITADAS');
});