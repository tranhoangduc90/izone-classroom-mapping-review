"""Dựng DB trống, sao lưu và phục hồi dữ liệu giả trong PostgreSQL fixture riêng.
Nhận DDL của gói; kiểm cấu trúc/quyền/nội dung/trigger và lưu bằng chứng native.
Lỗi giữ DB và log để điều tra; không xóa hay chỉnh container/DB chung.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import shlex
import subprocess
import sys
import unittest
import uuid

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".codex/product-evidence"
RUN_ID = "k67-bootstrap-" + uuid.uuid4().hex
CONTAINER = "term-mini-k67-postgres-fixture"
SOURCE = "term_mini_k67_test_bootstrap_" + uuid.uuid4().hex[:12]
TARGET = "term_mini_k67_test_restore_" + uuid.uuid4().hex[:12]
SESSION = str(uuid.uuid4())
OPERATIONS = []
EXECUTED = []
spec = importlib.util.spec_from_file_location("connector", "E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py")
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)
client, password = connector.connect("vps_1")
password = None


def remote(argv, data=None, required=True):
    incoming, out, err = client.exec_command(" ".join(shlex.quote(value) for value in argv), timeout=120)
    if data is not None:
        incoming.write(data)
        incoming.flush()
        incoming.channel.shutdown_write()
    raw, error = out.read(), err.read()
    code = out.channel.recv_exit_status()
    OPERATIONS.append({"argv": argv, "exit_code": code, "stderr": error.decode("utf-8"),
                       "stdout_sha256": hashlib.sha256(raw).hexdigest()})
    if required and code:
        raise RuntimeError("REMOTE_EXIT_" + str(code) + ": " + error.decode("utf-8"))
    return code, raw


def sql(database, source, required=True):
    return remote(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                   "-U", "k67_owner", "-d", database], source.encode("utf-8"), required)


def value(database, source):
    return sql(database, source)[1].decode("utf-8").strip()


def fingerprint():
    result = subprocess.run([sys.executable, "C:/Users/ADMIN/.codex/hooks/enforce_product_process.py", "fingerprint",
        "--root", str(ROOT), "--manifest", str(ROOT / ".codex/product-quality-gate.json")], capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout.decode("utf-8"))["tree_revision"]


def protected():
    rows = json.loads(remote(["docker", "inspect", "mapping-review-api", "izone-k56-ic2264-api", "mapping-postgres"])[1])
    return {row["Name"]: hashlib.sha256(json.dumps({key: row[key] for key in
        ["Image", "Config", "HostConfig", "Mounts", "RestartCount"]}, sort_keys=True).encode()).hexdigest() for row in rows}


def structure(database):
    return json.loads(value(database, """SELECT json_build_object(
      'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='assessment' AND table_type='BASE TABLE'),
      'history_triggers',(SELECT count(*) FROM pg_trigger WHERE tgname IN ('collaboration_row_history','collaboration_truncate_history')
        AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='assessment'::regnamespace)),
      'revoked_reason',(SELECT count(*) FROM information_schema.columns WHERE table_schema='mapping' AND table_name='reviewer_session' AND column_name='revoked_reason'))"""))


def business_rows(database):
    # So mọi bảng nghiệp vụ/ngữ cảnh theo JSON đã sắp thứ tự; không chỉ so số lượng.
    tables = value(database, "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname IN ('assessment','mapping') ORDER BY 1").splitlines()
    return {table: value(database, "SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t) AS row FROM " + table + " t) x") for table in tables}


class BootstrapRestore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        marker = value("term_mini_k67_test_database", "SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity")
        if marker != "PRODUCT-TERM-MINI-K67:synthetic-fixture-20261006":
            raise RuntimeError("FIXTURE_MARKER_MISMATCH")
        for database in [SOURCE, TARGET]:
            remote(["docker", "exec", CONTAINER, "createdb", "-U", "k67_owner", "--template=template0", database])

    def test_1_empty_database_accepts_current_schema(self):
        parts = ["BEGIN;"] + [(ROOT / "db" / name).read_text(encoding="utf-8") for name in
            ["001-context.sql", "002-history.sql", "003-assessment.sql", "004-grants.sql", "005-context-auth.sql"]] + ["COMMIT;"]
        sql(SOURCE, "\n".join(parts))
        self.assertEqual(structure(SOURCE), {"tables": 13, "history_triggers": 26, "revoked_reason": 1})
        sql(SOURCE, """INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
          VALUES('term-test-1','Đề phục hồi mô phỏng',1,'{}','{}',true);
          INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
            erp_student_contact_id,student_name_snapshot,listening_started_at,listening_deadline_at,listening_draft,listening_draft_revision)
          VALUES ('""" + SESSION + """','term-test-1',1,1124,'K67SIM_RESTORE',9870676999,'Học viên phục hồi mô phỏng',
            now(),now()+interval '30 minutes','{"1":"nháp giữ nguyên"}',7);""")
        self.assertGreater(int(value(SOURCE, "SELECT count(*) FROM collaboration.audit_event WHERE action='INSERT' AND object_name='term_test_exam_session'")), 0)

    def test_2_real_dump_restore_preserves_all_business_rows(self):
        before = business_rows(SOURCE)
        self.assertIn(SESSION, before["assessment.term_test_exam_session"])
        dump = remote(["docker", "exec", CONTAINER, "pg_dump", "-U", "k67_owner", "-d", SOURCE, "--format=custom", "--no-owner"])[1]
        dump_path = EVIDENCE / (RUN_ID + ".dump")
        dump_path.write_bytes(dump)
        remote(["docker", "exec", "-i", CONTAINER, "pg_restore", "-U", "k67_owner", "-d", TARGET,
                "--exit-on-error", "--single-transaction", "--no-owner"], dump)
        # pg_dump không mang CONNECT của database khi phục hồi sang tên mới; đặt quyền đích rõ ràng.
        sql(TARGET, "REVOKE ALL ON DATABASE " + TARGET + " FROM PUBLIC; GRANT CONNECT ON DATABASE " + TARGET + " TO k67_app,k67_context_sync;")
        self.assertEqual(business_rows(TARGET), before)
        self.assertEqual(structure(TARGET), {"tables": 13, "history_triggers": 26, "revoked_reason": 1})
        self.assertEqual(value(TARGET, "SELECT max(event_id) FROM collaboration.audit_event"), value(SOURCE, "SELECT max(event_id) FROM collaboration.audit_event"))

    def test_3_restored_permissions_and_history_continue_working(self):
        self.assertEqual(value(TARGET, "SELECT has_table_privilege('k67_app','assessment.term_test_attempt','INSERT')"), "t")
        self.assertEqual(value(TARGET, "SELECT has_column_privilege('k67_context_sync','mapping.reviewer_session','revoked_at','UPDATE')"), "t")
        for statement in ["SET ROLE k67_app; CREATE TABLE mapping.forbidden_test(x int)",
                          "SET ROLE k67_context_sync; SELECT token_hash FROM mapping.reviewer_session",
                          "SET ROLE k67_app; SELECT * FROM collaboration.audit_event"]:
            self.assertNotEqual(sql(TARGET, statement, required=False)[0], 0)
        count = int(value(TARGET, "SELECT count(*) FROM collaboration.audit_event WHERE action='UPDATE' AND object_name='term_test_exam_session'"))
        sql(TARGET, "SET ROLE k67_app; UPDATE assessment.term_test_exam_session SET listening_draft_revision=8 WHERE id='" + SESSION + "';")
        self.assertEqual(value(TARGET, "SELECT listening_draft_revision FROM assessment.term_test_exam_session WHERE id='" + SESSION + "'"), "8")
        self.assertEqual(int(value(TARGET, "SELECT count(*) FROM collaboration.audit_event WHERE action='UPDATE' AND object_name='term_test_exam_session'")), count + 1)


class ObservedResult(unittest.TextTestResult):
    def startTest(self, test):
        EXECUTED.append(test.id())
        super().startTest(test)


log = io.StringIO()
try:
    before_revision, before_protected = fingerprint(), protected()
    result = unittest.TextTestRunner(stream=log, verbosity=2, resultclass=ObservedResult).run(unittest.defaultTestLoader.loadTestsFromTestCase(BootstrapRestore))
    after_revision, after_protected = fingerprint(), protected()
    outcome = "passed" if result.wasSuccessful() and not result.skipped and before_revision == after_revision and before_protected == after_protected else "failed"
    raw = log.getvalue().encode("utf-8")
    stdout_path, stderr_path = EVIDENCE / (RUN_ID + ".native.log"), EVIDENCE / (RUN_ID + ".stderr.log")
    stdout_path.write_bytes(raw)
    stderr_path.write_bytes(b"")
    receipt = {"run_id": RUN_ID, "command": ["python", "tools/test-bootstrap-restore.py"],
        "tree_revision": before_revision, "observed_after_revision": after_revision, "outcome": outcome,
        "exit_code": 0 if outcome == "passed" else 1, "failed": len(result.failures) + len(result.errors),
        "skipped": len(result.skipped), "executed_test_ids": EXECUTED,
        "stdout": {"path": str(stdout_path), "sha256": hashlib.sha256(raw).hexdigest()},
        "stderr": {"path": str(stderr_path), "sha256": hashlib.sha256(b"").hexdigest()},
        "source_database": SOURCE, "target_database": TARGET, "fixture_id": "synthetic-fixture-20261006",
        "protected_before": before_protected, "protected_after": after_protected,
        "operations": OPERATIONS, "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    (EVIDENCE / (RUN_ID + ".json")).write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(log.getvalue())
    print(json.dumps({"run_id": RUN_ID, "outcome": outcome, "tests": result.testsRun, "failed": receipt["failed"]}))
    sys.exit(receipt["exit_code"])
finally:
    client.close()
