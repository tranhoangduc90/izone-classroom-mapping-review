"""Bộ nhỏ giữ scope Nginx và bảo toàn file bị trao đổi khi chuyển K67.

Nhận bytes cấu hình; chỉ thêm một include vào server443 đúng hostname. Hàm
trao đổi giữ bản thực sự lấy ra, không giả rằng kiểm hash rồi rename là CAS.
Khi bản trước đã đổi, trao đổi trả lại nếu đích còn đúng bản của task;
không xóa file và không tự hòa giải nội dung của bên khác.
"""
import ctypes
import hashlib
import os
import re
import stat

HOST='ducizone.ddns.net'
INCLUDE='/etc/nginx/snippets/term-mini-k67-legacy-routes.conf'
ANCHOR='include /etc/nginx/snippets/izone-k56-route.conf;'

def sha(raw):return hashlib.sha256(raw).hexdigest()

def structural(text):
    # Bỏ comment/chuỗi chỉ để đếm ngoặc. Giữ vị trí byte ký tự, không sửa input.
    chars=list(text);quote=None;comment=False;escaped=False
    for i,char in enumerate(text):
        if comment:
            if char=='\n':comment=False
            else:chars[i]=' '
        elif quote:
            chars[i]=' '
            if escaped:escaped=False
            elif char=='\\':escaped=True
            elif char==quote:quote=None
        elif char=='#':comment=True;chars[i]=' '
        elif char in ['"',"'"]:quote=char;chars[i]=' '
    if quote:raise RuntimeError('NGINX_UNCLOSED_QUOTE')
    return ''.join(chars)

def add_include(raw):
    text=raw.decode('utf-8');clean=structural(text);matches=[]
    if INCLUDE in text:raise RuntimeError('K67_NGINX_INCLUDE_ALREADY_PRESENT')
    for start in re.finditer(r'\bserver\s*\{',clean):
        depth=1;index=start.end()
        while depth and index<len(clean):
            if clean[index]=='{':depth+=1
            elif clean[index]=='}':depth-=1
            index+=1
        if depth:raise RuntimeError('NGINX_SERVER_UNBALANCED')
        segment=clean[start.end():index-1]
        if re.search(r'\blisten\s+443\s+ssl(?:\s|;)',segment) and re.search(r'\bserver_name\s+'+re.escape(HOST)+r'\s*;',segment):
            matches.append((start.end(),index-1))
    if len(matches)!=1:raise RuntimeError('K67_NGINX_TARGET_SERVER_AMBIGUOUS')
    start,end=matches[0]
    found=list(re.finditer(r'(?m)^([ \t]*)'+re.escape(ANCHOR)+r'[ \t]*$',clean[start:end]))
    if len(found)!=1:raise RuntimeError('K67_NGINX_ANCHOR_AMBIGUOUS')
    match=found[0];position=start+match.start()
    prefix=clean[start:position]
    if prefix.count('{')!=prefix.count('}'):raise RuntimeError('K67_NGINX_ANCHOR_NOT_DIRECT')
    indent=text[position:position+len(match.group(1))]
    desired=text[:position]+indent+'include '+INCLUDE+';\n'+text[position:]
    if desired.replace(indent+'include '+INCLUDE+';\n','',1)!=text:raise RuntimeError('K67_NGINX_INSERTION_CHANGED_OTHER_BYTES')
    return desired.encode('utf-8')

def proxy(prefix,target,mini=False):
    header='        proxy_set_header x-mini-test-sync $k67_legacy_mini_key;\n' if mini else ''
    return ('    location '+prefix+' {\n'
      '        client_max_body_size 1m;\n'
      '        proxy_connect_timeout 3s;\n'
      '        proxy_read_timeout 75s;\n'
      '        proxy_send_timeout 30s;\n'
      '        proxy_buffering off;\n'
      '        proxy_set_header Host $host;\n'
      '        proxy_set_header X-Real-IP $remote_addr;\n'
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
      '        proxy_set_header X-Forwarded-Proto $scheme;\n'+header+
      '        proxy_pass http://127.0.0.1:8796'+target+';\n'
      '    }\n')

def legacy_routes(intent,hold):
    if not re.fullmatch('[0-9a-f]{32}',intent):raise RuntimeError('K67_NGINX_INTENT_INVALID')
    result='# PRODUCT-TERM-MINI-K67 legacy routes; intent '+intent+'\n'
    if hold:
        for scope in ['^~ /mapping-api/api/term-tests/','= /mapping-api/api/mini-tests/results','^~ /term-mini-k67-api/']:
            result+='    location '+scope+' { add_header Retry-After 10 always; return 503; }\n'
    else:
        result+=('    location ^~ /mapping-api/api/term-tests/teacher/ {\n'
          '        default_type application/json;\n'
          '        return 409 \'{"ok":false,"error":"K67_BACKEND_MOVED","message":"Vui lòng tải lại trang Term Test để đăng nhập hệ thống K67 mới."}\';\n'
          '    }\n')
        result+=proxy('^~ /mapping-api/api/term-tests/','/api/term-tests/')
        result+=proxy('= /mapping-api/api/mini-tests/results','/api/mini-tests/results',mini=True)
        result+=proxy('^~ /term-mini-k67-api/','/')
    return result.encode('utf-8')

def legacy_map(intent,old,new):
    if not re.fullmatch('[0-9a-f]{32}',intent) or any(not re.fullmatch('[A-Za-z0-9_-]{32,100}',value) for value in [old,new]):
        raise RuntimeError('K67_MINI_COMPATIBILITY_SECRET_INVALID')
    # Chỉ khóa cũ được đổi; default rỗng nên API vẫn trả401. File này riêng tư600.
    return ('# PRODUCT-TERM-MINI-K67 Mini compatibility; intent '+intent+'\n'
      'map $http_x_mini_test_sync $k67_legacy_mini_key {\n'
      '    default "";\n'
      '    ~^'+old+'$ "'+new+'";\n'
      '}\n').encode()

def read_regular(path):
    info=os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('K67_NGINX_FILE_OWNER_UNKNOWN')
    with open(path,'rb') as stream:return stream.read()

def exchange_files(left,right):
    # Linux đổi hai directory entries nguyên tử; cả hai inode đều được giữ.
    libc=ctypes.CDLL(None,use_errno=True)
    operation=libc.renameat2;operation.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    if operation(-100,os.fsencode(left),-100,os.fsencode(right),2)!=0:
        raise OSError(ctypes.get_errno(),'K67_NGINX_EXCHANGE_FAILED')

def guarded_exchange(target,staged,expected_before,expected_after):
    if sha(read_regular(staged))!=expected_after:raise RuntimeError('K67_NGINX_STAGED_CHANGED')
    exchange_files(target,staged)
    captured=read_regular(staged);current=read_regular(target)
    if sha(captured)!=expected_before:
        if sha(current)!=expected_after:raise RuntimeError('K67_NGINX_CONCURRENT_CHANGE_PRESERVED_UNKNOWN')
        exchange_files(target,staged)
        if read_regular(target)!=captured:raise RuntimeError('K67_NGINX_RESTORE_READBACK_UNKNOWN')
        if sha(read_regular(staged))!=expected_after:raise RuntimeError('K67_NGINX_CONCURRENT_ROLLBACK_PRESERVED_UNKNOWN')
        raise RuntimeError('K67_NGINX_PREVIOUS_CHANGED_RESTORED')
    if sha(current)!=expected_after:raise RuntimeError('K67_NGINX_CURRENT_CHANGED_PRESERVED_UNKNOWN')
    return {'before_sha256':sha(captured),'after_sha256':sha(current),'captured_path':staged}
