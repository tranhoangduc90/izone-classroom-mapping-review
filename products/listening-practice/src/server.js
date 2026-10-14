import {readFile} from 'node:fs/promises';
import {hash} from './domain.js';
import crypto from 'node:crypto';
import pg from 'pg';
import {OAuth2Client,GoogleAuth} from 'google-auth-library';
import {readConfig} from './config.js';
import {createContext} from './context.js';
import {createListeningService} from './service.js';
import {createApp} from './app.js';
import {createDocsAdapter,createDocsWorker} from './docs.js';
import {createOwnerVerifier} from './owner.js';

// Nhận cấu hình riêng, kết nối kho riêng, mở API và hàng Docs. Không chạy migration lúc khởi động.
const c=readConfig();
const pool=new pg.Pool({connectionString:c.LISTENING_DATABASE_URL,max:8,connectionTimeoutMillis:5000,statement_timeout:5000});
const role=(await pool.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
if(role.db!=='listening_practice_db'||role.role!=='listening_practice_app'||role.rolsuper)throw new Error('Reading requires its own non-superuser database role');
await pool.query('SELECT 1 FROM listening_practice.content LIMIT 1');
const context=createContext({url:c.LISTENING_CONTEXT_URL,key:c.LISTENING_CONTEXT_KEY});
await context.snapshot();
let auth;
if(c.GOOGLE_APPLICATION_CREDENTIALS)auth=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/documents','https://www.googleapis.com/auth/classroom.coursework.students.readonly']}).getClient();
else{auth=new OAuth2Client(c.LISTENING_DOCS_CLIENT_ID,c.LISTENING_DOCS_CLIENT_SECRET);auth.setCredentials({refresh_token:c.LISTENING_DOCS_REFRESH_TOKEN});}
const docs=createDocsAdapter(auth);
const verifyBinding=createOwnerVerifier({url:c.LISTENING_OWNER_SOURCE_URL,key:c.LISTENING_OWNER_SOURCE_KEY,auth,docs});
const service=createListeningService({pool,context,pageBase:c.LISTENING_PAGE_BASE,verifyBinding});
const verifier=new OAuth2Client(c.LISTENING_GOOGLE_CLIENT_ID);
const audioHash=crypto.createHash('sha256').update(await readFile(c.LISTENING_AUDIO_FILE)).digest('hex');
const app=createApp({pool,service,audioFile:c.LISTENING_AUDIO_FILE,audioHash,origins:c.origins,googleClientId:c.LISTENING_GOOGLE_CLIENT_ID,adminKey:c.LISTENING_ADMIN_KEY,
 verifyGoogle:async credential=>(await verifier.verifyIdToken({idToken:credential,audience:c.LISTENING_GOOGLE_CLIENT_ID})).getPayload()});
const worker=createDocsWorker({pool,docs});
let stopping=false;
const workerLoop=async()=>{while(!stopping){try{await worker.once();}catch(error){console.error(JSON.stringify({event:'reading_docs_worker_error',type:error.name}));}await new Promise(resolve=>setTimeout(resolve,1000));}};
const workerDone=workerLoop();
const server=app.listen(c.LISTENING_PORT,'0.0.0.0',()=>console.log(JSON.stringify({event:'reading_started',port:c.LISTENING_PORT})));
async function stop(){if(stopping)return;stopping=true;await new Promise(resolve=>server.close(resolve));await workerDone;await pool.end();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
