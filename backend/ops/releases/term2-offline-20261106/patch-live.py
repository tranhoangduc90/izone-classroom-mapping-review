"""Ghép hẹp trên source K56 live; anchor sai thì dừng, không dựng lại toàn main."""
from pathlib import Path
import argparse,json,hashlib

def patch(root):
    root=Path(root)
    def edit(name, old, new):
        p=root/'src'/name;s=p.read_text(encoding='utf-8')
        if s.count(old)!=1:raise RuntimeError(f'Anchor {name}: {s.count(old)}')
        p.write_text(s.replace(old,new),encoding='utf-8',newline='\n')
    here=Path(__file__).parent
    baseline=json.loads((here/'baseline.json').read_text(encoding='utf-8'))
    for name,expected in baseline['files'].items():
        if hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected:raise RuntimeError('Source drift: '+name)
    for name in ['term2-offline.mjs','term2-blank.mjs']:(root/'src'/name).write_text((here/name).read_text(encoding='utf-8'),encoding='utf-8',newline='\n')
    edit('app.js', 'limiter: testWriteLimiter, requestPortalSync, readPortalSyncStatus, onJournalEvent:',
         'limiter: testWriteLimiter, readLimiter: testReadLimiter, draftLimiter: testDraftLimiter, secret: config.termTestSessionSecret, onWriting: ensureTermTestWritingGrading, requestPortalSync, readPortalSyncStatus, onJournalEvent:')
    edit('app.js', 'x-writing-test-sync, x-exam-journal-request-id', 'x-writing-test-sync, x-exam-journal-request-id, x-term2-permit')
    edit('k56-exam-order.js',"import crypto from 'node:crypto';","import crypto from 'node:crypto';\nimport {registerTerm2Offline} from './term2-offline.mjs';")
    edit('k56-exam-order.js','onJournalEvent, allowNewReadFirst =','onJournalEvent, secret, onWriting, readLimiter, draftLimiter, allowNewReadFirst =')
    edit('k56-exam-order.js',"  for (const path of ['attempt/prepare', 'session/prepare'])", "  registerTerm2Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});\n  for (const path of ['attempt/prepare', 'session/prepare'])")
    edit('term-test-writing-grading.js',"import crypto from 'node:crypto';","import crypto from 'node:crypto';\nimport {storeTerm2Blank,canonicalTerm2Submission} from './term2-blank.mjs';")
    edit('term-test-writing-grading.js','const attemptResult = await client.query(`SELECT id::text, test_slug','const attemptResult = await client.query(`SELECT *, id::text')
    edit('term-test-writing-grading.js','      const essays = { 1: cleanText(task1, 120_000), 2: cleanText(task2, 180_000) };',
        "      const canonicalSubmission=await canonicalTerm2Submission(client,attemptResult.rows[0]);\n      if(canonicalSubmission){task1=canonicalSubmission.task1;task2=canonicalSubmission.task2;}\n      if (await storeTerm2Blank(client,{attempt:attemptResult.rows[0],taskDefinitions,version:GRADING_VERSION})) return readStatus(client,attemptToken);\n      const essays = { 1: cleanText(task1, 120_000), 2: cleanText(task2, 180_000) };")
    edit('exam-journal-runtime/adapters/term.mjs','    void observe({testSlug,token,type,data,content});',
        "    if(testSlug==='term-test-2-k56'){\n      const diagnostics={};for(const key of ['operationId','receiptId','errorCode','phase','durationMs'])if(details[key]!==undefined)diagnostics[key]=details[key];\n      if(Object.keys(diagnostics).length)data.checkpointState={term2OfflineVersion:1,...diagnostics};\n    }\n    void observe({testSlug,token,type,data,content});")

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root');args=parser.parse_args();patch(args.root)
