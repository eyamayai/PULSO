import fs from 'node:fs';
import process from 'node:process';

const [listPath, configPath = 'wrangler.jsonc'] = process.argv.slice(2);
if (!listPath) throw new Error('Indica archivo JSON de wrangler d1 list --json');
const raw = JSON.parse(fs.readFileSync(listPath, 'utf8'));
const items = Array.isArray(raw) ? raw : Array.isArray(raw?.result) ? raw.result : [];
const matches = items.filter(db => db.name === 'pulso-staging-empty');
if (matches.length !== 1) throw new Error('La D1 pulso-staging-empty debe existir exactamente una vez. Deteniendo despliegue.');
const id = matches[0].uuid ?? matches[0].id;
if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  throw new Error('UUID de D1 inválido. Deteniendo despliegue.');
}
const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
if (config.name !== 'pulso-api-staging' || config.d1_databases?.length !== 1 || config.d1_databases[0].database_name !== 'pulso-staging-empty') {
  throw new Error('La configuración de Workers no corresponde a PULSO STAGING.');
}
config.d1_databases[0].database_id = id;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2)+'\n');
console.log('D1 de staging vinculada a Cloudflare (sin importar datos).');
