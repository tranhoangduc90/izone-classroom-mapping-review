"""Add only the Mini CBT native log route to captured serving build 563216b2."""
from pathlib import Path
from hashlib import sha256
import json,shutil,sys

def once(text,before,after):
 assert text.count(before)==1,before[:100]
 return text.replace(before,after,1)

def stage(captured,target):
 assert not target.exists()
 assert sha256((captured/'adapters/term.mjs').read_bytes()).hexdigest()=='2fc9e13c40587eb47c9b544f32ba44821d6ff489e55e523d6412d42a7a1e38c9'
 assert sha256((captured/'adapters/term-k56-offline.mjs').read_bytes()).hexdigest()=='e123245814d2b37fbc56b247044bfb0a06c91700b84efd6bf839cc692e737876'
 shutil.copytree(captured,target)
 adapter=target/'adapters/term.mjs';before=adapter.read_bytes()
 text="import { mountMiniK56CbtNativeCloud } from './mini-k56-cbt-native/native-term-router.mjs';\n"+before.decode()
 text=once(text,'  const nativeCloudTerm1 = mountTerm1K56NativeCloud',
  "  const nativeCloudMini = mountMiniK56CbtNativeCloud({ env,productId,schema,query,\n"
  "    scopeForOwner:journal.scopeForOwner,build:config.buildSha,logger });\n"
  "  journal.registerCounters?.('miniK56CbtNativeCloud',()=>nativeCloudMini?.metrics() ?? {configured:false});\n"
  '  const nativeCloudTerm1 = mountTerm1K56NativeCloud')
 text=once(text,'const cloud = (await nativeCloudTerm1?.offer(observation)) || (await nativeCloud?.offer(observation));',
  'const cloud = (await nativeCloudMini?.offer(observation)) || (await nativeCloudTerm1?.offer(observation)) || (await nativeCloud?.offer(observation));')
 text=once(text,'await nativeCloudTerm1?.close();await nativeCloud?.close();await close();',
  'await nativeCloudMini?.close();await nativeCloudTerm1?.close();await nativeCloud?.close();await close();')
 text=once(text,"const task = testSlug === 'term-test-1-k56' ? 2 : testSlug === 'term-test-2-k56' ? 1 : null;",
  "const task = ['term-test-1-k56','mini-test-k56'].includes(testSlug) ? 2 : testSlug === 'term-test-2-k56' ? 1 : null;")
 adapter.write_text(text,encoding='utf-8',newline='\n')
 output=target/'adapters/mini-k56-cbt-native';output.mkdir()
 for name in ['native-event-policy.mjs','native-term-router.mjs','native-transport-binding.mjs','native-offline-receipt.mjs']:
  text=(captured/'adapters/term1-k56-native'/name).read_text(encoding='utf-8')
  text=text.replace('k56-term1-native-receipt-v1','k56-mini-cbt-native-receipt-v1')
  text=text.replace('Term1K56','MiniK56Cbt').replace('term1K56','miniK56Cbt').replace('TERM1_K56','MINI_K56_CBT').replace('K56_TERM1','K56_MINI_CBT')
  text=text.replace('term-test-1-k56','mini-test-k56').replace('term-mini-k56-term1','term-mini-k56-mini').replace('k56-term1','k56-mini')
  text=text.replace('term1_offline','mini_k56_offline').replace('term1OfflineVersion','mini_k56OfflineVersion')
  if name=='native-event-policy.mjs':
   text=once(text,"'order/open','attempt/active'","'order/open','attempt/active','attempt/prepare'")
   text=once(text,"'offline/hold','listening-report'","'offline/hold','listening-report','listening/report'")
   text=once(text,'generation:count,delivery:',
    "miniListeningReportVersion:value=>value===1,submissionRecoveryVersion:value=>value===1,incidentId:uuid,\n"
    "  mode:value=>['offline','online'].includes(value),\n"
    "  reportStatus:value=>['open','sending','waiting_photo','photo_queued','sent','text_sent','retry_wait','failed','delivery_unknown','expired'].includes(value),\n"
    '  generation:count,delivery:')
   text=once(text,"'worker_retry','hold','commit','readback'","'worker_retry','hold','commit','readback','enqueue','delivery'")
   text=once(text,'  if (!eventTypes.has(type) || !count(generation)) return null;',
    '  if (!eventTypes.has(type) || !count(generation)) return null;\n'
    "  if ((type.startsWith('job_') || data?.jobId!==undefined) && (!uuid(data?.jobId) || data?.task!==2)) return null;")
   text=once(text,'&& checkpointState.generation===scope.generation',
    "&& (!event.type.startsWith('job_') || uuid(fields.jobId)&&fields.task===2)\n"
    "    && (!fields.jobId || fields.task===2)\n"
    '    && checkpointState.generation===scope.generation')
  (output/name).write_text(text,encoding='utf-8',newline='\n')
 files=[adapter,*sorted(output.glob('*.mjs'))]
 manifest={'baseAdapterSha256':sha256(before).hexdigest(),'preservedReceiptHelperSha256':sha256((captured/'adapters/term-k56-offline.mjs').read_bytes()).hexdigest(),
  'files':{p.relative_to(target).as_posix():sha256(p.read_bytes()).hexdigest() for p in files}}
 manifest['build']=sha256(json.dumps(manifest['files'],sort_keys=True).encode()).hexdigest()[:40]
 return manifest

if __name__=='__main__':
 captured,target=map(Path,sys.argv[1:]);print(json.dumps(stage(captured,target),indent=2))
