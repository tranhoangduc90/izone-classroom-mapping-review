"""Build the fallback Listening overlay from the exact inspected live modules."""
from argparse import ArgumentParser
from hashlib import sha256
import json
from pathlib import Path

parser = ArgumentParser(description=__doc__)
parser.add_argument('live_src', type=Path)
parser.add_argument('overlay_src', type=Path)
args = parser.parse_args()
source, target = args.live_src.resolve(), args.overlay_src.resolve()
if source == target:
    raise SystemExit('Choose a separate overlay output directory.')
here = Path(__file__).resolve().parent
manifest = json.loads((here / 'manifest.json').read_text(encoding='utf-8'))
edits = json.loads((here / 'edits.json').read_text(encoding='utf-8'))
result = {}
for filename, changes in edits.items():
    original = (source / filename).read_bytes()
    if sha256(original).hexdigest() != manifest['files'][filename]:
        raise SystemExit('Live source mismatch: ' + filename)
    code = original.decode().replace('\r\n', '\n')
    for before, after in changes:
        if code.count(before) != 1:
            raise SystemExit('Expected one source location: ' + filename)
        code = code.replace(before, after, 1)
    payload = code.encode()
    if sha256(payload).hexdigest() != manifest['patched'][filename]:
        raise SystemExit('Unexpected patched source: ' + filename)
    result[filename] = payload
target.mkdir(parents=True, exist_ok=True)
for filename, payload in result.items():
    output = target / filename
    if output.exists() and output.read_bytes() != payload:
        raise SystemExit('Overlay already contains different bytes: ' + filename)
    output.write_bytes(payload)
print(json.dumps(manifest['patched'], sort_keys=True))
