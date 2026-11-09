"""Reproduce and verify the demo source overlay from the pinned live baseline."""
from hashlib import sha256
import json
from pathlib import Path
import sys

release = Path(__file__).resolve().parent
source, target = (Path(arg) for arg in sys.argv[1:])
hashes = json.loads((release / 'source-hashes.json').read_bytes())
edits = json.loads((release / 'runtime.edits.json').read_bytes())
assert set(edits) == set(hashes['base'])
assert set(hashes['overlay']) == set(edits) | {p.name for p in (release / 'overlay').iterdir()}
target.mkdir(parents=True, exist_ok=True)
for name, expected in hashes['overlay'].items():
    assert Path(name).name == name
    if name in edits:
        original = (source / name).read_bytes()
        assert sha256(original).hexdigest() == hashes['base'][name], name
        lines = original.decode().replace('\r\n', '\n').splitlines(keepends=True)
        for edit in reversed(edits[name]):
            lines[edit['start']:edit['stop']] = [edit['text']]
        content = ''.join(lines).encode()
    else:
        content = (release / 'overlay' / name).read_bytes()
    assert sha256(content).hexdigest() == expected, name
    (target / name).write_bytes(content)
print('Verified overlay files:', len(hashes['overlay']))
