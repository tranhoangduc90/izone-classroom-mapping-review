"""Derive the Term1 native route from the exact current K56 journal modules."""
from pathlib import Path
from hashlib import sha256
import json,shutil
import sys
captured,target=map(Path,sys.argv[1:])
assert not target.exists()
assert sha256((captured/'adapters/term.mjs').read_bytes()).hexdigest()=='74f8e67ed3f8ffbe9727408ad4815cc7e355ca6ff59c9c4b1cf7990d9b05f883'
assert sha256((captured/'adapters/term-k56-offline.mjs').read_bytes()).hexdigest()=='f7c1aadc3c89a0c481d851fae1dfa0c65b6c87277e52329b8e30aaae6ed5e35f'
shutil.copytree(captured,target)
here=target.parent
adapter=target/'adapters/term.mjs';before=adapter.read_bytes()
text=before.decode()
text="import { mountTerm1K56NativeCloud } from './term1-k56-native/native-term-router.mjs';\n"+text
anchor="  const nativeCloud = mountTerm2K56NativeCloud({ env,productId,schema,query,"
assert text.count(anchor)==1
text=text.replace(anchor,"  const nativeCloudTerm1 = mountTerm1K56NativeCloud({ env,productId,schema,query,\n    scopeForOwner:journal.scopeForOwner,build:config.buildSha,logger });\n  journal.registerCounters?.('term1K56NativeCloud',()=>nativeCloudTerm1?.metrics() ?? {configured:false});\n"+anchor)
anchor='const cloud = await nativeCloud?.offer({owner,scope:context,type,data,occurredAt});'
assert text.count(anchor)==1
text=text.replace(anchor,'const observation={owner,scope:context,type,data,occurredAt};\n        const cloud = (await nativeCloudTerm1?.offer(observation)) || (await nativeCloud?.offer(observation));')
anchor='await nativeCloud?.close();await close();'
assert text.count(anchor)==1
text=text.replace(anchor,'await nativeCloudTerm1?.close();'+anchor)
adapter.write_text(text,encoding='utf-8',newline='\n')
new=target/'adapters/term1-k56-native';new.mkdir()
files=['native-event-policy.mjs','native-term-router.mjs','native-transport-binding.mjs','native-offline-receipt.mjs']
for name in files:
 text=(captured/'adapters/term2-k56-native'/name).read_text()
 text=text.replace('Term2K56','Term1K56').replace('TERM2_K56','TERM1_K56').replace('K56_TERM2','K56_TERM1')
 text=text.replace('term2K56','term1K56').replace('term-test-2-k56','term-test-1-k56').replace('k56-term2','k56-term1').replace('term-mini-k56-term2','term-mini-k56-term1')
 text=text.replace('term2_offline','term1_offline').replace('term2OfflineVersion','term1OfflineVersion')
 if name=='native-event-policy.mjs':
  assert text.count('jobId:uuid,task:value=>value===1,')==1
  text=text.replace('jobId:uuid,task:value=>value===1,','jobId:uuid,task:value=>value===2,')
 (new/name).write_text(text,encoding='utf-8',newline='\n')
paths=[adapter,*[new/name for name in files]]
manifest={'baseAdapterSha256':sha256(before).hexdigest(),'files':{p.relative_to(target).as_posix():sha256(p.read_bytes()).hexdigest() for p in paths}}
manifest['build']=sha256(json.dumps(manifest['files'],sort_keys=True).encode()).hexdigest()[:40]
(here/'api-overlay-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest,indent=2))
