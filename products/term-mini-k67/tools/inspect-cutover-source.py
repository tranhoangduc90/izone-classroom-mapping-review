"""Chỉ đọc số lượt/job còn chạy và tuyến API nguồn, không in bài hay secret.

Lưu ảnh chụp metadata riêng tư để chuẩn bị chuyển một chủ ghi. Không bật/tắt
workflow, sửa Nginx hoặc khóa bảng. Kết quả có thời điểm UTC và trạng thái thật.
"""
from pathlib import Path
from datetime import datetime,timezone
import importlib.util
import json
import re
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/cutover-source')

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def inspect(u,source,p,route,client):
    status=source.query(u,client,"""SELECT jsonb_build_object(
      'listening_active',(SELECT count(*) FROM assessment.term_test_exam_session WHERE superseded_at IS NULL AND listening_started_at IS NOT NULL AND listening_submitted_at IS NULL AND listening_deadline_at>now()),
      'reading_active',(SELECT count(*) FROM assessment.term_test_attempt WHERE superseded_at IS NULL AND reading_started_at IS NOT NULL AND reading_submitted_at IS NULL AND reading_deadline_at>now()),
      'writing_active',(SELECT count(*) FROM assessment.term_test_attempt WHERE superseded_at IS NULL AND writing_started_at IS NOT NULL AND writing_submitted_at IS NULL AND writing_deadline_at>now()),
      'grading_leased',(SELECT count(*) FROM assessment.term_test_writing_grading_job WHERE status='processing' AND lease_until>now()),
      'grading_due',(SELECT count(*) FROM assessment.term_test_writing_grading_job WHERE (status IN ('queued','retry_wait') AND next_attempt_at<=now()) OR (status='processing' AND lease_until<=now() AND next_attempt_at<=now())),
      'grading_pending_all',(SELECT count(*) FROM assessment.term_test_writing_grading_job WHERE status IN ('queued','retry_wait','processing')),
      'portal_jobs',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM assessment.term_test_portal_sync_job GROUP BY status) x),
      'attempts',(SELECT count(*) FROM assessment.term_test_attempt),
      'mini_results',(SELECT count(*) FROM assessment.mini_test_result),
      'jobs',(SELECT count(*) FROM assessment.term_test_writing_grading_job),
      'last_attempt_update',(SELECT max(updated_at) FROM assessment.term_test_attempt),
      'last_mini_update',(SELECT max(updated_at) FROM assessment.mini_test_result))""")
    workflows=[]
    for profile,identity in [('default','DHUgPXJdCfVZWj56'),('default','SGtuBV91Yc9oxEVt'),('izone-ai','NFgOTzvfzfjwqY9x')]:
        workflows.append({'profile':profile,**p.ctl(profile,'workflow','get',identity,'--jq','{id,name,versionId,active}',label='cutover-source-'+identity)})
    executing=[]
    for identity in ['DHUgPXJdCfVZWj56','SGtuBV91Yc9oxEVt']:
        for status_name in ['running','waiting']:
            result=p.ctl('default','execution','list','--workflow',identity,'--status',status_name,'--limit','20',
              label='cutover-executions-'+identity+'-'+status_name)
            # Chỉ cấu trúc/count; dữ liệu execution được giữ trong journal riêng.
            executing.append({'workflow_id':identity,'status':status_name,
              'shape':list(result) if isinstance(result,dict) else type(result).__name__,
              'count':len(result) if isinstance(result,list) else None,
              'array_sizes':{k:len(v) for k,v in result.items() if isinstance(v,list)} if isinstance(result,dict) else {}})
    sftp=client.open_sftp()
    try:
        raw=route.read(sftp,'/etc/nginx/sites-enabled/ducizone.conf').decode()
        # Chỉ hiện tên location/include; không hiện header/token hoặc các dòng khác.
        routes=[line.strip() for line in raw.splitlines() if re.match(r'^\s*(?:location\s|include\s)',line)]
        files=route.protected_files(sftp)
    finally:sftp.close()
    return {'outcome':'success','observed_at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
      'source':status,'source_workflows':workflows,'source_execution_inventory':executing,
      'nginx_locations_and_includes':routes,'protected_file_hashes':files}

def main():
    sys.stdout.reconfigure(encoding='utf-8');PRIVATE.mkdir(parents=True,exist_ok=True)
    u=load('redis_util','prepare-redis-fixture.py');source=load('context_source','prepare-context-source.py')
    p=load('grading_provision','provision-grading-bundle.py');route=load('context_route','prepare-k67-route.py');client=u.connect()
    try:result=inspect(u,source,p,route,client)
    finally:client.close()
    path=PRIVATE/('observation-'+uuid.uuid4().hex+'.json')
    with path.open('x',encoding='utf-8') as stream:json.dump(result,stream,ensure_ascii=False,indent=2)
    print(json.dumps({**result,'receipt':str(path)},ensure_ascii=False))

if __name__=='__main__':main()
