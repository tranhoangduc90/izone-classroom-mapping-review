"""Build the four-file K56 Term R2 overlay from the live source and tracked catalogs."""
import argparse
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
BASE_RELEASE = HERE.parent / 'term1-offline-20261107'
SIGNER = REPO / 'products/listening-practice/src/audio-r2.js'
ASSETS = HERE.parent / 'audio-cloudflare-20261023/catalog.mjs'
SLUGS = ('term-test-1-k56', 'term-test-2-k56')


def build(src, out):
    core = (src / 'k56-offline-core.mjs').read_text(encoding='utf-8')
    base = (BASE_RELEASE / 'k56-offline-core.mjs').read_text(encoding='utf-8')
    if core != base:
        raise ValueError('Live offline receiver differs from the Term 1 release')
    for name in ('audio-r2.js', 'r2-audio-catalog.json', 'k56-term-audio-r2.mjs'):
        if (src / name).exists():
            raise ValueError(f'Unexpected existing runtime source {name}')

    def edit(old, new):
        nonlocal core
        if core.count(old) != 1:
            raise ValueError(f'Missing or ambiguous patch anchor {old}')
        core = core.replace(old, new)

    edit("import {z} from 'zod';", "import {z} from 'zod';\nimport {issueK56TermAudio} from './k56-term-audio-r2.mjs';")
    edit("mode:z.enum(['lis_first','read_first'])", "mode:z.enum(['lis_first','read_first']),audioTransport:z.literal('r2-direct-v1').optional()")
    edit('  const run=await transaction(async client=>{', '  const {run,audioDownload}=await transaction(async client=>{')
    edit('   return row;\n  });', "   if(row.session_id!==body.examSessionToken||Number(row.generation)!==body.generation||row.policy!==POLICY)throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi chưa khớp.',403);\n   return {run:row,audioDownload:issueK56TermAudio(current,body.audioTransport)};\n  });")
    edit('res.json({...serialize(a),content,timing,offline:', 'res.json({...serialize(a),content,timing,...(audioDownload?{audioDownload}:{}),offline:')

    assets = json.loads(ASSETS.read_text(encoding='utf-8').split('export const ASSETS = ', 1)[1].strip().removesuffix(';'))
    catalog = {assets[slug]['sha256']: assets[slug] for slug in SLUGS}
    manifests = json.loads((src / 'k56-public-audio-catalog.json').read_text(encoding='utf-8'))
    for asset in catalog.values():
        pinned = manifests[asset['id']]
        assert pinned['envelopeVersion'] == 'MP3'
        assert all(pinned[key] == asset[key] for key in ('url', 'byteLength', 'sha256'))
    files = {
        'k56-offline-core.mjs': core,
        'audio-r2.js': SIGNER.read_text(encoding='utf-8'),
        'k56-term-audio-r2.mjs': (HERE / 'k56-term-audio-r2.mjs').read_text(encoding='utf-8'),
        'r2-audio-catalog.json': json.dumps(catalog, indent=2) + '\n',
    }
    out.mkdir(parents=True, exist_ok=False)
    for name, source in files.items():
        (out / name).write_text(source, encoding='utf-8', newline='\n')
    print(json.dumps({name: hashlib.sha256((out / name).read_bytes()).hexdigest() for name in files}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('src', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    build(args.src, args.out)
