import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMiniK56CbtCloudSpool } from './native-transport-binding.mjs';
import { createMiniK56CbtOfflineReceiptProducer } from './native-offline-receipt.mjs';
import { projectMiniK56CbtNativeEvent, miniK56CbtProduct, miniK56CbtSlug } from './native-event-policy.mjs';

export function mountMiniK56CbtNativeCloud({ env, productId, schema, query, scopeForOwner, build, logger, fixtureMode=false }) {
  if (productId!==miniK56CbtProduct || schema!=='assessment_k56' || !env.K56_MINI_CBT_NATIVE_ROUTE_FILE) return null;
  try {
    const raw=readFileSync(env.K56_MINI_CBT_NATIVE_SPOOL_KEY_FILE,'utf8').trim();
    if (!/^[a-zA-Z0-9+/]{43}=$/.test(raw)) throw Error('MINI_K56_CBT_NATIVE_SPOOL_CONFIG_INVALID');
    const spool=createMiniK56CbtCloudSpool({ endpoint:env.K56_MINI_CBT_NATIVE_SPOOL_ENDPOINT,key:Buffer.from(raw,'base64'),fixtureMode });
    const useCloud = scope => {
      try {
        const policy=JSON.parse(readFileSync(env.K56_MINI_CBT_NATIVE_ROUTE_FILE,'utf8'));
        const opens=Date.parse(policy.opensAt),closes=Date.parse(policy.closesAt),now=Date.now();
        return policy.version===1&&policy.mode==='cloud'&&(policy.classCode==='*'||policy.classCode===scope.classCode)
          &&Number.isFinite(opens)&&Number.isFinite(closes)&&now>=opens&&now<closes;
      } catch { return false; }
    };
    return createMiniK56CbtNativeRouter({ schema,query,scopeForOwner,build,spool,useCloud });
  } catch {
    logger.warn?.(JSON.stringify({ type:'exam_journal_startup',productId,code:'MINI_K56_CBT_NATIVE_SPOOL_CONFIG_INVALID' }));
    return null;
  }
}

export function createMiniK56CbtNativeRouter({ schema, query, scopeForOwner, build, spool, useCloud }) {
  if (!['assessment_k56','assessment'].includes(schema)) throw Error('MINI_K56_CBT_NATIVE_SCHEMA_INVALID');
  const receipt=createMiniK56CbtOfflineReceiptProducer({ schema,query,scopeForOwner,spool,useCloud });
  let queued=0,failed=0,keptInCollector=0;
  return {
    async offer({ owner,scope,type,data,occurredAt }) {
      if (scope.product!==miniK56CbtProduct||scope.testSlug!==miniK56CbtSlug||owner.identityConfirmed===false
        ||owner.versions?.superseded||!await useCloud(scope)) return false;
      const { rows:[verified] }=await query(`SELECT 1 FROM ${schema}.term_test_exam_session s
        JOIN ${schema}.term_test_attempt a ON a.exam_session_id=s.id AND a.generation=s.generation
          AND a.test_slug=s.test_slug AND a.erp_student_contact_id=s.erp_student_contact_id AND a.erp_course_class_id=s.erp_course_class_id
        WHERE s.id=$1::uuid AND s.test_slug='mini-test-k56' AND s.generation=$2
          AND s.class_name_snapshot=$3 AND s.erp_student_contact_id::text=$4
          AND s.attempt_mode='cbt' AND a.attempt_mode='cbt' AND s.superseded_at IS NULL AND a.superseded_at IS NULL
        LIMIT 1`,[owner.sourceId,scope.generation,scope.classCode,scope.studentRef]);
      if (!verified) return false;
      const projected=projectMiniK56CbtNativeEvent(type,data,scope.generation);
      if (!projected) { keptInCollector++; return false; }
      try {
        const state=projected.checkpointState;
        if (data.action==='offline_operation_committed'&&state.operationId&&state.receiptId) {
          const { rows:[operation] }=await query(`SELECT attempt_id::text,kind FROM ${schema}.mini_k56_offline_operation
            WHERE operation_id=$1::uuid AND receipt->>'receiptId'=$2`,[state.operationId,state.receiptId]);
          if (!operation) return false;
          if (operation.kind==='seal'&&data.outcome==='accepted') {
            const saved=await receipt('offline_operation_committed',scope.testSlug,operation.attempt_id,
              { ...state,section:projected.section,phase:'after_commit',accepted:true },scope);
            if (!saved) return false;
            queued++;
            return true;
          }
        }
        const id=randomUUID();
        await spool.append(scope,[{ id,pageVisitId:id,sequence:1,schemaVersion:1,eventVersion:1,source:'server',
          type,occurredAt,elapsedMs:0,build:build||'unknown',data:projected }]);
        queued++;
        return true;
      } catch(error) {
        failed++;
        throw error;
      }
    },
    close:()=>spool.close(),
    metrics:()=>({ queued,failed,keptInCollector,spool:spool.metrics() }),
  };
}
