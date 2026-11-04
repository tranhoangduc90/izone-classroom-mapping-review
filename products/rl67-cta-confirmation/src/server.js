import {existsSync,readFileSync} from 'node:fs';
import pg from 'pg';
import {OAuth2Client} from 'google-auth-library';
import {z} from 'zod';
import {createApp} from './app.js';
import {createNativeBinder} from './bind.js';
import {createMailSender, deliverNotice} from './mail.js';
import {createConfirmation,products} from './service.js';

const key=z.string().min(32);
const target=z.object({url:z.url(),key}).strict();
const productKeys=Object.keys(products);
const shape=z.object({
  databaseUrl:z.url(),signingKey:key,
  publisherKeys:z.object(Object.fromEntries(productKeys.map(product=>[product,key]))).strict(),
  targets:z.object(Object.fromEntries(productKeys.map(product=>[product,target]))).strict(),
  mail:z.object({from:z.email(),to:z.email(),clientId:z.string().min(1),clientSecret:z.string().min(1),
    refreshToken:z.string().min(1)}).strict(),
}).strict();
const config=shape.parse(JSON.parse(readFileSync(process.env.RL67_CTA_CONFIRMATION_CONFIG,'utf8')));
for(const value of Object.values(config.targets)) {
  const url=new URL(value.url);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)
    throw new Error('NATIVE_TARGET_INVALID');
}
const pool=new pg.Pool({connectionString:config.databaseUrl,max:5,connectionTimeoutMillis:3500,
  statement_timeout:4500,application_name:'rl67_cta_confirmation_api'});
const {rows:[runtime]}=await pool.query(`SELECT current_database() AS db,current_user AS role,
  pg_has_role(current_user,'rl67_cta_confirmation_api','USAGE') AS scoped,rolsuper
  FROM pg_roles WHERE rolname=current_user`);
if(runtime.db!=='mapping_db'||!runtime.scoped||runtime.rolsuper) throw new Error('INVALID_RUNTIME_ROLE');
const service=createConfirmation({pool,signingKey:config.signingKey,finishBinding:createNativeBinder(config.targets)});
const oauth=new OAuth2Client({clientId:config.mail.clientId,clientSecret:config.mail.clientSecret,
  credentials:{refresh_token:config.mail.refreshToken},transporterOptions:{timeout:8000,retry:false}});
const send=createMailSender({...config.mail,async accessToken(){
  const {token}=await oauth.getAccessToken();
  if(!token) throw new Error('MAIL_AUTH_UNAVAILABLE');
  return token;
}});
let timer;
let stopping=false;
let pending=Promise.resolve();
function schedule() {
  if(stopping) return;
  timer=setTimeout(()=>{
    pending=deliverNotice(pool,send).catch(()=>console.error(JSON.stringify({event:'rl67_notice_delivery_error'})))
      .finally(schedule);
  },4000).unref();
}
schedule();
const app=createApp({service,pool,publisherKeys:config.publisherKeys,
  enabled:()=>existsSync('/run/rl67/enable')});
const server=app.listen(Number(process.env.PORT||4341),'0.0.0.0');
async function shutdown() {
  if(stopping) return;
  stopping=true;
  clearTimeout(timer);
  await new Promise(resolve=>server.close(resolve));
  await pending;
  await pool.end();
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
