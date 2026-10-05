"""Đổi chủ thực thi bằng so khớp trạng thái đã đọc, giữ khóa mỗi generation.
Không dùng tuổi phiên hay xóa khóa để nhận lại. Claim mất phản hồi phải đối soát.
"""
import hashlib
import json
import os
import uuid
from pathlib import Path

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def sync_directory(path):
    if os.name!='nt':
        descriptor=os.open(path,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)

def save_exclusive(path,value):
    with Path(path).open('x',encoding='utf-8') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2)
        stream.flush();os.fsync(stream.fileno())
    sync_directory(Path(path).parent)

def replace_durable(path,value):
    path=Path(path);temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.new')
    save_exclusive(temporary,value)
    os.replace(temporary,path)
    sync_directory(path.parent)

def claim(path,expected_raw_sha256,expected_generation,new_state,guard):
    """Guard xác minh sender cũ dừng và dữ liệu gắn phiên; chạy lại sau khóa CAS."""
    path=Path(path)
    def inspect():
        raw=path.read_bytes();state=json.loads(raw)
        if sha(raw)!=expected_raw_sha256 or state.get('generation')!=expected_generation:
            raise RuntimeError('acceptance_cas_state_changed')
        if new_state.get('generation')!=expected_generation+1:
            raise RuntimeError('acceptance_cas_next_generation_invalid')
        guard(state)
        return state
    inspect()
    # Mọi sender cạnh tranh cùng generation dùng cùng tên, chỉ một bên tạo được.
    lock=path.with_name(path.name+'.cas-generation-'+str(expected_generation)+'.json')
    save_exclusive(lock,{'expected_sha256':expected_raw_sha256,'expected_generation':expected_generation,'new_state':new_state,'pid':os.getpid()})
    previous=inspect()
    save_exclusive(path.with_name(path.name+'.generation-'+str(expected_generation)+'.json'),previous)
    replace_durable(path,new_state)
    return previous
