/** Generate one-time D1 admin bootstrap, only if explicit GitHub secrets exist. */
import fs from 'node:fs';
import {pbkdf2Sync,randomBytes,randomUUID} from 'node:crypto';
const email=(process.env.PULSO_ADMIN_EMAIL || '').trim().toLowerCase();
const password=process.env.PULSO_ADMIN_PASSWORD || '';
const path=process.env.RUNNER_TEMP?process.env.RUNNER_TEMP+'/pulso-first-admin.sql':'/tmp/pulso-first-admin.sql';
if(!email && !password){console.log('No se ha configurado el primer administrador. El acceso permanecerá sin cuentas.');process.exit(0)}
if(!email || !password)throw new Error('Deben existir ambos secretos: PULSO_ADMIN_EMAIL y PULSO_ADMIN_PASSWORD');
if(!/^[a-z0-9._+%-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)||email.length>254)throw new Error('El correo del administrador no tiene un formato admitido');
if(password.length<14||password.length>128||!/[A-Z]/.test(password)||!/[a-z]/.test(password)||!/[0-9]/.test(password)||!/[^a-zA-Z0-9]/.test(password))
  throw new Error('La contraseña inicial debe tener 14-128 caracteres con mayúscula, minúscula, número y símbolo.');
const salt=randomBytes(16);
const derived=pbkdf2Sync(password,salt,220000,32,'sha512');
const name='Administrador PULSO';
const q=x=>"'"+x.replaceAll("'","''")+"'";
const sql=`INSERT INTO app_users (id,email,display_name,password_hash,password_salt,password_kdf,role,active)
 SELECT ${q(randomUUID())},${q(email)},${q(name)},${q(derived.toString('hex'))},${q(salt.toString('hex'))},'pbkdf2-sha512-220000','ADMIN',1
 WHERE NOT EXISTS (SELECT 1 FROM app_users);\n`;
fs.writeFileSync(path,sql,{mode:0o600});
if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,`PULSO_FIRST_ADMIN_SQL=${path}\n`);
console.log('Alta del primer administrador preparada con hash PBKDF2 y solo si no existe ningún usuario.');