"""Khóa ghi đúng 13 bảng nguồn K67, giữ khả năng SELECT và rollback trước chuyển.

SQL nhận intent của lần chuyển. Hàm chặn ghi chạy trước statement; không sửa
bản ghi, role hay quyền bảng K56. Diễn tập dùng transaction rồi ROLLBACK.
"""
import re

SCHEMA='k67_cutover_v1'
TRIGGER='k67_source_write_fence'
FUNCTION_BODY=" BEGIN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='K67_SOURCE_MOVED_USE_OWN_BACKEND'; END "

def marker(intent):
    if not re.fullmatch('[a-f0-9]{32}',intent):raise ValueError('K67_FENCE_INTENT_INVALID')
    return 'PRODUCT-TERM-MINI-K67:source-fence:'+intent

def install(tables,intent):
    if len(tables)!=13 or len(set(tables))!=13 or any(not re.fullmatch('[a-z][a-z0-9_]*',t) for t in tables):
        raise ValueError('K67_FENCE_TABLE_SCOPE_INVALID')
    label=marker(intent)
    result=["CREATE SCHEMA k67_cutover_v1;", "REVOKE ALL ON SCHEMA k67_cutover_v1 FROM PUBLIC;",
      "COMMENT ON SCHEMA k67_cutover_v1 IS '"+label+"';",
      "CREATE FUNCTION k67_cutover_v1.reject_source_write() RETURNS trigger LANGUAGE plpgsql AS $$"+FUNCTION_BODY+"$$;",
      "REVOKE ALL ON FUNCTION k67_cutover_v1.reject_source_write() FROM PUBLIC;"]
    result += ['CREATE TRIGGER '+TRIGGER+' BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON assessment.'+t
      +' FOR EACH STATEMENT EXECUTE FUNCTION k67_cutover_v1.reject_source_write();' for t in tables]
    return '\n'.join(result)

def inspect_query():
    return """SELECT jsonb_build_object(
      'namespace',EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='k67_cutover_v1'),
      'marker',(SELECT obj_description(oid,'pg_namespace') FROM pg_namespace WHERE nspname='k67_cutover_v1'),
      'function',(SELECT jsonb_build_object('body',p.prosrc,'language',l.lanname,'definer',p.prosecdef,
        'arguments',p.pronargs,'returns',p.prorettype::regtype::text,'owner',pg_get_userbyid(p.proowner))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
        WHERE n.nspname='k67_cutover_v1' AND p.proname='reject_source_write' AND p.pronargs=0),
      'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
        'enabled',t.tgenabled,'type',t.tgtype,'function_schema',f.nspname,'function',p.proname) ORDER BY c.relname),'[]'::jsonb)
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
        WHERE t.tgname='k67_source_write_fence'))"""

def verify(actual,tables,intent):
    expected=[{'schema':'assessment','table':t,'enabled':'O','type':62,
      'function_schema':SCHEMA,'function':'reject_source_write'} for t in sorted(tables)]
    function={'body':FUNCTION_BODY,'language':'plpgsql','definer':False,'arguments':0,'returns':'trigger','owner':'mapping_admin'}
    if actual!={'namespace':True,'marker':marker(intent),'function':function,'triggers':expected}:
        raise RuntimeError('K67_SOURCE_FENCE_DEFINITION_CHANGED')
    return True

def assert_block(command):
    # Bắt đúng mã và thông báo của fence; lỗi SQL/khóa ngoại khác không được coi đạt.
    return "DO $proof$ BEGIN BEGIN "+command+"; EXCEPTION WHEN SQLSTATE '55000' THEN " \
      "IF SQLERRM <> 'K67_SOURCE_MOVED_USE_OWN_BACKEND' THEN RAISE; END IF; RETURN; END; " \
      "RAISE EXCEPTION 'K67_FENCE_DID_NOT_BLOCK'; END $proof$;"
