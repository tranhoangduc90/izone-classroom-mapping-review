"""Nhận source exact live; chỉ thêm import/mount đọc biên nhận, giữ các thay đổi ngoài gói."""
from pathlib import Path
import sys
source=Path(sys.argv[1]);dest=Path(sys.argv[2]);k67=sys.argv[3]=='k67'
text=source.read_text(encoding='utf-8')
if 'mountSubmissionStatus' in text:raise RuntimeError('already_patched')
anchor="  app.get('/api/term-tests/roster',"
if text.count(anchor)!=1:raise RuntimeError('mount_anchor_not_unique')
imports="import { mountSubmissionStatus } from './submission-status.mjs';\n"
if k67:imports+="import { assertAudioOwner as assertSubmissionOwner } from './audio-owner.js';\n"
mount="  mountSubmissionStatus(app, { pool, limiter: testReadLimiter"+(", assertOwner: assertSubmissionOwner" if k67 else "")+" });\n\n"
text=imports+text.replace(anchor,mount+anchor,1)
dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(text,encoding='utf-8')
