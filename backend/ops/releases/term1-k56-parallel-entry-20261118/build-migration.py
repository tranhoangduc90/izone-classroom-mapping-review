from pathlib import Path
root=Path(__file__).resolve().parent
source=(root.parent/'term2-k56-parallel-entry-20261117/parallel-attempts.sql').read_text(encoding='utf-8')
source=source.replace('term2','term1').replace('TERM2','TERM1').replace('writing_task_1','writing_task_2')
source=source.replace('term-test-2-k56','term-test-1-k56')
source=source.replace('P5652','P5654').replace('P5651','P5653')
source=source.replace('          AND NEW.listening_interrupted_at IS NULL','')
source=source.replace(' OR OLD.listening_interrupted_at IS NOT NULL','')
source=source.replace(' OR accepted.listening_interrupted_at IS NOT NULL','')
# Interruptions are evidence of a stopped Listening section, not a valid first
# submission reserving the person's official result under the GOAL contract.
source=source.replace("        OR (OLD.listening_interrupted_at IS NULL AND NEW.listening_interrupted_at IS NOT NULL)\n",'')
before='AND NOT term1_parallel_entry;'
assert source.count(before)==2
source=source.replace(before,'AND NOT term1_parallel_entry AND NOT term2_parallel_entry;')
(root/'parallel-attempts.sql').write_text(source,encoding='utf-8',newline='\n')
print('Prepared Term1-only first valid submission guard, keeping Term2 parallel exclusions')
