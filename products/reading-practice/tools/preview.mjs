import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {localPool} from './local-pool.mjs';
import {createReadingService} from '../src/service.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';
import {registerAuthoredLesson} from '../src/authored-content.js';

// Local chạy cùng API và SQL nghiệp vụ; roster/Google là fixture, tuyệt đối không phát hành chế độ này.
const [contentPath,staticRoot,dataPath,portInput='4389',mode='homework']=process.argv.slice(2);
if(!contentPath||!staticRoot||!dataPath||!['homework','shared'].includes(mode))throw new Error('Usage: preview.mjs private-content.json frontend-dir data-dir [port] [homework|shared]');
await mkdir(dataPath,{recursive:true});const pool=await localPool(path.join(dataPath,'db'));
const identityPath=path.join(dataPath,'fixture.json');let fixture;
try{fixture=JSON.parse(await readFile(identityPath,'utf8'));}catch{fixture={studentRef:uuid(),entryToken:secret(),adminKey:secret()};await writeFile(identityPath,JSON.stringify(fixture),'utf8');}
if(!fixture.studentRefB){fixture.studentRefB=uuid();await writeFile(identityPath,JSON.stringify(fixture),'utf8');}
const member={studentRef:fixture.studentRef,name:'Học viên chạy thử A'},memberB={studentRef:fixture.studentRefB,name:'Học viên chạy thử B'};
const classes=[{id:'1124',classCode:'CHẠY THỬ 67'},{id:'1293',classCode:'CHẠY THỬ B'}],members={'1124':[member],'1293':[memberB]},context={
 classes:async()=>classes,student:async(c,id)=>members[c]?.find(s=>s.studentRef===id),roster:async c=>members[c]||[],
 teacher:async(c,email,subject)=>Object.hasOwn(members,c)&&email==='teacher@example.test'&&subject==='local-google'};
const port=Number(portInput),base=`http://127.0.0.1:${port}/`;
const service=createReadingService({pool,context,pageBase:path.basename(staticRoot)==='reading-practice'?base:base+'reading-practice/',verifyBinding:async input=>({fixtureOnly:true,documentId:input.documentId,studentRef:input.studentRef})});
const bundle=JSON.parse(await readFile(contentPath,'utf8'));
if(bundle.definition?.authored)registerAuthoredLesson(bundle.definition.lesson);
await service.seedContent(bundle);
let entryUrl;
if(mode==='shared')entryUrl=(await service.configureSharedLesson({code:bundle.code,contentVersion:bundle.version,status:'open'})).url;
else{
 const registered=await service.register({classId:'1124',classCode:'CHẠY THỬ 67',studentRef:member.studentRef,documentId:'local_reading_document_1234567890',tabId:'t.0',code:bundle.code,contentVersion:bundle.version,entryToken:fixture.entryToken});
 await pool.query("UPDATE reading_practice.assignment SET status='open'");await pool.query('UPDATE reading_practice.binding SET cta_verified_at=now()');entryUrl=registered.entryUrl;
}
const app=createApp({pool,service,origins:[new URL(base).origin],googleClientId:'',adminKey:fixture.adminKey,staticRoot,teacherCookiePath:'/api',
 verifyGoogle:async credential=>credential==='LOCAL_TEST_CREDENTIAL'?{email:'teacher@example.test',sub:'local-google',email_verified:true}:null});
const server=app.listen(port,'127.0.0.1');
await writeFile(path.join(dataPath,'open.json'),JSON.stringify({entryUrl,studentRef:member.studentRef,studentRefB:memberB.studentRef,classes,apiBase:base+'api'}),'utf8');
console.log(JSON.stringify({event:'reading_local_ready',port,fixtureOnly:true,openFile:path.join(dataPath,'open.json')}));
process.on('SIGINT',async()=>{server.close();await pool.end();process.exit(0);});
