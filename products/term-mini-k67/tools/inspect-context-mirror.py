"""Chỉ đọc mirror hiện có; giữ hash/tuổi snapshot để phân biệt lỗi đối soát.
Không in dữ liệu người/lớp, không tạo hoặc cập nhật container/database.
"""
from pathlib import Path
import importlib.util
import json
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def main():
    sys.stdout.reconfigure(encoding='utf-8');u=load('redis_util','prepare-redis-fixture.py')
    mirror=load('context_mirror','prepare-context-mirror.py');client=u.connect()
    try:result=mirror.observe(u,client)
    finally:client.close()
    path=mirror.PRIVATE/('observation-'+uuid.uuid4().hex+'.json')
    with path.open('x',encoding='utf-8') as stream:json.dump(result,stream,ensure_ascii=False,indent=2)
    print(json.dumps({'observation':result,'receipt':str(path)},ensure_ascii=False))
    return 0 if result.get('ready') else 1


if __name__=='__main__':sys.exit(main())
