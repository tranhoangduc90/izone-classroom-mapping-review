"""Mô phỏng ba hành trình mới trên backend K67 thật, giữ dữ liệu làm bằng chứng.

Chỉ thêm ba học viên giả vào lớp CODEXDEMO806 đã có; backend sẵn có bỏ gửi
điểm Portal ở lớp này. Ghi intent trước mỗi POST, không tự lặp khi mất ACK.
Kiểm nháp/nộp lặp, audio giải mã, chấm thật và readback; không reset bài cũ.
"""
from pathlib import Path
from datetime import datetime,timezone
import argparse
import base64
import hashlib
import importlib.util
import json
import sys
import uuid
from urllib.parse import urljoin
import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-journeys')
STATE=PRIVATE/'state.json'
BASE='https://ducizone.ddns.net:18869/term-mini-k67-api'
CLASS='CODEXDEMO806'
CLASS_ID=-8062028
SLUGS=['term-test-1','term-test-2','mini-test-lesson-5']

def load(name,file):
    s=importlib.util.spec_from_file_location(name,ROOT/'tools'/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def check(value,code):
    if not value:raise RuntimeError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def utc():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')

def post(h,state,key,path,payload,statuses=(200,)):
    ledger=state.setdefault('http',{});record=ledger.get(key)
    if record:
        check(record['path']==path and record['payload']==payload,'K67_SIMULATION_REQUEST_CHANGED')
        check('response' in record,'K67_SIMULATION_HTTP_OUTCOME_UNKNOWN')
    else:
        record={'path':path,'payload':payload,'at':utc()};ledger[key]=record;h.atomic(STATE,state)
        response=requests.post(BASE+path,json=payload,timeout=40,allow_redirects=False)
        record['status']=response.status_code
        try:record['response']=response.json()
        except ValueError:record['response']={'invalid_json':True}
        h.atomic(STATE,state)
    check(record['status'] in statuses and record['response'].get('ok') is True,'K67_SIMULATION_HTTP_FAILED_'+key.upper().replace(':','_').replace('-','_'))
    return record['response']

def seed(db,u,h,client,state):
    demo=db.query(u,client,"SELECT jsonb_agg(erp_class_name_snapshot) FROM mapping.classroom_course_mapping WHERE erp_course_class_id=-8062028")
    check(demo==[CLASS],'K67_SIMULATION_DEMO_CLASS_CHANGED')
    statements=["BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s';"]
    for slug,row in state['students'].items():
        # Mã, UUID, slug và tên do script sinh cố định; không nhận SQL từ người dùng.
        values="'"+slug+"',"+str(CLASS_ID)+','+str(row['id'])+",'"+row['ref']+"','"+row['name']+"'"
        statements.append('INSERT INTO assessment.term_test_roster(test_slug,erp_course_class_id,erp_student_contact_id,student_ref,student_name_snapshot) VALUES('+values+') ON CONFLICT DO NOTHING;')
    statements.append('COMMIT;');db.sql(u,client,'\n'.join(statements))
    actual=db.query(u,client,'SELECT jsonb_object_agg(test_slug,jsonb_build_object(\'id\',erp_student_contact_id,\'ref\',student_ref,\'name\',student_name_snapshot)) FROM assessment.term_test_roster WHERE erp_course_class_id=-8062028 AND erp_student_contact_id IN ('+','.join(str(x['id']) for x in state['students'].values())+')')
    check(actual==state['students'],'K67_SIMULATION_ROSTER_READBACK_MISMATCH')
    state['seeded']=True;h.atomic(STATE,state)

def asset_check(h,u,client,state,slug,prepared,started):
    proof=state.setdefault('assets',{}).get(slug)
    if proof:return
    inventory=json.loads((PRIVATE.parent/'ASSETS_AND_PAGES_INVENTORY_FINAL.json').read_bytes())
    pins=[r for r in inventory['assets']['rows'] if r['slug']==slug]
    preview=requests.get(urljoin(BASE+'/',prepared['previewAudioUrl'].lstrip('/')),timeout=40,allow_redirects=False)
    # Trả URL tương đối /api/... thuộc API_BASE_URL, không thuộc gốc hostname.
    if preview.status_code!=200:
        raise RuntimeError('K67_SIMULATION_PREVIEW_HTTP_FAILED')
    check(sha(preview.content)==next(r['sha256'] for r in pins if r['path'].endswith('preview-30s.mp3')),'K67_SIMULATION_PREVIEW_HASH_MISMATCH')
    audio=requests.get(urljoin(BASE+'/',prepared['encryptedAudioUrl'].lstrip('/')),timeout=60,allow_redirects=False)
    check(audio.status_code==200 and audio.content[:5]==b'IZTT1','K67_SIMULATION_ENCRYPTED_AUDIO_INVALID')
    clear=AESGCM(base64.b64decode(started['audioKey'])).decrypt(audio.content[5:17],audio.content[17:],None)
    audio_pin=next(r for r in pins if r['path'].endswith('/listening-audio.mp3'))
    check(len(clear)==audio_pin['bytes'] and sha(clear)==audio_pin['sha256'],'K67_SIMULATION_AUDIO_DECRYPT_MISMATCH')
    sftp=client.open_sftp()
    try:
        with sftp.open('/opt/term-mini-k67/assets/'+slug+'/content.json','rb') as stream:content=json.load(stream)
    finally:sftp.close()
    check(started['content']==content,'K67_SIMULATION_CONTENT_MISMATCH')
    state['assets'][slug]={'preview_hash':sha(preview.content),'audio_hash':sha(clear),'audio_bytes':len(clear),'content_equal':True}
    h.atomic(STATE,state)

def prepare(db,u,h,client,state):
    if not state.get('seeded'):seed(db,u,h,client,state)
    essays=load('fake_essays','verify-grading-fixture.py').ESSAYS
    answers={}
    for slug in SLUGS:
        prefix='/api/term-tests/'+slug;row=state['students'][slug]
        def send(label,path,payload,statuses=(200,)):return post(h,state,slug+':'+label,path,payload,statuses)
        prepared=send('prepare',prefix+'/session/prepare',{'classCode':CLASS,'studentRef':row['ref']},(201,))
        token=prepared['examSessionToken'];started=send('start',prefix+'/session/start',{'examSessionToken':token})
        again=send('start-repeat',prefix+'/session/start',{'examSessionToken':token})
        check(again['listeningDeadlineAt']==started['listeningDeadlineAt'],'K67_SIMULATION_DEADLINE_EXTENDED')
        asset_check(h,u,client,state,slug,prepared,started)
        draft=send('listening-draft',prefix+'/listening/draft',{'examSessionToken':token,'revision':2,'answers':answers})
        stale=send('listening-stale',prefix+'/listening/draft',{'examSessionToken':token,'revision':1,'answers':{'1':'synthetic-stale'}})
        check(stale['accepted'] is False and stale['draft']==answers,'K67_SIMULATION_STALE_DRAFT_ACCEPTED')
        state.setdefault('submissions',{}).setdefault(slug,str(uuid.uuid4()));h.atomic(STATE,state)
        payload={'classCode':CLASS,'studentRef':row['ref'],'examSessionToken':token,
          'clientSubmissionId':state['submissions'][slug],'draftRevision':2,'answers':answers}
        listening=send('listening',prefix+'/listening',payload,(201,));attempt=listening['attemptToken']
        repeated=send('listening-repeat',prefix+'/listening',payload,(201,))
        check(repeated['attemptToken']==attempt and repeated['result']['listening']==listening['result']['listening'],'K67_SIMULATION_LISTENING_DUPLICATE_CHANGED')
        state.setdefault('attempts',{})[slug]=attempt;h.atomic(STATE,state)
        send('reading-start',prefix+'/reading/start',{'attemptToken':attempt})
        send('reading-draft',prefix+'/reading/draft',{'attemptToken':attempt,'revision':2,'answers':answers})
        reading=send('reading',prefix+'/reading',{'attemptToken':attempt,'draftRevision':2,'answers':answers})
        repeated=send('reading-repeat',prefix+'/reading',{'attemptToken':attempt,'draftRevision':3,'answers':{'1':'synthetic-stale'}})
        check(reading['completed'] is True and repeated['completed'] is True and reading['attemptToken']==repeated['attemptToken'],
          'K67_SIMULATION_READING_DUPLICATE_CHANGED')
        stored=db.query(u,client,"SELECT jsonb_build_object('answers',reading_answers,'correct',reading_result->'correct') FROM assessment.term_test_attempt WHERE id='"+attempt+"'::uuid")
        check(stored=={'answers':{},'correct':0},'K67_SIMULATION_READING_DUPLICATE_OVERWROTE_ANSWERS')
        if slug in essays:
            writing=send('writing-start','/api/term-tests/writing',{'attemptToken':attempt,'action':'start','task1':'','task2':''})['writing']
            saved=send('writing-draft','/api/term-tests/writing',{'attemptToken':attempt,'action':'draft',**essays[slug],'baseRevision':writing['revision']})['writing']
            check(saved['accepted'] is True,'K67_SIMULATION_WRITING_DRAFT_REJECTED')
            submitted=send('writing-submit','/api/term-tests/writing',{'attemptToken':attempt,'action':'submit',**essays[slug],'baseRevision':saved['revision']})['writing']
            check(submitted['submitted'] is True,'K67_SIMULATION_WRITING_NOT_SUBMITTED')
        print(json.dumps({'outcome':'progress','prepared_slug':slug,'fake_only':True}),flush=True)
    state['stage']='prepared';h.atomic(STATE,state)
    return {'outcome':'success','stage':'prepared','new_fake_attempts':3,'asset_checks':len(state['assets']),'learner_cutover':True}

def observe(db,u,h,client,state):
    ids=','.join("'"+x+"'" for x in state['attempts'].values())
    sql="""SELECT jsonb_build_object(
      'attempts',(SELECT jsonb_agg(jsonb_build_object('id',id,'slug',test_slug,'class',class_name_snapshot,'student',erp_student_contact_id,'complete',completed_at IS NOT NULL,'writing_submitted',writing_submitted_at IS NOT NULL) ORDER BY test_slug) FROM assessment.term_test_attempt WHERE id IN ("""+ids+""")),
      'runs',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'task',task_number) ORDER BY id) FROM assessment.term_test_writing_grading_run WHERE attempt_id IN ("""+ids+""")),
      'jobs',(SELECT jsonb_agg(jsonb_build_object('id',j.id,'status',j.status,'type',j.job_type,'attempts',j.attempt_count,'error',j.last_error_code) ORDER BY j.id) FROM assessment.term_test_writing_grading_job j JOIN assessment.term_test_writing_grading_run r ON r.id=j.run_id WHERE r.attempt_id IN ("""+ids+""")),
      'criteria',(SELECT count(*) FROM assessment.term_test_writing_grading_criterion c JOIN assessment.term_test_writing_grading_run r ON r.id=c.run_id WHERE r.attempt_id IN ("""+ids+""") AND c.status='complete'),
      'finals',(SELECT jsonb_agg(jsonb_build_object('attempt',attempt_id,'status',status,'writing_score',writing_score) ORDER BY attempt_id) FROM assessment.term_test_writing_grading_final WHERE attempt_id IN ("""+ids+""")),
      'portal',(SELECT count(*) FROM assessment.term_test_portal_sync_job WHERE attempt_id IN ("""+ids+""")))"""
    observed=db.query(u,client,sql)
    path=PRIVATE/('observation-'+uuid.uuid4().hex+'.private.json')
    with path.open('x',encoding='utf-8') as stream:json.dump(observed,stream,ensure_ascii=False,indent=2)
    check(len(observed['attempts'])==3 and all(x['class']==CLASS for x in observed['attempts']),'K67_SIMULATION_ATTEMPT_IDENTITY_CHANGED')
    check(observed['portal']==0,'K67_SIMULATION_PORTAL_JOB_CREATED')
    check(not any(x['status']=='failed' for x in observed['jobs'] or []),'K67_SIMULATION_GRADING_JOB_FAILED')
    if len(observed['jobs'] or [])==6 and all(x['status']=='complete' for x in observed['jobs']):
        check(all(x['attempts']==1 for x in observed['jobs']),'K67_SIMULATION_JOB_EXECUTED_MORE_THAN_ONCE')
    complete=len(observed['runs'] or [])==3 and all(x['status']=='complete' for x in observed['runs']) \
      and len(observed['jobs'] or [])==6 and all(x['status']=='complete' for x in observed['jobs']) \
      and observed['criteria']==12 and len(observed['finals'] or [])==2 and all(x['status']=='ready' for x in observed['finals'])
    if complete:
        for slug,token in state['attempts'].items():
            response=requests.post(BASE+'/api/term-tests/result',json={'attemptToken':token},timeout=20,allow_redirects=False)
            check(response.status_code==200,'K67_SIMULATION_RESULT_HTTP_FAILED');result=response.json()
            if slug.startswith('term-test-'):check(result['writing']['grading']['ready'] is True,'K67_SIMULATION_FINAL_NOT_VISIBLE')
            with (PRIVATE/('result-'+slug+'-'+uuid.uuid4().hex+'.private.json')).open('x',encoding='utf-8') as stream:json.dump(result,stream,ensure_ascii=False)
        state['stage']='verified';state['observation']=str(path);h.atomic(STATE,state)
    return {'outcome':'success','stage':'verified' if complete else 'waiting_for_grading',
      'runs':len(observed['runs'] or []),'jobs':len(observed['jobs'] or []),'criteria_complete':observed['criteria'],
      'finals_ready':sum(x['status']=='ready' for x in observed['finals'] or []),'portal_jobs':observed['portal'],'learner_cutover':True}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('phase',choices=['prepare','observe']);args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True);PRIVATE.mkdir(parents=True,exist_ok=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py');db=load('production_db','prepare-production-database.py');s=load('guard','prepare-context-source.py')
    check(json.loads((PRIVATE.parent/'production-activation/state.json').read_bytes())['stage']=='active_verified','K67_SIMULATION_GRADING_NOT_ACTIVE')
    if STATE.exists():state=json.loads(STATE.read_bytes())
    else:
        intent=uuid.uuid4().hex
        state={'intent':intent,'stage':'seed_intent','students':{slug:{'id':-806200000000-int(uuid.uuid4().hex[:10],16),
          'ref':str(uuid.uuid4()),'name':'Mô phỏng tách K67 '+intent[:8]+' '+str(i+1)} for i,slug in enumerate(SLUGS)}}
        h.atomic(STATE,state)
    lock=load('grading_lock','prepare-grading-fixture.py')
    with lock.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:return s.run_guarded(u,h,client,lambda:prepare(db,u,h,client,state) if args.phase=='prepare' else observe(db,u,h,client,state),PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
