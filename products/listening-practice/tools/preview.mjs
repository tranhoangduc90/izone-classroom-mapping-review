import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {localPool} from './local-pool.mjs';
import {createListeningService} from '../src/service.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';
import {loadReview} from '../src/review.js';
import {registerAuthoredLesson} from '../src/authored-content.js';

// Local chạy cùng API và SQL nghiệp vụ; roster/Google là fixture, tuyệt đối không phát hành chế độ này.
const [contentPath,staticRoot,dataPath,portInput='4389',mode='homework']=process.argv.slice(2);
if(!contentPath||!staticRoot||!dataPath)throw new Error('Usage: preview.mjs private-content.json frontend-dir data-dir [port]');
await mkdir(dataPath,{recursive:true});const pool=await localPool(path.join(dataPath,'db'));
const identityPath=path.join(dataPath,'fixture.json');let fixture;
try{fixture=JSON.parse(await readFile(identityPath,'utf8'));}catch{fixture={studentRef:uuid(),entryToken:secret(),adminKey:secret()};await writeFile(identityPath,JSON.stringify(fixture),'utf8');}
// Link chung dùng hai lớp và hai UUID giả, giữ dữ liệu trong chính DB preview Listening.
fixture.studentRef2??=uuid();await writeFile(identityPath,JSON.stringify(fixture),'utf8');
const member={studentRef:fixture.studentRef,name:'Học viên chạy thử'},member2={studentRef:fixture.studentRef2,name:'Học viên chạy thử lớp khác'},context={
 classes:async()=>mode==='shared'?[{id:'1124',classCode:'CHẠY THỬ IC2304'},{id:'1293',classCode:'CHẠY THỬ IC2305'}]:[{id:'1124',classCode:'CHẠY THỬ 67'}],
 student:async(c,id)=>c==='1124'&&id===member.studentRef?member:mode==='shared'&&c==='1293'&&id===member2.studentRef?member2:undefined,
 roster:async c=>c==='1124'?[member]:mode==='shared'&&c==='1293'?[member2]:[],
 teacher:async(c,email,subject)=>c==='1124'&&email==='teacher@example.test'&&subject==='local-google'};
const port=Number(portInput),base=`http://127.0.0.1:${port}/`;
const pageBase=path.basename(staticRoot)==='listening-practice'?base:base+'listening-practice/';
const service=createListeningService({pool,context,pageBase,verifyBinding:async input=>({fixtureOnly:true,documentId:input.documentId,studentRef:input.studentRef})});
const bundle=JSON.parse(await readFile(contentPath,'utf8'));
if(bundle.definition?.authored)registerAuthoredLesson(bundle.definition.lesson);
await service.seedContent(bundle);
const registered=mode==='shared'?await service.configureSharedLesson({code:bundle.code,contentVersion:bundle.version,status:'open'}):await service.register({code:bundle.code,classId:'1124',classCode:'CHẠY THỬ 67',studentRef:member.studentRef,documentId:'local_listening_document_1234567890',tabId:'t.0',contentVersion:bundle.version,entryToken:fixture.entryToken});
await pool.query("UPDATE listening_practice.assignment SET status='open'");await pool.query('UPDATE listening_practice.binding SET cta_verified_at=now()');
let media={audioPath:'audio.mp3'};
try{media=JSON.parse(await readFile(path.resolve(path.dirname(contentPath),'media.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
let review=null;
try{review=await loadReview(path.resolve(path.dirname(contentPath),'review.json'),bundle.definition.audio.sha256);}catch(e){if(e.code!=='ENOENT')throw e;}
const app=createApp({pool,service,teacherCookiePath:'/api',origins:[new URL(base).origin],googleClientId:'',adminKey:fixture.adminKey,staticRoot,review,audioFile:path.resolve(path.dirname(contentPath),media.audioPath),audioHash:bundle.definition.audio.sha256,
 verifyGoogle:async credential=>credential==='LOCAL_TEST_CREDENTIAL'?{email:'teacher@example.test',sub:'local-google',email_verified:true}:null});
const server=app.listen(port,'127.0.0.1');
await writeFile(path.join(dataPath,'open.json'),JSON.stringify({entryUrl:registered.entryUrl||registered.url,studentRef:member.studentRef,apiBase:base+'api',mode}),'utf8');
console.log(JSON.stringify({event:'listening_local_ready',port,fixtureOnly:true,openFile:path.join(dataPath,'open.json')}));
process.on('SIGINT',async()=>{server.close();await pool.end();process.exit(0);});
