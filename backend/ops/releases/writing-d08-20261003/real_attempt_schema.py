"""Dựng bảng bài thi trong database owned từ catalog production đã chụp.
Giữ đúng cột, default, NOT NULL, CHECK, UNIQUE và FK của bảng attempt.
Không cài trigger lịch sử ở fixture; production phải giữ trigger/audit nguyên trạng.
"""
import hashlib,json,re
from canary_remote import child_tables,destination,NAMES

TYPES={'bigint','integer','jsonb','text','timestamp with time zone','uuid'}
DEFAULTS={"''::text","'{}'::jsonb","'lis_first'::text",'0','gen_random_uuid()','now()'}
CATALOG_SHA={
 NAMES[0]:'350177c7b4c11cca29002ec1c2feabac0bf3340755550d0eb86d9ebafabc5f51',
 NAMES[1]:'679bc034756dad9d7b59eec9f89cd3841398a29adb5e2cae61fa74165dc6054c',
 NAMES[2]:'8763144b906310ccea9325baf669a15985a0aa258f98a8e518c3c8c1cc86435f'}
def identifier(value):
 if not isinstance(value,str) or not re.fullmatch('[a-z][a-z0-9_]*',value):raise ValueError('schema_identifier_invalid')
 return value

def real_attempt_ddl(contract,item):
 # Catalog độc lập là đầu vào bắt buộc; không quay về DDL giản lược nếu thiếu.
 if contract.get('schema')!='d08-real-attempt-schema/v1' or set(contract.get('targets',{}))!=set(NAMES):
  raise ValueError('real_schema_contract_missing')
 if not re.fullmatch('[a-f0-9]{64}',contract.get('source_sha256','')):raise ValueError('schema_source_digest_missing')
 schema=identifier(destination(item)[0]);target=contract['targets'][item['name']]
 fields=[];names=[]
 for column in target['columns']:
  name=identifier(column['name']);names.append(name)
  if column['type'] not in TYPES or column['nullable'] not in ('YES','NO'):raise ValueError('schema_column_type_invalid')
  value=name+' '+column['type']
  if column['default'] is not None:
   if column['default'] not in DEFAULTS:raise ValueError('schema_default_unreviewed')
   value+=' DEFAULT '+column['default']
  if column['nullable']=='NO':value+=' NOT NULL'
  fields.append(value)
 if len(set(names))!=len(names) or 'reading_submitted_at' not in names:raise ValueError('schema_columns_incomplete')
 constraints=target['constraints'];foreign=[];checks=[]
 for row in constraints:
  name=identifier(row['name']);definition=row['definition'];kind=row['type']
  if not isinstance(definition,str) or ';' in definition or '--' in definition:raise ValueError('schema_constraint_invalid')
  if kind in ('p','u','c'):
   prefix={'p':'PRIMARY KEY (','u':'UNIQUE (','c':'CHECK ('}[kind]
   if not definition.startswith(prefix):raise ValueError('schema_constraint_kind_wrong')
   fields.append('CONSTRAINT '+name+' '+definition)
   if kind=='c':checks.append(name)
  elif kind=='f':
   allowed={'FOREIGN KEY (test_slug) REFERENCES '+schema+'.test_definition(slug)',
            'FOREIGN KEY (exam_session_id) REFERENCES '+schema+'.term_test_exam_session(id)'}
   if definition not in allowed:raise ValueError('schema_foreign_key_unreviewed')
   foreign.append('ALTER TABLE '+schema+'.term_test_attempt ADD CONSTRAINT '+name+' '+definition+';')
  else:raise ValueError('schema_constraint_kind_unreviewed')
 required={'term_test_attempt_section_deadline_check','term_test_attempt_writing_order_check','term_test_attempt_writing_draft_revision_check'}
 required|={'term_test_attempt_completion_check'} if item['name']==NAMES[0] else {'k56_completed_sections_check','k56_exam_mode_check'}
 if set(checks)!=required or len(foreign)!=2:raise ValueError('schema_check_or_fk_set_changed')
 # Tên đúng vẫn chưa đủ: CHECK(true), default hoặc nullability bị đổi phải chặn.
 catalog={key:target[key] for key in ('columns','constraints')}
 digest=hashlib.sha256(json.dumps(catalog,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
 if digest!=CATALOG_SHA[item['name']]:raise ValueError('schema_catalog_definition_changed')
 sql='CREATE TABLE '+schema+'.term_test_attempt(\n '+',\n '.join(fields)+'\n);\n'
 for table in child_tables(item):
  sql+='CREATE TABLE '+schema+'.'+table+'(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid REFERENCES '+schema+'.term_test_attempt(id) ON DELETE CASCADE);\n'
 return sql+'\n'.join(foreign)+'\n'
