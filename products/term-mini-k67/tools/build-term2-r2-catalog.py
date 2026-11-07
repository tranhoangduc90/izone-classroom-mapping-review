"""Pin Term 2's 512 KiB R2 chunks from an already verified local audio file."""
import hashlib
import json
import sys
from pathlib import Path

EXPECTED = '656921dc9888dcfe778eb0cfa6b61491fd906500edde28054d53d26194df219e'
NAME = 'term-test-2-96kbps-656921dc9888dcfe.mp3'
URL = 'https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k67-audio-assets/' + NAME
CATALOG = Path(__file__).resolve().parents[1] / 'src/r2-audio-catalog.json'

audio = Path(sys.argv[1])
if audio.name != NAME:
    raise SystemExit('Wrong Term 2 asset name')
data = audio.read_bytes()
if len(data) != 22119070 or hashlib.sha256(data).hexdigest() != EXPECTED:
    raise SystemExit('Term 2 audio bytes do not match public catalog')
catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
catalog[EXPECTED] = {
    'sha256': EXPECTED, 'byteLength': len(data), 'url': URL,
    'chunks': [{'byteLength': len(part), 'sha256': hashlib.sha256(part).hexdigest()}
               for offset in range(0, len(data), 524288)
               if (part := data[offset:offset + 524288])],
    'key': 'cf-chunks-lab/' + EXPECTED + '.mp3'
}
CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
