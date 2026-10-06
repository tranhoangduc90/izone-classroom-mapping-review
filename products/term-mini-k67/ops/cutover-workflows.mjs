// Nhận bản trước đã lưu; chỉ bật 3 workflow K67 mới hoặc tắt 2 parent Term nguồn.
// Kiểm body và đúng instance trước POST; đọc lại sau, không retry mutation.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {readInput} from './production-grading.mjs';
import {body,hash} from './grading-fixture.mjs';
const PRIVATE='E:/Codex-Data/k67-backend-separation-20261006';
const parents=['DHUgPXJdCfVZWj56','SGtuBV91Yc9oxEVt'];
const ownSources=[...parents,'NFgOTzvfzfjwqY9x'];
const hosts={default:'https://ducizone.ddns.net','izone-ai':'https://n8n-ai.izone.edu.vn'};
async function run(input){
  let id,candidate;
  const lock=JSON.parse(await readFile(new URL('./grading-source-lock.json',import.meta.url),'utf8'));
  const pin=lock.workflows.find(x=>x.id===input.sourceId&&x.profile===input.profile);
  if(!pin)throw Error('CUTOVER_WORKFLOW_SOURCE_INVALID');
  if(input.lane==='source'){
    if(input.profile!=='default'||!parents.includes(input.sourceId)||input.active!==false)throw Error('CUTOVER_SOURCE_SCOPE_INVALID');
    id=input.sourceId;
  }else if(input.lane==='target'){
    const state=JSON.parse(await readFile(PRIVATE+'/grading-provision/state.json','utf8'));
    const own=state.created[input.sourceId];
    if(!ownSources.includes(input.sourceId)||!own||own.profile!==input.profile||own.id===input.sourceId
      ||own.name!=='K67 · '+pin.name||!own.readback_verified||input.active!==true)throw Error('CUTOVER_TARGET_SCOPE_INVALID');
    id=own.id;
    const qualified=JSON.parse(await readFile(PRIVATE+'/production-grading/state.json','utf8'));
    const manifest=JSON.parse(await readFile(PRIVATE+'/production-grading/candidates/manifest.json','utf8'));
    if(qualified.stage!=='production_bound_inactive'||qualified.pending||Object.keys(qualified.rows).length!==49
      ||Object.values(qualified.rows).some(r=>!r.after_version)||manifest.status!=='complete'||manifest.workflows.length!==49)
      throw Error('CUTOVER_TARGET_BUNDLE_NOT_QUALIFIED');
    const row=manifest.workflows.find(r=>r.sourceId===input.sourceId&&r.profile===input.profile&&r.targetId===id);
    if(!row||dirname(resolve(row.path))!==resolve(PRIVATE+'/production-grading/candidates')
      ||qualified.rows[input.sourceId].validated_sha256!==row.sha256)throw Error('CUTOVER_TARGET_CANDIDATE_IDENTITY_CHANGED');
    const raw=await readFile(row.path);
    if(createHash('sha256').update(raw).digest('hex')!==row.sha256)throw Error('CUTOVER_TARGET_CANDIDATE_CHANGED');
    candidate=JSON.parse(raw.toString('utf8'));
  }else throw Error('CUTOVER_WORKFLOW_LANE_INVALID');
  const base='C:/Users/ADMIN/AppData/Roaming/npm/node_modules/@trngthnh369/n8nctl/dist/lib/';
  const {resolveAuth}=await import(pathToFileURL(base+'auth.js'));
  const {N8nClient}=await import(pathToFileURL(base+'api.js'));
  const auth=await resolveAuth({profile:input.profile});
  if(auth.host.replace(/\/$/,'')!==hosts[input.profile])throw Error('CUTOVER_WORKFLOW_HOST_CHANGED');
  const client=new N8nClient(auth,{maxRetries:0,timeout:30000});
  const live=await client.get('/workflows/'+id);
  if(live.id!==id||live.name!==(input.lane==='source'?pin.name:'K67 · '+pin.name))throw Error('CUTOVER_WORKFLOW_IDENTITY_CHANGED');
  if(live.pinData&&Object.keys(live.pinData).length)throw Error('CUTOVER_WORKFLOW_PIN_DATA_CHANGED');
  if(candidate&&(candidate.id!==id||hash(body(live))!==hash(body(candidate))))throw Error('CUTOVER_TARGET_BINDINGS_CHANGED');
  if(input.operation==='snapshot')return {outcome:'success',workflow:live};
  if(!input.before||input.before.id!==id||hash(body(live))!==hash(body(input.before)))throw Error('CUTOVER_WORKFLOW_BODY_CHANGED');
  if(input.operation==='inspect')return {outcome:'success',workflow:live};
  if(input.operation!=='set_active')throw Error('CUTOVER_WORKFLOW_OPERATION_INVALID');
  if(live.active!==input.active){
    if(live.versionId!==input.before.versionId)throw Error('CUTOVER_WORKFLOW_VERSION_CHANGED');
    await client.post('/workflows/'+id+(input.active?'/activate':'/deactivate'));
  }
  const after=await client.get('/workflows/'+id);
  if(after.active!==input.active||hash(body(after))!==hash(body(input.before))
    ||(after.pinData&&Object.keys(after.pinData).length))throw Error('CUTOVER_WORKFLOW_READBACK_UNKNOWN');
  return {outcome:'success',workflow:after};
}
try{process.stdout.write(JSON.stringify(await run(await readInput(process.stdin)))+'\n');}
catch(error){process.stderr.write(JSON.stringify({outcome:'failure',code:/^[A-Z_]+$/.test(error.message)?error.message:'CUTOVER_WORKFLOW_OPERATION_FAILED',error_type:error.name,http_status:error.status??null})+'\n');process.exitCode=1;}
