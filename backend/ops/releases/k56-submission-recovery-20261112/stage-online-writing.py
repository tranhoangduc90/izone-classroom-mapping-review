"""Stage the Writing receiver from the isolated L/R runtime and exact VPS app.js."""
from pathlib import Path
import hashlib
import shutil
import sys

HERE = Path(__file__).resolve().parent
PINNED = {
    'app.js': 'fb6a997a3f1e25d1795a004ca59834dfda45dbcccafe1d03b7f95c3d990c4abb',
    'k56-exam-order.js': 'bba799504bf8ec2aa69cec049857c4037d69a81dfb503f928e28639946d3113d',
    'term-test-writing-grading.js': 'a029d06f2e65fb8f1d817ab2074854148222863347a80e90d6bc07ca12cb0afa',
    'term-test-writing-notifier.js': '1752a45cf9592a14095d5ba16b155b981484932ff9b27dd9a8708ec5320acea2',
    'term1-blank.mjs': 'ebafe24f183269bd04019d8748f732cb97781bd3c2050f06a5bf6ab640595c58',
    'term2-blank.mjs': '6694e8439f156fd2a3d54d3d7e4ed5bdcafb2c191ab4d68a49a8afb73aa121ca',
}


def source_at(path):
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != PINNED[path.name]:
        raise ValueError(f'Unexpected bytes for {path}')
    return content.decode('utf-8')


def replace(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f'Unexpected Writing anchor: {before}')
    return source.replace(before, after)


def patch_app(app):
    app = replace(app, 'async function ensureTermTestWritingGrading(row) {', '''async function ensureTermTestWritingGrading(row, executor, options) {
    if (executor && !termTestWritingGradingService) {
      throw new TermTestWritingGradingError('WRITING_GRADING_UNAVAILABLE', 'Chưa xếp được việc chấm.', 503);
    }''')
    app = replace(app, 'async function contentForTermTestAttempt(row) {\n    row = await pinK56TermDefinition(pool,',
                  'async function contentForTermTestAttempt(row, executor = pool) {\n    row = await pinK56TermDefinition(executor,')
    app = replace(app, 'contentForTermTestAttempt({ ...row, test_slug: testSlug });',
                  'contentForTermTestAttempt({ ...row, test_slug: testSlug }, executor);')
    app = replace(app, 'taskDefinitions: content?.writing?.tasks || []\n    });',
                  'taskDefinitions: content?.writing?.tasks || []\n    }, executor, options);')
    app = replace(app, 'started: Boolean(row?.writing_started_at),\n    submitted: Boolean(row?.writing_submitted_at),',
                  'started: Boolean(row?.writing_started_at),\n    startedAt: row?.writing_started_at || null,\n    submitted: Boolean(row?.writing_submitted_at),')
    app = replace(app, '    authenticate, readTeacherSkillScope: readTeacherSavedProgress,',
                  '''    authenticate, readTeacherSkillScope: readTeacherSavedProgress,
    serializeOnlineWriting: serializeTermTestWriting,
    readOnlineWriting: async (client, row) => ({ ok: true, writing: serializeTermTestWriting(row,
      await termTestWritingGradingService?.getStatus(row.attempt_token, client)) }),
    notifyOnlineWriting: () => termTestWritingGradingService?.notifyCommitted?.(),''')
    return replace(app, "reason:row.writing_reason},{'server:writing:task1'",
                   "reason:row.writing_reason},k56TermWriting?undefined:{'server:writing:task1'")


def patch_router(source):
    source = replace(source, "import { createTermOnlineRecovery, onlineRecoveryCapability } from './term-online-submission.mjs';",
                     """import { createTermOnlineRecovery, onlineRecoveryCapability } from './term-online-submission.mjs';
import { registerTermOnlineWriting } from './term-online-writing.mjs';""")
    source = replace(source, 'readSkillReview, allowNewReadFirst',
                     'readSkillReview, serializeOnlineWriting, readOnlineWriting, notifyOnlineWriting, allowNewReadFirst')
    return replace(source, 'parseStoredTest, serialize, resultFor, record, failure });',
                   '''parseStoredTest, serialize, resultFor, record, failure, readWritingResponse: readOnlineWriting });
  if (serializeOnlineWriting && readOnlineWriting && onWriting) registerTermOnlineWriting(router, {
    limiter: draftLimiter || limiter, route, recovery: onlineRecovery, transaction, assets, record, failure,
    onWriting, readWritingResponse: readOnlineWriting, serializeWriting: serializeOnlineWriting, notifyWriting: notifyOnlineWriting
  });''')


def patch_grading(source):
    source = replace(source, '''async function ensureSubmission({ attemptToken, testSlug, task1, task2, taskDefinitions }) {
    return inTransaction(pool, async client => {''', '''async function ensureSubmission({ attemptToken, testSlug, task1, task2, taskDefinitions }, executor, { qualifiedOnline = false } = {}) {
    async function enqueue(client) {''')
    source = source.replace('taskDefinitions,version:GRADING_VERSION}))', 'taskDefinitions,version:GRADING_VERSION,qualifiedOnline}))')
    return replace(source, '''      return readStatus(client, attemptToken);
    });
  }

  async function claimJobs''', '''      return readStatus(client, attemptToken);
    }
    if (executor) return { ...await enqueue(executor), version: GRADING_VERSION };
    return inTransaction(pool, enqueue);
  }

  async function claimJobs''')


def patch_notifier(source):
    source = replace(source, '  const wrapped = { ...service };',
                     '  const wrapped = { ...service, notifyCommitted: () => notifier.kick() };')
    return replace(source, '      const result = await service[name](...args);\n      try {',
                   '''      const result = await service[name](...args);
      if (name === 'ensureSubmission' && args[1]) return result; // caller owns the transaction
      try {''')


def patch_blank(source):
    source = replace(source, 'taskDefinitions,version}){', 'taskDefinitions,version,qualifiedOnline=false}){')
    return replace(source, " if(!run?.state?.writing?.sealed)return false;",
                   """ if(!run?.state?.writing?.sealed&&!qualifiedOnline){
  const blank=(await client.query(`SELECT 1 FROM assessment.term_test_writing_grading_run
    WHERE attempt_id=$1 AND grading_version=$2 AND result_json->>'gradingMethod'='blank_rule'`,[attempt.id,version])).rows[0];
  if(!blank)return false;
 }""")


def main(source, native_app, destination):
    patches = {'app.js': patch_app, 'k56-exam-order.js': patch_router,
               'term-test-writing-grading.js': patch_grading, 'term-test-writing-notifier.js': patch_notifier,
               'term1-blank.mjs': patch_blank, 'term2-blank.mjs': patch_blank}
    output = {name: patch(source_at(native_app if name == 'app.js' else source / 'src' / name))
              for name, patch in patches.items()}
    shutil.copytree(source, destination)
    for name, data in output.items():
        (destination / 'src' / name).write_text(data, encoding='utf-8', newline='\n')
    for name in ('term-online-submission.mjs', 'term-online-writing.mjs'):
        shutil.copyfile(HERE / name, destination / 'src' / name)


if __name__ == '__main__':
    main(*(Path(value).resolve() for value in sys.argv[1:]))
