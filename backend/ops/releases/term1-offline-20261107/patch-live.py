"""Nối Term 1 vào nền live sau Term 2; không thay cấu hình, dữ liệu hoặc module khác."""
from pathlib import Path
import argparse,json,hashlib

def patch(root):
 root=Path(root);here=Path(__file__).parent
 baseline=json.loads((here/'baseline.json').read_text(encoding='utf8'))
 for name,expected in baseline['files'].items():
  if hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected:raise RuntimeError('Source drift: '+name)
 def edit(name,a,b):
  p=root/'src'/name;s=p.read_text(encoding='utf8');assert s.count(a)==1,(name,a,s.count(a));p.write_text(s.replace(a,b),encoding='utf8',newline='\n')
 for name in ['k56-offline-core.mjs','term1-offline.mjs','term2-offline.mjs','term1-blank.mjs']:
  (root/'src'/name).write_text((here/name).read_text(encoding='utf8'),encoding='utf8',newline='\n')
 edit('k56-exam-order.js',"import {registerTerm2Offline} from './term2-offline.mjs';","import {registerTerm2Offline} from './term2-offline.mjs';\nimport {registerTerm1Offline} from './term1-offline.mjs';")
 anchor='  registerTerm2Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});'
 edit('k56-exam-order.js',anchor,anchor+'\n  registerTerm1Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});')
 edit('term-test-writing-grading.js',"import {storeTerm2Blank,canonicalTerm2Submission} from './term2-blank.mjs';","import {storeTerm2Blank,canonicalTerm2Submission} from './term2-blank.mjs';\nimport {storeTerm1Blank,canonicalTerm1Submission} from './term1-blank.mjs';")
 edit('term-test-writing-grading.js','const canonicalSubmission=await canonicalTerm2Submission(client,attemptResult.rows[0]);','const canonicalSubmission=await canonicalTerm2Submission(client,attemptResult.rows[0])||await canonicalTerm1Submission(client,attemptResult.rows[0]);')
 anchor='      if (await storeTerm2Blank(client,{attempt:attemptResult.rows[0],taskDefinitions,version:GRADING_VERSION})) return readStatus(client,attemptToken);'
 edit('term-test-writing-grading.js',anchor,anchor+'\n      if (await storeTerm1Blank(client,{attempt:attemptResult.rows[0],taskDefinitions,version:GRADING_VERSION})) return readStatus(client,attemptToken);')
 edit('exam-journal-runtime/adapters/term.mjs',"if(testSlug==='term-test-2-k56'){","if(testSlug==='term-test-2-k56'||testSlug==='term-test-1-k56'){")
 edit('exam-journal-runtime/adapters/term.mjs','data.checkpointState={term2OfflineVersion:1,...diagnostics};',"data.checkpointState={...(testSlug==='term-test-2-k56'?{term2OfflineVersion:1}:{term1OfflineVersion:1}),...diagnostics};")

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root');patch(p.parse_args().root)
