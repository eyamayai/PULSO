import fs from 'node:fs';

const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const token = process.env.CLOUDFLARE_API_TOKEN || '';
if (!/^[a-f0-9]{32}$/i.test(account) || !token) {
  throw new Error('Faltan secretos CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_PAGES_API_TOKEN.');
}

const target = process.env.PULSO_PAGES_PROJECT || 'pulso';
if (!['pulso', 'pulso-mintic'].includes(target)) throw new Error('Proyecto Pages no autorizado.');
const url = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/pages/projects';
async function req(method, suffix = '', data) {
  const r = await fetch(url + suffix, {
    method,
    headers: {Authorization:'Bearer ' + token, 'Content-Type':'application/json'},
    ...(data ? {body:JSON.stringify(data)} : {})
  });
  const json = await r.json().catch(()=>({}));
  return {status:r.status, json};
}
const problem = result => (result?.errors || []).map(e => String(e.code || '') + ' ' + String(e.message || '')).join(' | ').slice(0,1000);
let response = await req('GET','/' + target);
if (response.status === 401 || response.status === 403) {
  throw new Error('El token requiere Account > Cloudflare Pages > Edit (Pages Write).');
}
let created = false;
if (response.status === 404) {
  // Cloudflare Pages Git integration falla en algunas cuentas nuevas (error 8000011).
  // Direct Upload + GitHub Actions mantiene CI/CD desde el mismo repositorio.
  response = await req('POST','',{name:target,production_branch:'main'});
  if (!response.json.success) throw new Error('Error creando PULSO Pages: ' + (problem(response.json) || 'HTTP '+response.status));
  created = true;
  console.log('Proyecto Cloudflare Pages Direct Upload creado; GitHub Actions será su CI/CD.');
}
if (response.status >= 400 || !response.json.success || !response.json.result) {
  throw new Error('No se pudo inspeccionar el proyecto Pages: ' + (problem(response.json) || 'HTTP '+response.status));
}
const project = response.json.result;
if (project.name !== target || project.production_branch !== 'main') {
  throw new Error('Proyecto o rama de Pages no coincide con pulso / main.');
}
if (project.source?.type === 'github') {
  const source = project.source.config;
  if (!source || source.owner?.toLowerCase() !== 'eyamayai' || source.repo_name?.toLowerCase() !== 'pulso') {
    throw new Error('El proyecto pulso pertenece a otro repositorio. No publicar.');
  }
} else if (project.source && project.source.type !== 'direct_upload') {
  throw new Error('El proyecto pulso tiene un origen distinto al autorizado. No publicar.');
}
const subdomain = project.subdomain?.replace(/^https?:\/\//,'').replace(/\/$/,'');
if (!subdomain || !subdomain.endsWith('.pages.dev') || !subdomain.startsWith(target + (target === 'pulso' ? '-' : '.'))) {
  throw new Error('Subdominio de Pages inesperado; publicación detenida.');
}
if (target === 'pulso-mintic' && subdomain !== 'pulso-mintic.pages.dev') throw new Error('El nombre exacto pulso-mintic.pages.dev está ocupado. Cloudflare asignó ' + subdomain + '; no se publica.');
if (target === 'pulso' && subdomain !== 'pulso.pages.dev') console.log('Subdominio original ocupado; URL provisional:', subdomain);
const publicUrl = 'https://' + subdomain + '/main';
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, 'PULSO_PAGES_DOMAIN=' + subdomain + '\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## PULSO Pages\n- ' + (created ? 'Proyecto nuevo creado' : 'Proyecto existente validado') + '\n- Código: eyamayai/PULSO, rama main\n- Publicación: GitHub Actions + Pages Direct Upload\n- Dirección asignada: ' + publicUrl + '\n');
}
console.log('Proyecto Pages validado. URL asignada:', publicUrl);
