"""Chỉ đọc workflow bị báo thay đổi; hiện đường trường sai khác, không in giá trị.
Giữ snapshot riêng tư, không ghi đè baseline/candidate hoặc PUT workflow.
"""
import json
import sys
import uuid
from pathlib import Path
import importlib.util
ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def diff(a,b,path=''):
    if type(a)!=type(b):return [path+':type']
    if isinstance(a,dict):
        rows=[]
        for key in sorted(set(a)|set(b)):
            p=path+'/'+key
            rows+= [p+':presence'] if key not in a or key not in b else diff(a[key],b[key],p)
        return rows
    if isinstance(a,list):
        if len(a)!=len(b):return [path+':length']
        return [p for i,(x,y) in enumerate(zip(a,b)) for p in diff(x,y,path+'/'+str(i))]
    return [] if a==b else [path+':value']
def main():
    sys.stdout.reconfigure(encoding='utf-8');g=load('production_grading','prepare-production-grading.py');p=load('grading_provision','provision-grading-bundle.py')
    source=sys.argv[1];rows=[(row,candidate) for row,candidate in g.inventory(p) if row['sourceId']==source]
    if len(rows)!=1:raise RuntimeError('OWN_SOURCE_NOT_FOUND')
    row,candidate=rows[0];state=json.loads(g.STATE.read_bytes());before=json.loads(Path(state['rows'][source]['before']).read_bytes())
    live=g.sdk(p,{'operation':'snapshot','profile':row['profile'],'sourceId':source},'production-grading-drift-'+source)['workflow']
    path=g.PRIVATE/('drift-'+source+'-'+uuid.uuid4().hex+'.private.json');g.immutable(path,live)
    print(json.dumps({'id':live['id'],'before_version':before['versionId'],'live_version':live['versionId'],
      'before_differences':diff(p.workflow_body(before),p.workflow_body(live)),
      'candidate_differences':diff(p.workflow_body(candidate),p.workflow_body(live)),
      'active':live['active'],'snapshot':str(path)},ensure_ascii=False))
if __name__=='__main__':main()
