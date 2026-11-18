"""Stage the Mini browser grant in an exact captured K56 app overlay."""
from hashlib import sha256
from pathlib import Path
import json
import sys

def digest(data):
    return sha256(data).hexdigest()

def replace_once(text, old, new):
    assert text.count(old) == 1, old[:120]
    return text.replace(old, new, 1)

def stage(captured_app, target, expected_sha):
    app = captured_app.read_bytes()
    assert digest(app) == expected_sha
    assert not target.exists()
    code = app.decode()
    anchor = "import {mountTermJournal} from './exam-journal-runtime/adapters/term.mjs';"
    code = replace_once(code, anchor, anchor + """
const connectMiniK56BrowserCloud = process.env.K56_MINI_CBT_BROWSER_POLICY_FILE
  ? (await import('./mini-k56-browser-cloud/connect.mjs').catch(() => ({}))).connectMiniK56BrowserCloud
  : undefined;""")
    anchor = '  if (journalEnv.K56_TERM1_JOURNAL_POLICY_FILE) {'
    code = replace_once(code, anchor, """  if (journalEnv.K56_MINI_CBT_BROWSER_POLICY_FILE && deploymentProfile.family === 'k56') {
    try {
      if (!connectMiniK56BrowserCloud || !termJournal?.journal) throw Error('K56_MINI_BROWSER_PILOT_UNAVAILABLE');
      connectMiniK56BrowserCloud(app, { pool, journal: termJournal.journal, allowedOrigins: config.allowedOrigins, env: journalEnv });
    } catch {
      logger.warn?.(JSON.stringify({ type: 'exam_journal_startup', code: 'K56_MINI_BROWSER_PILOT_UNAVAILABLE' }));
    }
  }
""" + anchor)
    source = Path(__file__).resolve().parent
    files = {'app.js': code.encode(), **{
        f'mini-k56-browser-cloud/{name}': (source/name).read_bytes() for name in ('connect.mjs', 'mount.mjs')
    }}
    target.mkdir()
    (target/'mini-k56-browser-cloud').mkdir()
    for name, data in files.items():
        (target/name).write_bytes(data)
    hashes = {name: digest(data) for name, data in files.items()}
    build = digest(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode())[:40]
    return {'baseAppSha256': expected_sha, 'files': hashes, 'build': build,
            'databaseMigration': 'enrollment.sql', 'nativeOverlayChanged': False}

if __name__ == '__main__':
    app, output, expected = sys.argv[1:]
    print(json.dumps(stage(Path(app), Path(output), expected), indent=2))
