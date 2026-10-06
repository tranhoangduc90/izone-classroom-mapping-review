"""Dựng ảnh chạy Term/Mini K67 từ source/lockfile/base đã ghim.

Không dùng ảnh backend chung làm base, không khởi động/dựng lại dịch vụ đang
chạy. Chỉ đóng gói Dockerfile, package và src; ghi hash và log dựng riêng.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import io
import json
import shlex
import sys
import tarfile
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-image')
STATE=PRIVATE/'state.json'
PRODUCT='PRODUCT-TERM-MINI-K67'


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def sha(raw):return hashlib.sha256(raw).hexdigest()


def prepare(u,h,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    files={name:(ROOT/name).read_bytes() for name in ['Dockerfile','package.json','package-lock.json']}
    files.update({file.relative_to(ROOT).as_posix():file.read_bytes() for file in sorted((ROOT/'src').glob('*.js'))})
    hashes={name:sha(raw) for name,raw in files.items()}
    revision=sha(json.dumps(hashes,sort_keys=True).encode())
    tag='term-mini-k67:release-'+revision[:16]
    if STATE.exists():
        state=json.loads(STATE.read_text(encoding='utf-8'))
        if state['source_hashes']!=hashes or state['tag']!=tag:raise RuntimeError('K67_IMAGE_SOURCE_CHANGED')
    else:
        state={'intent':uuid.uuid4().hex,'source_hashes':hashes,'revision':revision,'tag':tag,'stage':'intent'}
        h.atomic(STATE,state)
    labels={'com.izone.product':PRODUCT,'com.izone.purpose':'production-release-v1',
        'com.izone.intent':state['intent'],'com.izone.source':revision}
    existing=u.remote(client,['docker','image','ls','-q','--no-trunc',tag]).decode().strip()
    if not existing:
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w') as archive:
            for name,raw in files.items():
                info=tarfile.TarInfo(name);info.size=len(raw);info.mode=0o644;info.mtime=0
                archive.addfile(info,io.BytesIO(raw))
        raw=stream.getvalue();archive_path=PRIVATE/'source.tar'
        if archive_path.exists():
            if archive_path.read_bytes()!=raw:raise RuntimeError('K67_IMAGE_ARCHIVE_CHANGED')
        else:
            with archive_path.open('xb') as target:target.write(raw)
        argv=['docker','build','--tag',tag]
        for key,value in labels.items():argv+=['--label',key+'='+value]
        argv+=['-'];state['stage']='build_intent';h.atomic(STATE,state)
        incoming,out,error=client.exec_command(shlex.join(argv),timeout=180)
        incoming.write(raw);incoming.flush();incoming.channel.shutdown_write()
        stdout=out.read();stderr=error.read();code=out.channel.recv_exit_status();identity=uuid.uuid4().hex
        (PRIVATE/('build-'+identity+'.stdout.log')).write_bytes(stdout)
        (PRIVATE/('build-'+identity+'.stderr.log')).write_bytes(stderr)
        with (PRIVATE/('build-'+identity+'.json')).open('x',encoding='utf-8') as target:
            json.dump({'command':argv,'exit_code':code,'archive_sha256':sha(raw),
                'stdout_sha256':sha(stdout),'stderr_sha256':sha(stderr),'source_revision':revision},target,indent=2)
        if code:raise RuntimeError('K67_IMAGE_BUILD_EXIT_'+str(code))
    image=json.loads(u.remote(client,['docker','image','inspect',tag]))[0]
    if any(image['Config'].get('Labels',{}).get(key)!=value for key,value in labels.items()) \
        or image['Config']['User']!='node' or image['Config']['Cmd']!=['node','src/server.js']:
        raise RuntimeError('K67_IMAGE_IDENTITY_MISMATCH')
    # Kiểm source bên trong ảnh qua container một lần riêng, không có credential,
    # network, asset, DB hoặc lệnh npm start; --rm chỉ bỏ container đọc tạm này.
    expected={name:value for name,value in hashes.items() if name!='Dockerfile'}
    proof=u.remote(client,['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',
        '--security-opt','no-new-privileges','--cpus','0.25','--memory','128m','--pids-limit','64',
        image['Id'],'sha256sum',*expected]).decode()
    observed={line.split(None,1)[1].strip():line.split()[0] for line in proof.splitlines()}
    # Dockerfile dùng để dựng không nằm trong ảnh; chỉ kiểm các file đã COPY.
    if observed!=expected:raise RuntimeError('K67_IMAGE_SOURCE_READBACK_MISMATCH')
    state['image']=image['Id'];state['stage']='release_image_verified';h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'image':image['Id'],'source_revision':revision,
        'files':len(expected),'learner_cutover':False}


def main():
    argparse.ArgumentParser(description=__doc__).parse_args();sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    guard=load('context_guard','prepare-context-source.py');client=u.connect()
    try:return guard.run_guarded(u,h,client,lambda:prepare(u,h,client),PRIVATE,caller_path=Path(__file__))
    finally:client.close()


if __name__=='__main__':sys.exit(main())
