"""Apply the Term 1 CBT operation changes to an isolated runtime candidate."""

from pathlib import Path
import sys


def replace(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f'Unexpected runtime anchor: {old}')
    return source.replace(old, new)


def stage(source, *, main_term1=True):
    source = replace(source, "kind:z.enum(['start','draft','seal'])", "kind:z.enum(['start','draft','seal','interrupt'])")
    source = replace(source, 'audioEnded:z.boolean().optional(),',
                     "interruptionReason:z.enum(['learner_cannot_hear','page_interrupted']).optional(),\n audioEnded:z.boolean().optional(),")
    source = replace(source, "!prior?.sealed||prior.operationId!==b.dependency",
                     "!(prior?.sealed||prior?.interrupted)||prior.operationId!==b.dependency")
    source = replace(source, "   if(item.sealed", "   if(item.interrupted||item.sealed")
    source = replace(source, "   if(b.section!=='writing'&&!p.answers)throw fail(", "   if(!interruption&&b.section!=='writing'&&!p.answers)throw fail(")
    source = replace(source, "   if(profile.taskNumber===2&&b.section!=='writing'){",
                     "   if(!interruption&&profile.taskNumber===2&&b.section!=='writing'){")
    scope = ("SLUG!=='term-test-1-k56'||grant" if main_term1 else
             "!['term-test-2-k56','mini-test-k56'].includes(SLUG)||a.attempt_mode!=='cbt'")
    source = replace(source, "   const contentHash=digest(", """   const interruption=b.kind==='interrupt';
   if(interruption ? """ + scope + """||b.section!=='listening'||!p.interruptionReason
      ||p.answers!==undefined||p[profile.taskId]!==undefined||p.reason!==undefined
      ||p.audioEnded!==undefined||p.heardSeconds!==undefined : p.interruptionReason!==undefined)
    throw fail('OFFLINE_INVALID','Trạng thái gián đoạn không khớp kỹ năng.',400);
   const contentHash=digest(""")
    source = replace(source, "if(b.kind!=='start'&&item.revision===b.revision", "if(!interruption&&b.kind!=='start'&&item.revision===b.revision")
    source = replace(source, "    if(b.section==='listening')await client.query(`UPDATE", """    if(interruption)await client.query(`UPDATE assessment.term_test_attempt
     SET listening_interrupted_at=$2::timestamptz,updated_at=now() WHERE id=$1`,[a.attempt_token,b.occurredAt]);
    else if(b.section==='listening')await client.query(`UPDATE""")
    source = replace(source, "operationId:b.kind==='seal'?b.operationId:null",
                     "operationId:b.kind==='seal'||interruption?b.operationId:null,...(interruption?{interrupted:true}:{})")
    if not main_term1:
        source = replace(source, 'writing_draft_updated_at=now(),updated_at=now()',
                         'writing_draft_updated_at=now(),writing_updated_at=now(),updated_at=now()')
        return source
    source = replace(source, '  return {completedElsewhere};', """  const listening=run.state?.listening;
  const listeningInterruption=listening?.interrupted&&a.listening_interrupted_at ? {
   operationId:listening.operationId,startedAt:listening.startedAt,deadlineAt:listening.deadlineAt,revision:listening.revision
  } : null;
  return {completedElsewhere,...(listeningInterruption?{listeningInterruption}:{})};""")
    return source


def stage_order(source):
    if '    listeningInterrupted: Boolean(a.listening_interrupted_at),' not in source:
        source = replace(source, 'return order.find(skill => !a[`${skill}_submitted_at`])',
                         "return order.find(skill => !a[`${skill}_submitted_at`] && !(skill === 'listening' && a.listening_interrupted_at))")
        source = replace(source, '    listeningSubmitted: Boolean(a.listening_submitted_at), readingSubmitted:',
                         '    listeningInterrupted: Boolean(a.listening_interrupted_at),\n'
                         '    listeningSubmitted: Boolean(a.listening_submitted_at), readingSubmitted:')
    return replace(source,
                   '    res.json({ ...serialize(a),result:resultFor(a),portalSyncStatus:await readPortalSyncStatus(a,resultFor(a)),exam:{...serialize(a)},writing:null });',
                   """    const result = resultFor(a);
    let writing = null;
    if (a.listening_interrupted_at && a.writing_started_at) {
      writing = {
        task1: String(a.writing_task_1 || ''), task2: String(a.writing_task_2 || ''),
        revision: Number(a.writing_draft_revision) || 0, started: true, submitted: Boolean(a.writing_submitted_at),
        deadlineAt: a.writing_deadline_at || null, serverNow: a.server_now,
        updatedAt: a.writing_updated_at || null, submittedAt: a.writing_submitted_at || null,
        grading: a.writing_submitted_at ? await readSkillWriting(pool, a) : null
      };
    }
    res.json({ ...serialize(a), className:a.class_name_snapshot, result,
      portalSyncStatus:await readPortalSyncStatus(a,result), exam:{...serialize(a)}, writing });""")


if __name__ == '__main__':
    source, destination = (Path(arg).resolve() for arg in sys.argv[1:])
    if source == destination or source.name != destination.name:
        raise ValueError('Write the same module name to a separate candidate runtime')
    transform = {'term1-skill-offline-core.mjs': stage,
                 'k56-offline-core.mjs': lambda source: stage(source, main_term1=False),
                 'k56-exam-order.js': stage_order}[source.name]
    destination.write_text(transform(source.read_text(encoding='utf-8')), encoding='utf-8', newline='\n')
