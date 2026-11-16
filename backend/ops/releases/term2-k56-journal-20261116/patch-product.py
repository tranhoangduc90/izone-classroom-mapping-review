"""Backport the optional route scope check to the installed K56 journal runtime."""
from pathlib import Path
import sys


def patch(source):
    original = '  async function collect(input) {'
    signature = '  async function collect(input, { testSlug } = {}) {'
    if source.count(original) != 1:
        if source.count(signature) == 1 and source.count(
                "requireValue(!testSlug || claims.scope.testSlug === testSlug, 'JOURNAL_SCOPE_DENIED', 403)") == 1:
            return source
        raise ValueError('K56_JOURNAL_COLLECT_SIGNATURE_CHANGED')
    anchor = "      rate('collect:' + sha(claims.scope), 90);"
    if source.count(anchor) != 1:
        raise ValueError('K56_JOURNAL_AUTHORIZE_ANCHOR_CHANGED')
    gate = "      requireValue(!testSlug || claims.scope.testSlug === testSlug, 'JOURNAL_SCOPE_DENIED', 403);\n"
    return source.replace(original, signature).replace(anchor, gate + anchor)


if __name__ == '__main__':
    source, target = map(Path, sys.argv[1:])
    with target.open('x', encoding='utf-8', newline='\n') as output:
        output.write(patch(source.read_text(encoding='utf-8')))
