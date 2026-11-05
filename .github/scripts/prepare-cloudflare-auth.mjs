/** Configure only existing PULSO staging D1 and the pulso-mintic Pages project. */
import fs from 'node:fs';
const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const d1Token = process.env.CLOUDFLARE_API_TOKEN || '';
const pagesToken = process.env.CLOUDFLARE_PAGES_API_TOKEN || '';
if (!/^[a-f0-9]{32}$/i.test(account) || !d1Token || !pagesToken) {
  throw new Error('Faltan permisos de D1 o Pages. Conservar los tres secretos Cloudflare existentes.');
}
const base=`https://api.cloudflare.com/client/v4/accounts/${account}`;
async function request(path, token, method='GET', body) {
  const res=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, ...(body?{body:JSON.stringify(body)}:{})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok || !data.success){throw new Error(`Cloudflare ${method} ${path} HTTP ${res.status}: ${(data.errors||[]).map(x=>x.message).join('; ').slice(0,300)}`)}
  return data.result;
}
const found=await request('/d1/database?name=pulso-staging-empty&per_page=100',d1Token);
const matches=(Array.isArray(found)?found:[]).filter(d=>d.name==='pulso-staging-empty');
if(matches.length!==1)throw new Error('Debe existir exactamente una D1 pulso-staging-empty. No se creará otra base.');
const id=matches[0].uuid;
if(!/^[a-f0-9-]{36}$/i.test(id||''))throw new Error('Identificador D1 inválido');
const project=await request('/pages/projects/pulso-mintic',pagesToken);
if(project.name!=='pulso-mintic'||project.production_branch!=='main')throw new Error('El proyecto Pages esperado no coincide');
if(project.source?.type && !['direct_upload','github'].includes(project.source.type))throw new Error('Origen de Pages no permitido');
const existing=project.deployment_configs?.production?.d1_databases || {};
if(existing.DB?.id && existing.DB.id!==id)throw new Error('El proyecto Pages ya tiene un DB distinto, publicación detenida');
const binding={...existing,DB:{id}};
await request('/pages/projects/pulso-mintic',pagesToken,'PATCH',{
  deployment_configs:{production:{d1_databases:binding,compatibility_date:'2026-11-05'}}
});
const updated=await request('/pages/projects/pulso-mintic',pagesToken);
if(updated.deployment_configs?.production?.d1_databases?.DB?.id !== id) throw new Error('La verificación del binding D1 falló');
const config={name:'pulso-auth-migrations',compatibility_date:'2026-11-05',d1_databases:[{binding:'DB',database_name:'pulso-staging-empty',database_id:id}]};
const file=process.env.RUNNER_TEMP?process.env.RUNNER_TEMP+'/pulso-auth-wrangler.jsonc':'/tmp/pulso-auth-wrangler.jsonc';
fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,`PULSO_AUTH_WRANGLER=${file}\n`);
console.log('Cloudflare Pages: binding DB validado contra D1 staging existente. No se modificaron maestras.');