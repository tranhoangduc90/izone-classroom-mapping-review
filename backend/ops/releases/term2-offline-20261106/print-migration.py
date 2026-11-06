"""In migration bổ sung từ schema trong module đã kiểm; không kết nối database."""
from pathlib import Path
import re,sys
source=(Path(__file__).parent/'term2-offline.mjs').read_text(encoding='utf-8')
match=re.search(r'export const schema=`([^`]+)`;',source)
if not match or '${' in match.group(1):raise RuntimeError('Schema literal changed; inspect before migrating')
role=sys.argv[1] if len(sys.argv)>1 else 'k56_shared_api'
if role not in ['k56_shared_api','term2_fixture_api']:raise RuntimeError('Unexpected K56 role')
sql=match.group(1).replace('assessment.','assessment_k56.')
print('BEGIN;\n'+sql+'\nGRANT SELECT,INSERT,UPDATE ON assessment_k56.term2_offline_run,assessment_k56.term2_offline_operation TO '+role+';\nCOMMIT;')
