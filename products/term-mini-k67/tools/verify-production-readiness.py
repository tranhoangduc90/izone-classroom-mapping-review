"""Đọc lại runtime, ngữ cảnh, asset và trạng thái workflow sau chuyển K67.

Không nộp bài, chạy AI, cập nhật workflow hay sửa cấu hình. Chỉ trả metadata;
khóa và hồ sơ người học được giữ trong bộ nhớ/bằng chứng riêng tư.
"""
from pathlib import Path
import importlib.util
import hashlib
import json
import sys
import requests

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/final-readiness')
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def check(ok,code):
    if not ok:raise RuntimeError(code)
def perform(u,h,s,db,app,q,mirror,route,p,client):
    image=json.loads((PRIVATE.parent/'production-image/state.json').read_bytes())
    # Kiểm K67 dựng lại từ env đã ghim mà không lấy secret nguồn chung.
    class OwnConfig:
        def remote(self,c,argv,*args,**kwargs):
            if argv==['docker','inspect','mapping-review-api']:raise RuntimeError('K67_CONFIG_STILL_COUPLED_TO_SOURCE')
            return u.remote(c,argv,*args,**kwargs)
    env=app.environment(OwnConfig(),h,db,client,image)
    app.verify(u,client,json.loads(app.STATE.read_bytes()),env)
    dbstate=json.loads(db.STATE.read_bytes());db.verify_container(u,client,dbstate);db.verify_schema(u,client,dbstate)
    q.verify(u,client,json.loads(q.STATE.read_bytes()))
    mirrored=mirror.observe(u,client);check(mirrored.get('ready') is True,'K67_FINAL_CONTEXT_NOT_READY')
    assets=json.loads((PRIVATE.parent/'ASSETS_AND_PAGES_INVENTORY_FINAL.json').read_bytes())['assets']['rows']
    # Hash tại VPS, chỉ trả metadata; tránh tải lại hơn 100 MB audio qua SFTP.
    script="""import hashlib,json,pathlib,sys
rows=json.load(sys.stdin);root=pathlib.Path('/opt/term-mini-k67/assets')
for row in rows:
 path=pathlib.PurePosixPath(row['path'])
 if path.is_absolute() or '..' in path.parts or len(path.parts)!=2:raise RuntimeError('ASSET_PATH_INVALID')
 file=root/path
 if file.is_symlink() or file.parent.is_symlink() or not file.is_file():raise RuntimeError('ASSET_FILE_CHANGED')
 raw=file.read_bytes()
 if len(raw)!=row['bytes'] or hashlib.sha256(raw).hexdigest()!=row['sha256']:raise RuntimeError('ASSET_HASH_CHANGED')
print(json.dumps({'verified':len(rows)}))
"""
    check(json.loads(u.remote(client,['python3','-c',script],json.dumps(assets).encode()))=={'verified':9},'K67_FINAL_ASSET_CHANGED')
    for path in ['/ready','/version']:
        response=requests.get(route.PUBLIC+'/term-mini-k67-api'+path,timeout=15,allow_redirects=False)
        check(response.status_code==200 and response.json()=={'ok':True,'build':{'version':'k67-20261006','sha':image['revision']}},'K67_FINAL_RUNTIME_NOT_READY')
    roster=requests.get(route.PUBLIC+'/term-mini-k67-api/api/term-tests/roster',params={'class':'CODEXDEMO806','test':'term-test-1'},headers={'Origin':'https://tranhoangduc90.github.io'},timeout=15)
    check(roster.status_code==200 and roster.json().get('ok') is True and roster.headers.get('Access-Control-Allow-Origin')=='https://tranhoangduc90.github.io','K67_FINAL_ROSTER_CORS_FAILED')
    observed={}
    for profile,identity,active in [('default','DHUgPXJdCfVZWj56',False),('default','SGtuBV91Yc9oxEVt',False),('izone-ai','NFgOTzvfzfjwqY9x',True),('default','pY437GnW09WmD9b2',True),('default','qj1aGCo406QsXtai',True),('izone-ai','nwp6ERqWKb2FkgFl',True)]:
        # GET với --jq của CLI hiện chọn sai instance ở izone-ai; lấy JSON đầy
        # đủ vào kho riêng tư rồi chiếu metadata, không đổi lỗi 404 thành pass.
        full=p.ctl(profile,'workflow','get',identity,label='final-workflow-full-readback')
        row={key:full.get(key) for key in ['id','active']}
        check(row=={'id':identity,'active':active},'K67_FINAL_WORKFLOW_ACTIVE_STATE_CHANGED');observed[identity]=active
    check(not u.remote(client,['ss','-H','-ltn','sport = :18870']).strip(),'K67_LEGACY_PROBE_LISTENER_REMAINED')
    return {'outcome':'success','learner_cutover':True,'runtime_ready':True,'source_key_not_read':True,'assets_verified':len(assets),
      'context_age_ms':mirrored['ageMs'],'context_counts':mirrored['counts'],'workflows':observed,'protected_routes':route.health(),'legacy_probe_closed':True}
def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True);PRIVATE.mkdir(parents=True,exist_ok=True)
    u=load('util','prepare-redis-fixture.py');h=load('http','prepare-http-fixture.py');s=load('guard','prepare-context-source.py')
    db=load('db','prepare-production-database.py');app=load('app','prepare-production-app.py');q=load('queue','prepare-production-queue.py')
    mirror=load('mirror','prepare-context-mirror.py');route=load('route','prepare-k67-route.py');p=load('grading','provision-grading-bundle.py')
    client=u.connect()
    try:return s.run_guarded(u,h,client,lambda:perform(u,h,s,db,app,q,mirror,route,p,client),PRIVATE,caller_path=Path(__file__))
    finally:client.close()
if __name__=='__main__':sys.exit(main())
