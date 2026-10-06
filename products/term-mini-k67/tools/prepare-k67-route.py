"""HTTPS K67 riêng, không sửa vhost/file của backend chung hay K56.

Chỉ tạo server mới trên cổng18869 trong conf.d wildcard đã xác minh; dùng
chứng chỉ hiện có qua filename, không đọc private key. Kiểm nginx trước reload,
đọc API/biên quyền và K56 sau. Lỗi vô hiệu đúng include riêng, không xóa file.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import re
import stat
import sys
import uuid
import requests

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/public-route')
STATE=PRIVATE/'state.json'
INCLUDE='/etc/nginx/conf.d/term-mini-k67-public.conf'
PORT='18869'
HOST='https://ducizone.ddns.net'
PUBLIC=HOST+':'+PORT
PROTECTED_FILES=['/etc/nginx/nginx.conf','/etc/nginx/sites-enabled/ducizone.conf']


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def sha(raw):return hashlib.sha256(raw).hexdigest()


def config(intent):
    return (f'# PRODUCT-TERM-MINI-K67 HTTPS; intent {intent}\n'
      'server {\n'
      '    listen 18869 ssl;\n'
      '    server_name ducizone.ddns.net;\n'
      '    ssl_certificate /etc/letsencrypt/live/ducizone.ddns.net/fullchain.pem;\n'
      '    ssl_certificate_key /etc/letsencrypt/live/ducizone.ddns.net/privkey.pem;\n'
      '    location = /term-mini-k67-context/v1/snapshot {\n'
      '        if ($request_method != GET) { return 405; }\n'
      '        proxy_connect_timeout 3s;\n'
      '        proxy_read_timeout 10s;\n'
      '        proxy_send_timeout 10s;\n'
      '        proxy_pass http://127.0.0.1:8798/v1/snapshot;\n'
      '    }\n'
      '    location / { return 404; }\n'
      '}\n').encode()


def read(sftp,path):
    info=sftp.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
        raise RuntimeError('K67_ROUTE_FILE_OWNER_UNKNOWN')
    with sftp.open(path,'rb') as stream:return stream.read()


def optional(sftp,path):
    try:return read(sftp,path)
    except FileNotFoundError:return None


def protected_files(sftp):return {path:sha(read(sftp,path)) for path in PROTECTED_FILES}


def health():
    checks={}
    for path in ['/mapping-api/health','/mapping-api-k56/health']:
        response=requests.get(HOST+path,timeout=15,allow_redirects=False)
        if response.status_code!=200:raise RuntimeError('PROTECTED_ROUTE_NOT_HEALTHY')
        checks[path]=response.status_code
    return checks


def verify(source):
    headers={'x-k67-context-key':source.secret_values()['api']}
    response=requests.get(PUBLIC+'/term-mini-k67-context/v1/snapshot',headers=headers,timeout=15,allow_redirects=False)
    if response.status_code!=200:raise RuntimeError('K67_CONTEXT_ROUTE_NOT_READY')
    raw=response.content;value=response.json()
    if value.get('productId')!='PRODUCT-TERM-MINI-K67' or value.get('apiVersion')!=1 or not 0<len(raw)<=1048576:
        raise RuntimeError('K67_CONTEXT_ROUTE_CONTRACT_INVALID')
    for path,method,code in [('/term-mini-k67-context/v1/snapshot','get',401),
        ('/term-mini-k67-context/v1/assessment','get',404),('/term-mini-k67-context/v1/snapshot','post',405),
        ('/mapping-api/health','get',404),('/term-mini-k67-api/health','get',404)]:
        result=getattr(requests,method)(PUBLIC+path,timeout=15,allow_redirects=False)
        if result.status_code!=code:raise RuntimeError('K67_CONTEXT_ROUTE_BOUNDARY_INVALID')
    return {'authenticated':200,'unauthorized':401,'foreign':404,'method':405,'shared_closed':404,
        'exam_closed':404,'bytes':len(raw),'counts':{k:len(value[k]) for k in ['classes','students','memberships','accounts','access']}}


def prepare(u,h,source,client):
    PRIVATE.mkdir(parents=True,exist_ok=True);before=health();sftp=client.open_sftp()
    try:
        protected_before=protected_files(sftp)
        nginx=read(sftp,PROTECTED_FILES[0])
        if nginx.count(b'include /etc/nginx/conf.d/*.conf;')!=1:raise RuntimeError('NGINX_CONF_D_INCLUSION_UNKNOWN')
        actual=optional(sftp,INCLUDE);disabled=optional(sftp,INCLUDE+'.disabled')
        if STATE.exists():
            state=json.loads(STATE.read_text(encoding='utf-8'))
            if not re.fullmatch('[0-9a-f]{32}',state['intent']) or state['include']!=INCLUDE:
                raise RuntimeError('K67_ROUTE_STATE_CHANGED')
        else:
            if actual is not None or disabled is not None or u.remote(client,['ss','-H','-ltn','sport = :'+PORT]).strip():
                raise RuntimeError('K67_ROUTE_COLLISION')
            state={'intent':uuid.uuid4().hex,'include':INCLUDE,'stage':'intent'};h.atomic(STATE,state)
        desired=config(state['intent'])
        if actual is not None and actual!=desired or disabled is not None and disabled!=desired:
            raise RuntimeError('K67_ROUTE_OWN_FILE_CHANGED')
        if actual is not None and disabled is not None:raise RuntimeError('K67_ROUTE_TWO_FILES_UNKNOWN')
        if actual is None:
            if u.remote(client,['ss','-H','-ltn','sport = :'+PORT]).strip():raise RuntimeError('K67_ROUTE_PORT_COLLISION')
            state['stage']='include_create_intent';h.atomic(STATE,state)
            if disabled is not None:sftp.rename(INCLUDE+'.disabled',INCLUDE)
            else:
                with sftp.open(INCLUDE,'wx') as stream:stream.write(desired)
                sftp.chmod(INCLUDE,0o644)
        if read(sftp,INCLUDE)!=desired:raise RuntimeError('K67_ROUTE_INCLUDE_READBACK')
        try:
            u.remote(client,['nginx','-t']);state['stage']='reload_intent';h.atomic(STATE,state)
            u.remote(client,['nginx','-s','reload'])
            checks=verify(source)
            if health()!=before or protected_files(sftp)!=protected_before or read(sftp,INCLUDE)!=desired:
                raise RuntimeError('K67_ROUTE_READBACK_MISMATCH')
        except Exception:
            # Cổng và file này chỉ thuộc intent K67; không sửa bất kỳ vhost chung.
            if read(sftp,INCLUDE)!=desired or optional(sftp,INCLUDE+'.disabled') is not None:
                raise RuntimeError('K67_ROUTE_ROLLBACK_OWNERSHIP_UNKNOWN')
            sftp.rename(INCLUDE,INCLUDE+'.disabled')
            u.remote(client,['nginx','-t']);u.remote(client,['nginx','-s','reload'])
            state['stage']='rolled_back_after_error';h.atomic(STATE,state)
            raise
        state['stage']='context_route_verified';state['checks']=checks;state['protected_files']=protected_before
        state['protected_routes']=before;h.atomic(STATE,state)
        return {'outcome':'success','stage':state['stage'],'public':PUBLIC,'checks':checks,
            'protected_files_unchanged':True,'protected_routes':before,'learner_cutover':False}
    finally:sftp.close()


def main():
    argparse.ArgumentParser(description=__doc__).parse_args();sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    source=load('context_guard','prepare-context-source.py');client=u.connect()
    try:return source.run_guarded(u,h,client,lambda:prepare(u,h,source,client),PRIVATE,with_catalog=True,caller_path=Path(__file__))
    finally:client.close()


if __name__=='__main__':sys.exit(main())
