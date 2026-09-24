"""Nhập roster K56 từ lượt ERP đã đối soát, giữ UUID IC2264 qua RAM."""

import csv
import io
import json
import re
import sys

import paramiko
import win32cred

from bridge_dry_run import (
    SOURCE_SCRIPT, TARGET_SCRIPT, TEST_SLUGS, SnapshotError,
    plan_diff, prepare_import_payload, remote_select,
)
from trial_shared_migrations import remote


def prepare_rows(source, pilot, now=None, uuid_factory=None):
    """Tạo hàng mới theo ID nguồn, gồm đủ pilot cũ và hai lớp chưa có Classroom."""
    summary = plan_diff(source, pilot, now)
    if summary["targetRosterRowsOutsideCurrentScope"] != 0:
        raise SnapshotError("PILOT_HISTORICAL_ROWS_REQUIRE_SEPARATE_PLAN")
    classes = {row["class_code"]: row["class_id"] for row in source["mappings"]}
    if not {"IC2322", "IC2326"}.issubset(classes):
        raise SnapshotError("APPROVED_CLASSES_NOT_IN_CURRENT_ERP_SCOPE")
    additions = (prepare_import_payload(source, pilot, now, uuid_factory)
                 if uuid_factory is not None else prepare_import_payload(source, pilot, now))
    rows = [{**row, "is_eligible": True} for row in pilot["roster"]]
    rows.extend({**row, "is_eligible": True} for row in additions["newRoster"])
    expected = len(source["members"]) * len(TEST_SLUGS)
    keys = {(row["test_slug"], row["class_id"], row["contact_id"]) for row in rows}
    refs = {(row["test_slug"], row["student_ref"]) for row in rows}
    if len(rows) != expected or len(keys) != expected or len(refs) != expected:
        raise SnapshotError("SHARED_ROSTER_KEY_COUNT_MISMATCH")
    return summary, sorted(rows, key=lambda row: (
        row["test_slug"], int(row["class_id"]), int(row["contact_id"])))


def main():
    # Dữ liệu vào: snapshot ERP mới nhất và 36 hàng pilot của kho K56 cũ.
    # Việc chính: xác minh nguồn, chuyển đúng UUID qua COPY một giao dịch.
    # Kết quả: roster K56 trong kho chung, quyền lớp vẫn đóng.
    # Khi lỗi: rollback và không xuất danh tính/đề/UUID ra stdout.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    import_attempted = False
    try:
        if "--audit-target" in sys.argv:
            result = remote(client, "docker exec -i mapping-postgres sh -lc "
                            "'psql -X -U \"$POSTGRES_USER\" -d mapping_db -At'",
                            "SELECT json_build_object("
                            "'roster', (SELECT count(*) FROM assessment_k56.term_test_roster),"
                            "'access', (SELECT count(*) FROM assessment_k56.term_test_class_access),"
                            "'definitions', (SELECT count(*) FROM assessment_k56.test_definition),"
                            "'latestSyncRunId', (SELECT run.id::text FROM mapping.sync_run AS run "
                            "WHERE run.source = 'n8n_k56_erp_ongoing' "
                            "ORDER BY run.id DESC LIMIT 1),"
                            "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster))::text;\n",
                            code="TARGET_AUDIT_FAILED")
            print(json.dumps({"toolOutcome": "success",
                              "businessOutcome": "read_only_target_counts",
                              "counts": json.loads(result), "productionWrites": 0}))
            return
        source = remote_select(client, "mapping-review-api", SOURCE_SCRIPT)
        pilot = remote_select(client, "izone-k56-ic2264-api", TARGET_SCRIPT)
        summary, rows = prepare_rows(source, pilot)
        if len(pilot["roster"]) != 36 or len(rows) != 1341:
            raise SnapshotError("ROSTER_BASELINE_CHANGED_REVIEW_REQUIRED")

        def query(sql):
            return remote(client, "docker exec -i mapping-postgres sh -lc "
                          "'psql -X -U \"$POSTGRES_USER\" -d mapping_db -At'",
                          sql + ";\n", code="SHARED_ROSTER_READ_FAILED")

        before = json.loads(query("SELECT json_build_object("
                                  "'database', current_database(),"
                                  "'k56Definitions', (SELECT count(*) FROM assessment_k56.test_definition),"
                                  "'k56Roster', (SELECT count(*) FROM assessment_k56.term_test_roster),"
                                  "'k56Access', (SELECT count(*) FROM assessment_k56.term_test_class_access),"
                                  "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster))::text"))
        if before != {"database": "mapping_db", "k56Definitions": 3,
                      "k56Roster": 0, "k56Access": 0, "k67Roster": 46}:
            raise SnapshotError("SHARED_ROSTER_TARGET_NOT_CLOSED_EMPTY")

        table = io.StringIO(newline="")
        writer = csv.writer(table, lineterminator="\n")
        writer.writerow(["test_slug", "erp_course_class_id", "erp_student_contact_id",
                         "student_ref", "student_name_snapshot", "is_eligible"])
        for row in rows:
            name = row["student_name"]
            if not name or any(ord(char) < 32 for char in name):
                raise SnapshotError("STUDENT_NAME_CONTROL_CHARACTER")
            writer.writerow([row["test_slug"], row["class_id"], row["contact_id"],
                             row["student_ref"], name, "true"])

        sync_run = summary["syncRunId"]
        if not sync_run.isdigit():
            raise SnapshotError("INVALID_SYNC_RUN_ID")
        sql = f"""BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';
DO $pre$
BEGIN
  IF (SELECT run.id::text FROM mapping.sync_run AS run
      WHERE run.source = 'n8n_k56_erp_ongoing'
      ORDER BY run.id DESC LIMIT 1) <> '{sync_run}'
     OR (SELECT count(*) FROM assessment_k56.term_test_roster) <> 0
     OR (SELECT count(*) FROM assessment_k56.term_test_class_access) <> 0
     OR (SELECT count(*) FROM assessment_k56.test_definition) <> 3 THEN
    RAISE EXCEPTION 'SHARED_ROSTER_PREFLIGHT_CHANGED';
  END IF;
END $pre$;
\\echo IMPORT_STAGE_PREFLIGHT_DONE
COPY assessment_k56.term_test_roster
  (test_slug, erp_course_class_id, erp_student_contact_id,
   student_ref, student_name_snapshot, is_eligible)
  FROM STDIN WITH (FORMAT csv, HEADER true);
""" + table.getvalue() + "\\.\n\\echo IMPORT_STAGE_COPY_DONE\n" + f"""DO $post$
BEGIN
  IF (SELECT count(*) FROM assessment_k56.term_test_roster) <> {len(rows)}
     OR (SELECT count(*) FROM assessment_k56.term_test_class_access) <> 0 THEN
    RAISE EXCEPTION 'SHARED_ROSTER_READBACK_COUNT_MISMATCH';
  END IF;
END $post$;
\\echo IMPORT_STAGE_POST_DONE
COMMIT;
"""
        import_attempted = True
        stdin, stdout, stderr = client.exec_command(
            "docker exec -i mapping-postgres sh -lc "
            "'psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate "
            "-U \"$POSTGRES_USER\" -d mapping_db'", timeout=180)
        stdin.write(sql)
        stdin.channel.shutdown_write()
        progress = stdout.read().decode("utf-8", errors="replace")
        error_text = stderr.read().decode("utf-8", errors="replace")
        if stdout.channel.recv_exit_status() != 0:
            states = re.findall(r"ERROR:\s+([0-9A-Z]{5})\b", error_text)
            stages = re.findall(r"IMPORT_STAGE_[A-Z_]+", progress)
            raise SnapshotError("SHARED_ROSTER_IMPORT_FAILED_"
                                + (states[-1] if states else "NO_SQLSTATE") + "_"
                                + (stages[-1] if stages else "BEFORE_PREFLIGHT"))

        readback = json.loads(query("SELECT json_agg(json_build_object("
                                    "'test_slug', test_slug,"
                                    "'class_id', erp_course_class_id::text,"
                                    "'contact_id', erp_student_contact_id::text,"
                                    "'student_ref', student_ref::text,"
                                    "'student_name', student_name_snapshot,"
                                    "'is_eligible', is_eligible)"
                                    "ORDER BY test_slug, erp_course_class_id, "
                                    "erp_student_contact_id)::text "
                                    "FROM assessment_k56.term_test_roster"))
        if readback != rows:
            raise SnapshotError("SHARED_ROSTER_FULL_READBACK_MISMATCH")
        access_count = int(query("SELECT count(*) FROM assessment_k56.term_test_class_access"))
        k67_count = int(query("SELECT count(*) FROM assessment.term_test_roster"))
        if access_count != 0 or k67_count != 46:
            raise SnapshotError("SHARED_ROSTER_CROSS_SYSTEM_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "k56_roster_copied_gate_closed",
                          "syncRunId": sync_run,
                          "classCount": summary["classCount"],
                          "eligibleStudents": summary["eligibleStudents"],
                          "rosterRows": len(rows), "pilotUuidPreserved": len(pilot["roster"]),
                          "unmatchedClassroomCount": summary["classroomUnmatchedClasses"],
                          "classAccessRows": 0, "k67RosterRows": k67_count,
                          "productionDatabaseWrites": len(rows)}, ensure_ascii=False))
    except Exception as exc:
        code = str(exc) if isinstance(exc, (RuntimeError, SnapshotError)) \
            else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                          "importAttempted": import_attempted}), file=sys.stderr)
        raise SystemExit(2)
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
