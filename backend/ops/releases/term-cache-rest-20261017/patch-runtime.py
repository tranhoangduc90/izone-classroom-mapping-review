"""Ghép ba thay đổi roster vào app live; giữ mọi overlay K56 khác nguyên byte."""
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
raw = source.read_bytes()
newline = b'\r\n' if b'\r\n' in raw else b'\n'
changes = [
    (b"import crypto from 'node:crypto';", b"import crypto from 'node:crypto';\nimport { createPendingRoster } from './pending-roster.js';"),
    (b"  const app = express();", b"  const app = express();\n  const readRosterOnce = createPendingRoster();"),
    (b'    const result = await pool.query(listTermTestRosterSql, [parsed.data.class, parsed.data.test]);',
     b'    const result = await readRosterOnce(JSON.stringify([parsed.data.class, parsed.data.test]),\n      () => pool.query(listTermTestRosterSql, [parsed.data.class, parsed.data.test]));')
]
for before, after in changes:
    before, after = before.replace(b'\n', newline), after.replace(b'\n', newline)
    if raw.count(before) != 1:
        raise RuntimeError('Nguồn đã đổi: cần đối chiếu lại trước khi ghép cache.')
    raw = raw.replace(before, after)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(raw)
