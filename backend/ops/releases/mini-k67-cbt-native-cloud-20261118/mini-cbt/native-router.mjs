import {readFileSync} from 'node:fs';
import {createMiniK67CbtReceiptProducer} from './native-receipt.mjs';
import {createMiniK67CbtCloudSpool} from './native-transport-binding.mjs';
import {miniK67JournalProduct,miniK67Slug} from './native-event-policy.mjs';

function isOpen(file,scope,now) {
  try {
    const policy=JSON.parse(readFileSync(file,'utf8'));
    const opens=Date.parse(policy.opensAt),closes=Date.parse(policy.closesAt);
    return policy.version===1 && policy.mode==='cloud' && (policy.classCode==='*'||policy.classCode===scope.classCode)
      && Number.isFinite(opens) && Number.isFinite(closes) && now>=opens && now<closes;
  } catch { return false; }
}

export function mountMiniK67CbtNativeCloud({env,productId,schema,query,scopeForOwner,logger,clock=Date.now}) {
  const routeFile=env.K67_MINI_CBT_NATIVE_ROUTE_FILE;
  if(productId!==miniK67JournalProduct || schema!=='assessment' || !routeFile) return null;
  try {
    const raw=readFileSync(env.K67_MINI_CBT_NATIVE_SPOOL_KEY_FILE,'utf8').trim();
    if(!/^[a-zA-Z0-9+/]{43}=$/.test(raw)) throw Error('MINI_K67_CBT_NATIVE_SPOOL_CONFIG_INVALID');
    const spool=createMiniK67CbtCloudSpool({endpoint:env.K67_MINI_CBT_NATIVE_SPOOL_ENDPOINT,key:Buffer.from(raw,'base64')});
    return createMiniK67CbtNativeRouter({query,scopeForOwner,spool,useCloud:scope=>isOpen(routeFile,scope,clock())});
  } catch {
    logger.warn?.(JSON.stringify({type:'exam_journal_startup',productId,code:'MINI_K67_CBT_NATIVE_SPOOL_CONFIG_INVALID'}));
    return null;
  }
}

export function createMiniK67CbtNativeRouter({query,scopeForOwner,spool,useCloud}) {
  const receipt=createMiniK67CbtReceiptProducer({query,scopeForOwner,spool});
  let queued=0,failed=0,capacityFallback=0;
  return {
    async offer({owner,scope,type,data}) {
      if(scope.product!==miniK67JournalProduct || scope.testSlug!==miniK67Slug || owner.identityConfirmed===false
        || owner.versions?.superseded || type!=='submission_committed' || data?.action!=='submission_completed'
        || data.outcome!=='accepted' || data.checkpointState?.delivery!=='cbt' || !await useCloud(scope)) return false;
      try {
        const queuedReceipt=await receipt('submission_completed',scope.testSlug,owner.sourceId,
          {section:data.section,submission:data.checkpointState},scope);
        if(!queuedReceipt) return false;
        queued++;
        return true;
      } catch(error) {
        failed++;
        // This error is raised by the client before it adds the call to its local queue.
        if(error.code==='JOURNAL_PRODUCER_QUEUE_FULL') {
          capacityFallback++;
          return false;
        }
        // No second destination after uncertain enqueue. The original frame may already be durable.
        throw error;
      }
    },
    close:()=>spool.close(),
    metrics:()=>({queued,failed,capacityFallback,spool:spool.metrics()}),
  };
}
