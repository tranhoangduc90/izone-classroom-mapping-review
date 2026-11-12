"""Build the scoped Mini K56 review-retention overlay."""
from hashlib import sha256
from pathlib import Path
import sys


OLD_SHA = '35ca9fa8b4fb8f263edb600b88ceab92cf517167bb7515bdd91a2aa576238896'
NEW_SHA = 'f17c206715eb71b688d65ed6e500e4b2a13662324abf3516fb10b248b17b49b0'
SOURCE = (Path(__file__).resolve().parents[1] / 'mini-k56-recovery-20261112'
          / 'overlay/src/mini-k56-recovery-core.mjs')


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Mini K56 source no longer matches the release patch')
    return source.replace(old, new, 1)


def build(destination):
    raw = SOURCE.read_bytes().replace(b'\r\n', b'\n')
    if sha256(raw).hexdigest() != OLD_SHA:
        raise ValueError('Mini K56 release baseline checksum changed')
    source = raw.decode('utf-8')
    source = replace_once(
        source,
        '   if(recovery.enabled(run))await recovery.assertIdentity(client,a.attempt_token,b,hash);',
        '   const recoveryEnabled=recovery.enabled(run);\n'
        '   if(recoveryEnabled)await recovery.assertIdentity(client,a.attempt_token,b,hash);',
    )
    source = replace_once(
        source,
        '   // For opted-in reviews the expiring hold is the only new copy of the sealed content.',
        '   // An opted-in review keeps content only in the expiring store, even if that store is full.',
    )
    source = replace_once(source, 'JSON.stringify(review&&hold?{}:b)',
                          'JSON.stringify(review&&recoveryEnabled?{}:b)')
    payload = source.encode('utf-8')
    if sha256(payload).hexdigest() != NEW_SHA:
        raise ValueError('Mini K56 review-retention overlay checksum changed')
    destination.write_bytes(payload)


if __name__ == '__main__':
    build(Path(sys.argv[1]))
