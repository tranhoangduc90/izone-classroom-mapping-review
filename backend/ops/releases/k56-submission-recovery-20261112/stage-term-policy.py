"""Build the K56 Term quota and export overlay from the current release bytes."""

import argparse
from hashlib import sha256
import json
from pathlib import Path


BASE = {
    'app.js': '9e54c80b562f5b8dd39575751d7e2f7a9402328290aac4b95df485d87e7b2e6c',
    'term1-submission-hold.mjs': 'ab82862bd3339e51530205fca2a3c57206bf3d6e50325454af1694f5bc0ef3c4',
}


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Expected a single K56 integration point')
    return text.replace(before, after, 1)


def patch_app(text):
    anchor = "import { mountSubmissionStatus } from './submission-status.mjs';"
    text = replace_once(text, anchor, anchor + "\nimport { createTermHoldExport } from './term-submission-policy.mjs';")
    anchor = '  mountExamClock(app,{pool,limiter:testReadLimiter});'
    return replace_once(text, anchor, anchor + """
  if (deploymentProfile.family === 'k56') {
    app.post('/api/term-tests/teacher/submission-hold/export', testReadLimiter, authenticate,
      asyncRoute(createTermHoldExport({ queryScoped: queryScopedTeacherRead, record: logTermTestEvent })));
  }
""".rstrip())


def patch_store(text):
    text = "import { countActiveTermHolds } from './term-submission-policy.mjs';\n" + text
    text = replace_once(text, 'mini ? env.K56_MINI_HOLD_CLASSES_FILE : undefined',
                        'mini ? env.K56_MINI_HOLD_CLASSES_FILE : env.K56_TERM_HOLD_SCOPE_FILE')
    text = replace_once(text, "      const scope = JSON.parse(readFileSync(classesFile, 'utf8')).classes;\n"
                        '      return scope === null ||',
                        "      const config = JSON.parse(readFileSync(classesFile, 'utf8'));\n"
                        '      const scope = mini ? config.classes : config[prefix];\n'
                        '      return (mini && scope === null) ||')
    start = text.index('    const quotaKey = ')
    end = text.index('    if (n >= Number(run.submission_hold_limit))', start)
    old = text[start:end]
    if "assessment.term_test_attempt" not in old or "pg_advisory_xact_lock" not in old:
        raise ValueError('Unexpected Mini quota implementation')
    mini = old.replace('const { rows: [{ n }] }', 'const { rows: [count] }')
    mini = ''.join('  ' + line for line in mini.splitlines(keepends=True))
    return text[:start] + ("    let n;\n    if (scopedToClass) {\n" + mini
        + "      n = count.n;\n    } else {\n      n = await countActiveTermHolds(db, product, attemptId);\n    }\n") + text[end:]


def build(source, destination):
    patchers = {'app.js': patch_app, 'term1-submission-hold.mjs': patch_store}
    output = {}
    for name, expected in BASE.items():
        data = (source / name).read_bytes()
        if sha256(data).hexdigest() != expected:
            raise ValueError(f'Unexpected base fingerprint for {name}')
        output[name] = patchers[name](data.decode('utf-8')).encode('utf-8')
    extra = 'term-submission-policy.mjs'
    output[extra] = Path(__file__).with_name(extra).read_bytes()
    destination.mkdir()
    for name, data in output.items():
        (destination / name).write_bytes(data)
    print(json.dumps({name: {'before': BASE.get(name), 'after': sha256(data).hexdigest()}
                      for name, data in output.items()}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    build(args.source, args.destination)
