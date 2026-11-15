import {createHmac,timingSafeEqual} from 'node:crypto';
import {term1K56ListeningReportMap} from './listening-report-map-v1.mjs';

const maxGrantAgeMs=20*60*1000;
const maxClickDelayMs=15000;
const {sha256:hash}=term1K56ListeningReportMap;
const signature=(secret,claims)=>createHmac('sha256',secret).update('term1-k56-listening-report-v1:').update(claims).digest();

// This runs after the native checkpoint returns. Generic media pauses never
// request this capability, and capability creation has no exam side effects.
export function issueTerm1OnlineListeningReportGrant(secret,progress,row) {
  const manual=progress.manualListeningReport;
  const checkpoint=Number(row.listening_audio_checkpoint_seconds);
  if(typeof secret!=='string'||secret.length<32||!manual||progress.state!=='pause'||row.test_slug!=='term-test-1-k56'||
    !progress.audioOwnerId||!progress.recoveryId||!row.attempt_token||
    row.listening_audio_owner_id!==progress.audioOwnerId||
    row.listening_audio_interruption_id!==progress.recoveryId||
    row.listening_audio_state!=='pause'||Number(row.generation)!==progress.generation||
    manual.audioHash!==hash||!Number.isFinite(checkpoint)||!Number.isFinite(manual.positionSeconds)||
    Math.abs(checkpoint-manual.positionSeconds)>1)return null;
  const issuedAt=Date.parse(row.server_now),reportedAt=Date.parse(manual.reportedAt);
  if(!Number.isFinite(issuedAt)||!Number.isFinite(reportedAt)||Math.abs(issuedAt-reportedAt)>maxClickDelayMs)return null;
  const scope={attemptToken:row.attempt_token,examSessionToken:progress.examSessionToken,
    generation:progress.generation,ownerId:progress.audioOwnerId,operationId:progress.recoveryId};
  const claims=Buffer.from(JSON.stringify([
    scope.attemptToken,scope.examSessionToken,scope.generation,scope.ownerId,scope.operationId,
    manual.audioHash,manual.positionSeconds,manual.reportedAt,issuedAt,
  ])).toString('base64url');
  return {...scope,capability:claims+'.'+signature(secret,claims).toString('hex')};
}

export function createTerm1OnlineListeningReportResolver({query,secret,clock=Date.now}) {
  return async (body,capability)=>{
    if(body.mode!=='online'||typeof secret!=='string'||secret.length<32||typeof capability!=='string'||
      !/^[A-Za-z0-9_-]{1,650}\.[a-f0-9]{64}$/.test(capability))return null;
    const [claims,sig]=capability.split('.');
    if(!timingSafeEqual(signature(secret,claims),Buffer.from(sig,'hex')))return null;
    let grant;
    try{grant=JSON.parse(Buffer.from(claims,'base64url').toString('utf8'));}catch{return null;}
    const expected=[body.attemptToken,body.examSessionToken,body.generation,body.ownerId,
      body.operationId,body.audioHash,body.positionSeconds,body.reportedAt];
    if(!Array.isArray(grant)||grant.length!==9||expected.some((value,i)=>grant[i]!==value))return null;
    const issuedAt=grant[8],now=clock();
    if(!Number.isSafeInteger(issuedAt)||issuedAt>now+2000||now-issuedAt>maxGrantAgeMs)return null;
    const {rows:[row]}=await query(`
      SELECT a.student_name_snapshot,a.class_name_snapshot,s.listening_started_at
      FROM assessment.term_test_attempt a
      JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id AND s.generation=a.generation
      WHERE a.id=$1 AND s.id=$2 AND a.generation=$3 AND s.listening_audio_owner_id=$4
        AND a.test_slug='term-test-1-k56' AND a.attempt_mode='cbt' AND s.test_slug=a.test_slug
        AND a.superseded_at IS NULL AND s.superseded_at IS NULL`,
      [body.attemptToken,body.examSessionToken,body.generation,body.ownerId]);
    if(!row)return null;
    return {studentName:row.student_name_snapshot,className:row.class_name_snapshot,
      reportTimeMs:Date.parse(body.reportedAt),startedAtMs:Date.parse(row.listening_started_at)};
  };
}
