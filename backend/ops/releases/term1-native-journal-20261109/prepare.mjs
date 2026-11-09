// Prepare the Term 1 observation hooks from a read-only K56 snapshot.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

const [snapshot,target]=process.argv.slice(2);
if(!snapshot||!target||resolve(snapshot)===resolve(target))throw Error('TERM1_JOURNAL_NEW_TARGET_REQUIRED');
const replace=(source,anchor,next)=>{
  if(source.split(anchor).length!==2)throw Error('TERM1_JOURNAL_OVERLAY_ANCHOR_CHANGED: '+anchor);
  return source.replace(anchor,()=>next);
};
function stage(path,update){
  const file=resolve(snapshot,'src',path);
  const original=readFileSync(file,'utf8');
  const crlf=original.includes('\r\n');
  const changed=update(original.replaceAll('\r\n','\n'));
  const dest=resolve(target,'src',path);
  mkdirSync(dirname(dest),{recursive:true});
  writeFileSync(dest,crlf?changed.replaceAll('\n','\r\n'):changed,{flag:'wx'});
}

stage('k56-exam-order.js',source=>{
  const oldSignature='  async function prepare(slug, body, create = true) {';
  const newSignature='  async function prepare(slug, body, create = true, existingClient = null) {';
  const usesExistingClient=source.includes(newSignature);
  const signature=usesExistingClient?newSignature:oldSignature;
  const transactionEntry=usesExistingClient?'run':'transaction';
  source=replace(source,signature,`${signature}
    const observeIdentity = slug === 'term-test-1-k56'${usesExistingClient?' && !existingClient':''};
    let lookup = 'request_validation';
    try {`);
  source=replace(source,`    return ${transactionEntry}(async client => {
      const student = (await client.query(findStudentForTermTestSql, [body.classCode, slug, body.studentRef])).rows[0];`,
    `    const prepared = await ${transactionEntry}(async client => {
      lookup = 'native_eligibility';
      const student = (await client.query(findStudentForTermTestSql, [body.classCode, slug, body.studentRef])).rows[0];`);
  source=replace(source,`        // Token của lượt đã bắt đầu là quyền tiếp tục, tách khỏi quyền mở lượt mới.`,
    `        // Token của lượt đã bắt đầu là quyền tiếp tục, tách khỏi quyền mở lượt mới.
        if (body.attemptToken || body.examSessionToken) lookup = 'retained_owner';`);
  return replace(source,`      return load(client, slug, inserted.rows[0].id);
    });
  }
  async function withContent`,`      return load(client, slug, inserted.rows[0].id);
    });
    if (observeIdentity) record('term1_identity_decision',slug,prepared?.attempt_token,{
      accepted:Boolean(prepared),lookup,classCode:body.classCode,generation:Number(prepared?.generation ?? NaN),
      reason:prepared ? 'OWNER_BOUND' : 'ATTEMPT_NOT_FOUND'
    });
    return prepared;
    } catch (error) {
      if (observeIdentity) record('term1_identity_decision',slug,null,{
        accepted:false,lookup,classCode:body.classCode,reason:error?.code
      });
      throw error;
    }
  }
  async function withContent`);
});

stage('app.js',source=>{
  const build='  const build = Object.freeze({';
  source=replace(source,build,`  function observeTerm1ListeningCheckpoint(slug,token,state,row){
    if (deploymentProfile.family !== 'k56' || slug !== 'term-test-1-k56') return;
    try {termJournal?.business('term1_listening_checkpoint',slug,token,{
      section:'listening',state,heardSeconds:Number(row.listening_audio_checkpoint_seconds ?? NaN),
      nativeRevision:Number(row.audio_state_revision ?? NaN),generation:Number(row.generation ?? NaN),
      grantedRecoverySeconds:Number(row.granted_recovery_seconds ?? 0)
    });}catch{}
  }

`+build);
  const recovery=`      session = { ...session, ...recovered.rows[0] };
      if (Number(session.granted_recovery_seconds) > 0) {`;
  source=replace(source,recovery,`      session = { ...session, ...recovered.rows[0] };
      observeTerm1ListeningCheckpoint(slug.data,parsed.data.examSessionToken,'resume',session);
      if (Number(session.granted_recovery_seconds) > 0) {`);
  return replace(source,`    const row = saved.rows[0];
    if (parsed.data.state !== 'playing' || Number(row.granted_recovery_seconds) > 0) {`,
    `    const row = saved.rows[0];
    if (parsed.data.state === 'recovered')
      observeTerm1ListeningCheckpoint(slug.data,parsed.data.examSessionToken,'recovered',row);
    if (parsed.data.state !== 'playing' || Number(row.granted_recovery_seconds) > 0) {`);
});

stage('exam-journal-runtime/adapters/term.mjs',source=>{
  source=replace(source,
    '  async function observe({testSlug,token,proof,type,data,content,ownerFrame}) {',
    '  async function observe({testSlug,token,proof,type,data,content,ownerFrame,expectedGeneration}) {');
  source=replace(source,'      const owner = await work;','      const owner = await work;\n      if (expectedGeneration!==undefined && owner.generation!==expectedGeneration) return;');
  return replace(source,`  const business = (event,testSlug,token,details = {},content) => {`,
    `  const business = (event,testSlug,token,details = {},content) => {
    if (event === 'term1_identity_decision' || event === 'term1_listening_checkpoint') {
      if (testSlug !== 'term-test-1-k56' || env.TERM1_NATIVE_JOURNAL_ENABLED !== '1') return;
      const frame=requestContext.getStore();
      const requestId=frame?.requestId;
      const data={action:event,...requestId?{requestId}:{},checkpointState:{term1NativeVersion:1}};
      if (event === 'term1_identity_decision') {
        if (!['request_validation','native_eligibility','retained_owner'].includes(details.lookup)) return;
        const accepted=details.accepted===true;
        const reasons=['OWNER_BOUND','ATTEMPT_NOT_FOUND','STUDENT_NOT_FOUND','STUDENT_MISMATCH','TOKEN_REQUIRED',
          'IDENTITY_REQUIRED','DEFINITION_CHANGED','READ_FIRST_PAUSED','MODE_CONFLICT','EXAM_GENERATION_STALE'];
        const classCode=typeof details.classCode==='string' ? details.classCode.trim().toUpperCase() : '';
        if (accepted && (!Number.isSafeInteger(details.generation) || details.generation<0)) return;
        if (!accepted && (!UUID.test(requestId || '') || !/^[A-Z0-9_-]{1,60}$/.test(classCode))) return;
        data.outcome=accepted?'accepted':'rejected';
        data.reasonCode=reasons.includes(details.reason)?details.reason:'IDENTITY_CHECK_FAILED';
        data.checkpointState.lookup=details.lookup;
        void observe({testSlug,token:accepted?token:undefined,
          ...accepted?{expectedGeneration:details.generation}:{proof:{classCode,pageVisitId:requestId}},type:'decision_made',data,ownerFrame:frame});
        return;
      }
      const {state,heardSeconds,nativeRevision,generation,grantedRecoverySeconds}=details;
      if (!['recovered','resume'].includes(state) || !Number.isFinite(heardSeconds) || heardSeconds<0 || heardSeconds>7200
          || !Number.isSafeInteger(nativeRevision) || nativeRevision<0 || !Number.isSafeInteger(generation) || generation<0
          || !Number.isFinite(grantedRecoverySeconds) || grantedRecoverySeconds<0 || grantedRecoverySeconds>900) return;
      data.section='listening';
      data.outcome='accepted';
      Object.assign(data.checkpointState,{state,heardSeconds,nativeRevision,generation,grantedRecoverySeconds});
      void observe({testSlug,token,type:'decision_made',data,ownerFrame:frame,expectedGeneration:generation});
      return;
    }`);
});
