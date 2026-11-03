/** PULSO: validaciones comunes de maestras y plantillas. Sin altas implícitas. */
export const MASTER_TYPES = Object.freeze(['bodegas', 'materiales', 'supervisores', 'tecnicos', 'equipos']);
export const OPERATION_TYPES = Object.freeze([
  'CARGA_INICIAL', 'INGRESO', 'DESPACHO', 'CONSUMO',
  'RETIRO', 'DEVOLUCION', 'PREALERTA', 'RECOLECCION'
]);

export function code(value) {
  // No convertir números de Excel: convertir 00123 -> 123 rompería el identificador.
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}
export function text(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}
function active(value) { return value === false || value === 0 ? 0 : 1; }
function issue(field, message) { return { field, message }; }

export function normalizeMaster(type, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    return { value: null, errors: [issue('fila', 'Debe ser un objeto de maestra')] };
  let value;
  if (type === 'bodegas') value = { code: code(row.codigo), name: text(row.nombre), active: active(row.activo) };
  else if (type === 'materiales') value = { sap: code(row.sap), description: text(row.descripcion), active: active(row.activo) };
  else if (type === 'supervisores') value = { identifier: code(row.identificacion), name: text(row.nombre), active: active(row.activo) };
  else if (type === 'tecnicos') value = { identifier: code(row.identificacion), name: text(row.nombre), supervisor_identifier: row.supervisor === undefined || row.supervisor === '' ? null : code(row.supervisor), active: active(row.activo) };
  else if (type === 'equipos') value = { serial: code(row.serial), sap: code(row.sap), active: active(row.activo) };
  else return { value: null, errors: [issue('maestra', 'Tipo de maestra no permitido')] };
  const errors = [];
  for (const [key, val] of Object.entries(value)) {
    if (key === 'active' || key === 'supervisor_identifier') continue;
    if (!val) errors.push(issue(key, 'Obligatorio; usar texto, no números de Excel'));
  }
  if (type === 'tecnicos' && row.supervisor !== undefined && row.supervisor !== '' && !value.supervisor_identifier)
    errors.push(issue('supervisor', 'El identificador debe ser texto'));
  return { value, errors };
}

const mandatoryWarehouse = new Set(['CARGA_INICIAL', 'INGRESO', 'DESPACHO', 'DEVOLUCION', 'PREALERTA', 'RECOLECCION']);
const mandatoryTechnician = new Set(['DESPACHO', 'CONSUMO', 'RETIRO', 'DEVOLUCION']);

export function normalizeOperation(row, kind) {
  const value = {
    sap: code(row.sap), serial: code(row.serial), bodega: code(row.bodega),
    tecnico: code(row.tecnico), ot: text(row.ot), sitio: code(row.sitio),
    evento_claro: code(row.evento_claro)
  };
  const errors = [];
  if (!value.sap) errors.push(issue('sap', 'Código SAP obligatorio, debe estar en la maestra'));
  if (!value.serial) errors.push(issue('serial', 'Serial obligatorio, debe estar en la maestra de equipos'));
  if (mandatoryWarehouse.has(kind) && !value.bodega) errors.push(issue('bodega', 'Bodega obligatoria, debe estar en la maestra'));
  if (mandatoryTechnician.has(kind) && !value.tecnico) errors.push(issue('tecnico', 'Identificación del técnico obligatoria, debe estar en la maestra'));
  if (['CONSUMO', 'RETIRO'].includes(kind)) {
    if (!value.ot) errors.push(issue('ot', 'OT obligatoria para conciliar con Claro'));
    if (!value.sitio) errors.push(issue('sitio', 'ID de sitio obligatorio para conciliar con Claro'));
  }
  return { value, errors };
}

export async function checkOperationMasters(db, value) {
  const errors = [];
  const find = async (sql, arg) => db.prepare(sql).bind(arg).first();
  if (value.sap && !(await find('SELECT sap FROM master_materials WHERE sap = ? AND active = 1', value.sap)))
    errors.push(issue('sap', `SAP ${value.sap} no existe o está inactivo en la maestra`));
  if (value.serial) {
    const eq = await find('SELECT sap FROM master_equipment WHERE serial = ? AND active = 1', value.serial);
    if (!eq) errors.push(issue('serial', `Equipo ${value.serial} no existe o está inactivo en la maestra`));
    else if (value.sap && eq.sap !== value.sap)
      errors.push(issue('serial', `Serial ${value.serial} pertenece al SAP ${eq.sap}, no al ${value.sap}`));
  }
  if (value.bodega && !(await find('SELECT code FROM master_warehouses WHERE code = ? AND active = 1', value.bodega)))
    errors.push(issue('bodega', `Bodega ${value.bodega} no existe o está inactiva en la maestra`));
  if (value.tecnico && !(await find('SELECT identifier FROM master_technicians WHERE identifier = ? AND active = 1', value.tecnico)))
    errors.push(issue('tecnico', `Técnico ${value.tecnico} no existe o está inactivo en la maestra`));
  return errors;
}

export async function validateBatch(db, kind, rows) {
  if (!OPERATION_TYPES.includes(kind)) return { ok: false, errors: [{ fila: 0, field: 'tipo', message: 'Operación desconocida' }] };
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2000)
    return { ok: false, errors: [{ fila: 0, field: 'rows', message: 'Debe contener entre 1 y 2.000 filas' }] };
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ fila: i + 2, field: 'fila', message: 'Fila inválida' });
      continue;
    }
    const candidate = normalizeOperation(row, kind);
    const found = await checkOperationMasters(db, candidate.value);
    for (const e of [...candidate.errors, ...found]) errors.push({ fila: i + 2, ...e });
  }
  return { ok: errors.length === 0, total: rows.length, errors, message: errors.length ? 'CARGUE_BLOQUEADO_POR_MAESTRAS' : 'MAESTRAS_VALIDAS_SOLO_PREVISUALIZACION' };
}