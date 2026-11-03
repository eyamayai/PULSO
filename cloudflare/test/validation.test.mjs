import { test } from 'node:test';
import assert from 'node:assert/strict';
import { code, normalizeMaster, normalizeOperation, validateBatch } from '../src/validation.js';

function dbMock({ materials = {}, equipment = {}, warehouses = {}, technicians = {} } = {}) {
  return { prepare(sql) {
    return { bind(key) { return { async first() {
      if (sql.includes('master_materials')) return materials[key] ? { sap: key } : null;
      if (sql.includes('master_equipment')) return equipment[key] ? { sap: equipment[key] } : null;
      if (sql.includes('master_warehouses')) return warehouses[key] ? { code: key } : null;
      if (sql.includes('master_technicians')) return technicians[key] ? { identifier: key } : null;
      return null;
    } }; } };
  } };
}
const row = { sap:'4065878S', serial:'000019', bodega:'A221', tecnico:'0123', ot:'OT-1', sitio:'S-1' };
test('preserva sufijos SAP y ceros iniciales sin normalización destructiva', () => {
  assert.equal(code('4065878S'), '4065878S');
  assert.equal(code('000019'), '000019');
  assert.equal(code(19), '');
});
test('bodegas y materiales no pueden tener identificadores vacíos', () => {
  assert.equal(normalizeMaster('bodegas', {codigo:'', nombre:'Riohacha'}).errors.length,1);
  assert.equal(normalizeMaster('materiales', {sap:4065878, descripcion:'Equipo'}).errors.length,1);
});
test('sin maestras cargadas se bloquea completamente la importación', async () => {
  const result = await validateBatch(dbMock(), 'DESPACHO', [row]);
  assert.equal(result.ok, false);
  assert.equal(result.message, 'CARGUE_BLOQUEADO_POR_MAESTRAS');
  assert.deepEqual(new Set(result.errors.map(e=>e.field)), new Set(['sap','serial','bodega','tecnico']));
});
test('cruce SAP-serial debe coincidir con maestra de equipos', async () => {
  const db = dbMock({materials:{'4065878S':true},equipment:{'000019':'999'},warehouses:{A221:true},technicians:{'0123':true}});
  const result = await validateBatch(db, 'DESPACHO', [row]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === 'serial' && e.message.includes('999')));
});
test('lote íntegro se marca inválido si al menos una línea no coincide', async () => {
  const db = dbMock({materials:{'4065878S':true},equipment:{'000019':'4065878S'},warehouses:{A221:true},technicians:{'0123':true}});
  const result = await validateBatch(db, 'DESPACHO', [row,{...row, serial:'NOEXISTE'}]);
  assert.equal(result.ok, false); assert.equal(result.total, 2);
  assert.equal(result.errors[0].fila, 3);
});
test('sólo se habilita vista previa con maestros completos, nunca carga automática', async () => {
  const db = dbMock({materials:{'4065878S':true},equipment:{'000019':'4065878S'},warehouses:{A221:true},technicians:{'0123':true}});
  const result = await validateBatch(db, 'DESPACHO', [row]);
  assert.equal(result.ok, true);
  assert.equal(result.message, 'MAESTRAS_VALIDAS_SOLO_PREVISUALIZACION');
});
test('un retiro exige OT, sitio y técnico de maestra', () => {
  const { errors } = normalizeOperation({ sap:'A', serial:'X' }, 'RETIRO');
  assert.deepEqual(new Set(errors.map(e=>e.field)), new Set(['tecnico','ot','sitio']));
});