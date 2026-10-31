import pg from 'pg';
import {OAuth2Client,GoogleAuth} from 'google-auth-library';
import {readConfig} from './config.js';
import {createContext} from './context.js';
import {createReadingService} from './service.js';
import {createApp} from './app.js';
import {createDocsAdapter,createDocsWorker} from './docs.js';
import {createOwnerVerifier,createOwnerResolver,readOwnerSource} from './owner.js';
import {createCtaRegistrar} from './cta-registration.js';
import {createSharedHomeworkResolver} from './shared-homework.js';

// Nhận cấu hình riêng, kết nối kho riêng, mở API và hàng Docs. Không chạy migration lúc khởi động.
const c=readConfig();
const pool=new pg.Pool({connectionString:c.READING_DATABASE_URL,max:8,connectionTimeoutMillis:5000,statement_timeout:5000});
const role=(await pool.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
if(role.db!=='reading_practice_db'||role.role!=='reading_practice_app'||role.rolsuper)throw new Error('Reading requires its own non-superuser database role');
await pool.query('SELECT 1 FROM reading_practice.content LIMIT 1');
const context=createContext({url:c.READING_CONTEXT_URL,key:c.READING_CONTEXT_KEY});
await context.snapshot();
let auth;
if(c.GOOGLE_APPLICATION_CREDENTIALS)auth=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/documents','https://www.googleapis.com/auth/classroom.coursework.students.readonly']}).getClient();
else{auth=new OAuth2Client(c.READING_DOCS_CLIENT_ID,c.READING_DOCS_CLIENT_SECRET);auth.setCredentials({refresh_token:c.READING_DOCS_REFRESH_TOKEN});}
const docs=createDocsAdapter(auth);
const verifyBinding=createOwnerVerifier({url:c.READING_OWNER_SOURCE_URL,key:c.READING_OWNER_SOURCE_KEY,auth,docs});
const service=createReadingService({pool,context,pageBase:c.READING_PAGE_BASE,resolveCurrentOwner:input=>readOwnerSource({url:c.READING_OWNER_SOURCE_URL,key:c.READING_OWNER_SOURCE_KEY},input),verifyBinding});
const registerCta=createCtaRegistrar({pool,service,context,docs,entryKey:c.READING_ADMIN_KEY,resolveOwner:createOwnerResolver({url:c.READING_OWNER_SOURCE_URL,key:c.READING_OWNER_SOURCE_KEY}),contentVersion:'legacy-unused'});
const verifier=new OAuth2Client(c.READING_GOOGLE_CLIENT_ID);
const app=createApp({pool,service,registerCta,origins:c.origins,googleClientId:c.READING_GOOGLE_CLIENT_ID,adminKey:c.READING_ADMIN_KEY,
 verifyGoogle:async credential=>(await verifier.verifyIdToken({idToken:credential,audience:c.READING_GOOGLE_CLIENT_ID})).getPayload()});
const resolveSharedHomework=createSharedHomeworkResolver({url:c.READING_OWNER_SOURCE_URL,key:c.READING_OWNER_SOURCE_KEY,auth,docs});
const worker=createDocsWorker({pool,docs,resolveSharedHomework});
let stopping=false;
const workerLoop=async()=>{while(!stopping){try{await worker.once();}catch(error){console.error(JSON.stringify({event:'reading_docs_worker_error',type:error.name}));}await new Promise(resolve=>setTimeout(resolve,1000));}};
const workerDone=workerLoop();
const server=app.listen(c.READING_PORT,'0.0.0.0',()=>console.log(JSON.stringify({event:'reading_started',port:c.READING_PORT})));
async function stop(){if(stopping)return;stopping=true;await new Promise(resolve=>server.close(resolve));await workerDone;await pool.end();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
