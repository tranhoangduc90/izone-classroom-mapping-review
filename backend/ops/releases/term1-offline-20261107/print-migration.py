"""Chỉ in migration bổ sung Term1; không kết nối DB hoặc thay bảng Term2."""
from pathlib import Path
import re,sys
s=(Path(__file__).parent/'k56-offline-core.mjs').read_text(encoding='utf8')
m=re.search(r'const schema=tables\(`([^`]+)`\);',s);assert m and '${' not in m.group(1)
role=sys.argv[1] if len(sys.argv)>1 else 'k56_shared_api';assert role=='k56_shared_api'
sql=m.group(1).replace('term2_offline_','term1_offline_').replace('assessment.','assessment_k56.')
assert 'term2_' not in sql
print('BEGIN;\n'+sql+'\nGRANT SELECT,INSERT,UPDATE ON assessment_k56.term1_offline_run,assessment_k56.term1_offline_operation TO '+role+';\nCOMMIT;')
