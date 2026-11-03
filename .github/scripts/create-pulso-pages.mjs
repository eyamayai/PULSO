import fs from 'node:fs';

const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const token = process.env.CLOUDFLARE_API_TOKEN || '';
if (!/^[a-f0-9]{32}$/i.test(account) || !token) {
  throw new Error('Faltan credenciales válidas en los secretos GitHub de Cloudflare.');
}
const base = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/pages/projects';
async function req(method, path = '', body) {
  const options = { method, headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'} };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(base + path, options);
  let data;
  try { data = await response.json(); } catch { data = {}; }
  return {status: response.status, data};
}
const msg = x => (x?.errors || []).map(e => (e.code || '') + ' ' + (e.message || 'Error de Cloudflare')).join(' | ').slice(0,900);
const output = s => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n');

let result = await req('GET', '/pulso');
if (result.status === 403 || result.status === 401) {
  throw new Error('Token sin permiso suficiente. Agrega Account > Cloudflare Pages > Edit (Pages Write) en Cloudflare y actualiza CLOUDFLARE_API_TOKEN en GitHub.');
}
if (result.status === 404) {
  const body = {
    name: 'pulso',
    production_branch: 'main',
    build_config: {root_dir: '/', build_command: 'exit 0', destination_dir: 'pages'},
    source: {
      type: 'github',
      config: {
        owner: 'eyamayai', owner_id: '109771811',
        repo_id: '1396598974', repo_name: 'PULSO',
        production_branch: 'main',
        production_deployments_enabled: true,
        preview_deployment_setting: 'none'
      }
    }
  };
  result = await req('POST', '', body);
  if (!(result.status >= 200 && result.status < 300 && result.data.success)) {
    console.error('No se pudo crear Pages:', msg(result.data) || 'HTTP ' + result.status);
    throw new Error('No fue posible registrar el proyecto pulso.pages.dev. No se creó un subdominio alternativo.');
  }
  console.log('Proyecto Pages creado con integración GitHub.');
} else if (!result.data.success || result.status !== 200) {
  throw new Error('No fue posible consultar Pages: ' + (msg(result.data) || 'HTTP ' + result.status));
} else {
  console.log('El proyecto Pages pulso ya existe en esta cuenta; verificando que sea el correcto.');
}
const project = result.data.result;
const source = project?.source;
if (source?.type !== 'github' || source?.config?.owner?.toLowerCase() !== 'eyamayai' || source?.config?.repo_name?.toLowerCase() !== 'pulso') {
  throw new Error('El proyecto pulso no está conectado al GitHub eyamayai/PULSO. No se modificó.');
}
const url = 'https://pulso.pages.dev/main';
output('## Proyecto Pages: PULSO');
output('- Repositorio: eyamayai/PULSO');
output('- Rama: main');
output('- Directorio: pages');
output('- URL deseada: ' + url);
console.log('Pages configurado para GitHub. URL deseada:', url);
if (!project.canonical_deployment) {
  const fd = new FormData();
  fd.set('branch','main');
  const res = await fetch(base + '/pulso/deployments', {method:'POST', headers:{'Authorization':'Bearer ' + token}, body:fd});
  const data = await res.json().catch(()=>({}));
  if (res.ok && data.success) {
    console.log('Despliegue de la rama main solicitado a Cloudflare.');
    output('- Despliegue: solicitado a Cloudflare.');
  } else {
    console.log('El proyecto existe, pero debe iniciarse la primera publicación:', msg(data) || 'HTTP ' + res.status);
    output('- Primera publicación pendiente de confirmación en Cloudflare.');
  }
} else {
  console.log('El proyecto ya tiene una publicación.');
}
