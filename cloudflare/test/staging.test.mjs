import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname,'..');
test('La vista de pruebas no contiene conexiones antiguas ni credenciales',()=>{
 const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 assert.match(html,/DESARROLLO · NO PRODUCCIÓN/);
 assert.doesNotMatch(html,/supabase\.co|service_role|MASTER_ADMIN_TOKEN|\bBearer\b/);
});
test('Las rutas API se envían a Workers y la interfaz queda en assets',()=>{
 const conf=JSON.parse(fs.readFileSync(path.join(root,'wrangler.jsonc'),'utf8'));
 assert.equal(conf.name,'pulso-api-staging');
 assert.equal(conf.assets.directory,'./public');
 assert.deepEqual(conf.assets.run_worker_first,['/api/*']);
});
test('El script de despliegue acepta solo D1 staging existente',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulso-'));
 try {
  const id='11111111-2222-4333-8444-555555555555';
  const list=path.join(dir,'db.json'),config=path.join(dir,'wrangler.jsonc');
  fs.writeFileSync(list,JSON.stringify([{name:'pulso-staging-empty',uuid:id}]));
  fs.copyFileSync(path.join(root,'wrangler.jsonc'),config);
  execFileSync(process.execPath,[path.join(root,'scripts/prepare-db-config.mjs'),list,config]);
  assert.equal(JSON.parse(fs.readFileSync(config,'utf8')).d1_databases[0].database_id,id);
  fs.writeFileSync(list,JSON.stringify([{name:'OTRA',uuid:id}]));
  assert.throws(()=>execFileSync(process.execPath,[path.join(root,'scripts/prepare-db-config.mjs'),list,config],{stdio:'pipe'}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
