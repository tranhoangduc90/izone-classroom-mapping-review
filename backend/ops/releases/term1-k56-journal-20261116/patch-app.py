"""Mount the K56 journal switch beside the existing product adapter."""
from pathlib import Path
import sys


def patch(source):
    anchor = "import {mountTermJournal} from './exam-journal-runtime/adapters/term.mjs';"
    assert source.count(anchor) == 1
    # Keep loading optional so an absent journal module cannot stop the exam API.
    source = source.replace(anchor, anchor + """
const mountK56Term1Cloud = process.env.K56_TERM1_JOURNAL_POLICY_FILE
  ? (await import('./term1-journal-cloud/mount.mjs').catch(() => ({}))).mountK56Term1Cloud
  : undefined;
""")
    anchor = "  const termJournal=mountTermJournal(app,{config,pool,productId:process.env.EXAM_JOURNAL_PRODUCT_ID || 'term-mini-k56',schema:process.env.EXAM_JOURNAL_ASSESSMENT_SCHEMA || 'assessment_k56',logger,journal:examJournal,lookupQuery:journalLookupQuery,env:journalEnv});"
    assert source.count(anchor) == 1
    return source.replace(anchor, anchor + """
  if (journalEnv.K56_TERM1_JOURNAL_POLICY_FILE) {
    try {
      if (!mountK56Term1Cloud || !termJournal?.journal) throw Error('K56_TERM1_JOURNAL_PILOT_UNAVAILABLE');
      mountK56Term1Cloud(app,{pool,journal:termJournal.journal,allowedOrigins:config.allowedOrigins,env:journalEnv});
    } catch {
      logger.warn?.(JSON.stringify({type:'exam_journal_startup',code:'K56_TERM1_JOURNAL_PILOT_UNAVAILABLE'}));
    }
  }
""")


if __name__ == '__main__':
    original, candidate = map(Path, sys.argv[1:])
    with candidate.open('x', encoding='utf8', newline='\n') as out:
        out.write(patch(original.read_text(encoding='utf8')))
