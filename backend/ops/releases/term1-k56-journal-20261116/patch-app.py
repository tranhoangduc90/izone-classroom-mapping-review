"""Mount the K56 journal switches beside the existing product adapter."""
from pathlib import Path
import sys


IMPORT = "import {mountTermJournal} from './exam-journal-runtime/adapters/term.mjs';"
NATIVE = ("  const termJournal=mountTermJournal(app,{config,pool,productId:process.env.EXAM_JOURNAL_PRODUCT_ID || "
          "'term-mini-k56',schema:process.env.EXAM_JOURNAL_ASSESSMENT_SCHEMA || 'assessment_k56',"
          "logger,journal:examJournal,lookupQuery:journalLookupQuery,env:journalEnv});")


def _switch(term):
    return f"""
const mountK56Term{term}Cloud = process.env.K56_TERM{term}_JOURNAL_POLICY_FILE
  ? (await import('./term1-journal-cloud/mount.mjs').catch(() => ({{}}))).mountK56Term{term}Cloud
  : undefined;
"""


def _mount(term):
    return f"""
  if (journalEnv.K56_TERM{term}_JOURNAL_POLICY_FILE) {{
    try {{
      if (!mountK56Term{term}Cloud || !termJournal?.journal) throw Error('K56_TERM{term}_JOURNAL_PILOT_UNAVAILABLE');
      mountK56Term{term}Cloud(app,{{pool,journal:termJournal.journal,allowedOrigins:config.allowedOrigins,env:journalEnv}});
    }} catch {{
      logger.warn?.(JSON.stringify({{type:'exam_journal_startup',code:'K56_TERM{term}_JOURNAL_PILOT_UNAVAILABLE'}}));
    }}
  }}
"""


def patch(source):
    if source.count(IMPORT) != 1 or source.count(NATIVE) != 1:
        raise ValueError('K56_JOURNAL_NATIVE_WIRING_CHANGED')
    # A live Term 1 overlay already has the two markers. Leave its source bytes intact.
    for term in (1, 2):
        switch, mount = _switch(term), _mount(term)
        occurrences = source.count(switch), source.count(mount)
        if occurrences == (1, 1):
            continue
        if occurrences != (0, 0) or f'const mountK56Term{term}Cloud' in source:
            raise ValueError('K56_JOURNAL_EXISTING_MOUNT_DRIFT')
        anchor_import = IMPORT if term == 1 else _switch(1)
        anchor_mount = NATIVE if term == 1 else _mount(1)
        source = source.replace(anchor_import, anchor_import + switch)
        source = source.replace(anchor_mount, anchor_mount + mount)
    return source


if __name__ == '__main__':
    original, candidate = map(Path, sys.argv[1:])
    with candidate.open('x', encoding='utf8', newline='\n') as out:
        out.write(patch(original.read_text(encoding='utf8')))
