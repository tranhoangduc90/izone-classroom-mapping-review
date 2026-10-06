"""Chạy bộ kiểm giao diện K67 trên worktree riêng và giữ kết quả gốc.
Nhận source hiện hành; output ngắn chỉ trạng thái/đường log, không đổi mã lỗi
để làm đẹp kết quả. Ca trình duyệt dùng dữ liệu mô phỏng của bộ test.
"""
from pathlib import Path
from datetime import datetime,timezone
import hashlib
import json
import subprocess
import sys
import uuid

PAGES=Path('E:/wt/k67-backend-separation-20261006/pages')
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/pages-verification')


def digest(raw):return hashlib.sha256(raw).hexdigest()


def fingerprint():
    # Ghim toàn bộ source/trình kiểm trong các thư mục tác động; không ghi dữ liệu.
    files=[]
    for name in ['term-tests','shared','tests','scripts']:
        files.extend(path for path in (PAGES/name).rglob('*') if path.is_file() and '.git' not in path.parts)
    return {str(path.relative_to(PAGES)).replace('\\','/'):digest(path.read_bytes()) for path in sorted(files)}


def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True);PRIVATE.mkdir(parents=True,exist_ok=True)
    identity='pages-'+uuid.uuid4().hex;before=fingerprint()
    argv=['node','scripts/run-term-test-67-regression.mjs','--all']
    result=subprocess.run(argv,cwd=PAGES,capture_output=True,timeout=240)
    after=fingerprint();out=PRIVATE/(identity+'.stdout.log');err=PRIVATE/(identity+'.stderr.log')
    out.write_bytes(result.stdout);err.write_bytes(result.stderr)
    passed=result.returncode==0 and before==after
    record={'observed_at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
        'command':argv,'cwd':str(PAGES),'exit_code':result.returncode,'outcome':'passed' if passed else 'failed',
        'source_before':before,'source_after':after,'source_unchanged':before==after,
        'stdout':{'path':str(out),'sha256':digest(result.stdout)},'stderr':{'path':str(err),'sha256':digest(result.stderr)}}
    receipt=PRIVATE/(identity+'.json')
    with receipt.open('x',encoding='utf-8') as stream:json.dump(record,stream,ensure_ascii=False,indent=2)
    print(json.dumps({'outcome':record['outcome'],'exit_code':result.returncode,'source_unchanged':before==after,
        'receipt':str(receipt),'stdout':str(out),'stderr':str(err)},ensure_ascii=False))
    return 0 if passed else 1


if __name__=='__main__':sys.exit(main())
