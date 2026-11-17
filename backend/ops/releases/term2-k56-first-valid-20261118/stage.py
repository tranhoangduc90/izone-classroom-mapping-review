"""Patch the captured serving Term2 K56 files, without enabling Term1 admission."""
from pathlib import Path
import sys


def once(source, before, after):
    assert source.count(before) == 1, before[:120]
    return source.replace(before, after, 1)


def main():
    captured, output = map(Path, sys.argv[1:])
    output.mkdir(parents=True, exist_ok=True)
    entry = (captured / 'k56-exam-order.js').read_text(encoding='utf-8')
    entry = once(entry,
        '      const definitionVersion = pinnedOfficial?.definition_version ?? student.definition_version;',
        '''      const definitionVersion = pinnedOfficial?.definition_version ?? student.definition_version;
      let candidateGeneration=Number(pinnedOfficial?.generation)||0;
      if(wantsParallel&&!pinnedOfficial){
        const epoch=await client.query(`SELECT coalesce(max(generation),0)::text AS generation
          FROM assessment.term_test_attempt WHERE test_slug=$1 AND attempt_mode='cbt'
            AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND superseded_at IS NULL`,
          [slug,student.class_id,student.student_id]);
        candidateGeneration=Number(epoch.rows[0].generation);
      }''')
    entry = once(entry, 'body.attemptMode,Number(pinnedOfficial?.generation)||0]',
        'body.attemptMode,candidateGeneration]')
    helper = (captured / 'term2-parallel-entry.mjs').read_text(encoding='utf-8')
    helper = once(helper, ' OR listening_interrupted_at IS NOT NULL', '')
    helper = once(helper, 'least(listening_submitted_at,listening_interrupted_at,',
        'least(listening_submitted_at,')
    for name, source in [('k56-exam-order.js', entry), ('term2-parallel-entry.mjs', helper)]:
        (output / name).write_text(source, encoding='utf-8', newline='\n')
    print('Staged only Term2 first-valid lookup and unsealed generation inheritance')


if __name__ == '__main__':
    main()
