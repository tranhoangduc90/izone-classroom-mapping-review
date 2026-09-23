"""Đối soát hai kho K56 chỉ đọc; hồ sơ học viên chỉ tồn tại trong RAM."""

from collections import Counter
from datetime import datetime, timezone
import json
import sys
from uuid import UUID, uuid4

TEST_SLUGS = ("term-test-1-k56", "term-test-2-k56", "mini-test-k56")
SOURCE_SCRIPT = r"""
// Dữ liệu vào: mapping_db qua DATABASE_URL ở container nguồn.
// Việc chính: đọc lượt K56 mới nhất cùng lớp và học viên đang học của đúng lượt.
// Kết quả: JSON qua SSH về RAM; không ghi file/log và không đọc email.
// Khi lỗi: trả exit khác 0, không giả làm snapshot rỗng.
import pg from 'pg';
const db = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 10000});
try {
  const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
  const runs = (await db.query(`SELECT run.id::text AS id, status, class_names, row_count,
    finished_at, error_message FROM mapping.sync_run
    AS run WHERE source = 'n8n_k56_erp_ongoing'
    ORDER BY run.id DESC LIMIT 2`)).rows;
  const mappings = (await db.query(`WITH latest AS (
    SELECT class_names FROM mapping.sync_run WHERE source = 'n8n_k56_erp_ongoing'
    ORDER BY id DESC LIMIT 1)
    SELECT erp_course_class_id::text AS class_id,
      erp_class_name_snapshot AS class_code, classroom_course_id, status
    FROM mapping.classroom_course_mapping, latest
    WHERE upper(erp_class_name_snapshot) = ANY(latest.class_names)`)).rows;
  const members = (await db.query(`WITH latest AS (
    SELECT id, class_names FROM mapping.sync_run
    WHERE source = 'n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1)
    SELECT member.erp_course_class_id::text AS class_id,
      member.erp_class_name_snapshot AS class_code,
      member.erp_student_contact_id::text AS contact_id,
      member.erp_student_name_snapshot AS student_name,
      member.registration_status, member.source_state,
      member.sync_run_id::text AS sync_run_id
    FROM mapping.erp_class_membership_snapshot AS member, latest
    WHERE upper(member.erp_class_name_snapshot) = ANY(latest.class_names)
      AND member.sync_run_id = latest.id AND member.source_state = 'active'
      AND member.registration_status = 'on_going'`)).rows;
  const memberCounts = (await db.query(`WITH latest AS (
    SELECT id, class_names FROM mapping.sync_run
    WHERE source = 'n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1)
    SELECT count(*)::int AS snapshot_rows,
      count(*) FILTER (WHERE member.source_state = 'active')::int AS active_rows,
      count(*) FILTER (WHERE member.source_state = 'active'
        AND member.registration_status = 'on_going')::int AS eligible_rows
    FROM mapping.erp_class_membership_snapshot AS member, latest
    WHERE member.sync_run_id = latest.id
      AND upper(member.erp_class_name_snapshot) = ANY(latest.class_names)`)).rows[0];
  process.stdout.write(JSON.stringify({database: name, runs, mappings, members,
    memberCounts}));
} finally { await db.end(); }
"""
TARGET_SCRIPT = r"""
// Dữ liệu vào: kho bài thi riêng qua DATABASE_URL ở container đích.
// Việc chính: chỉ đọc mapping, roster ba đề và định nghĩa đề.
// Kết quả: JSON qua SSH về RAM, không sửa bài/điểm.
// Khi lỗi: trả exit khác 0 để dừng đối soát.
import pg from 'pg';
const db = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 10000});
const slugs = ['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56'];
try {
  const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
  const mappings = (await db.query(`SELECT erp_course_class_id::text AS class_id,
    erp_class_name_snapshot AS class_code FROM mapping.classroom_course_mapping`)).rows;
  const roster = (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id,
    erp_student_contact_id::text AS contact_id,
    student_name_snapshot AS student_name, student_ref::text AS student_ref,
    COALESCE((to_jsonb(roster)->>'is_eligible')::boolean, false) AS is_eligible
    FROM assessment.term_test_roster AS roster
    WHERE test_slug = ANY($1::text[])`, [slugs])).rows;
  const definitions = (await db.query(`SELECT slug, is_active
    FROM assessment.test_definition WHERE slug = ANY($1::text[])`, [slugs])).rows;
  const accessExists = (await db.query(`SELECT
    to_regclass('assessment.term_test_class_access') IS NOT NULL AS exists`)).rows[0].exists;
  const access = accessExists ? (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id, enabled
    FROM assessment.term_test_class_access`)).rows : [];
  process.stdout.write(JSON.stringify({database: name, mappings, roster, definitions,
    accessExists, access}));
} finally { await db.end(); }
"""


class SnapshotError(ValueError):
    """Nguồn không đủ tin cậy để lập kế hoạch ghi."""


def require(condition, code):
    if not condition:
        raise SnapshotError(code)


def plan_diff(source, target, now=None):
    """So theo (đề, ID lớp, ID học viên); trả số đếm, không trả PII."""
    now = now or datetime.now(timezone.utc)
    require(source.get("database") == "mapping_db", "WRONG_SOURCE_DATABASE")
    require(target.get("database") == "izone_mapping_k56_ic2264", "WRONG_TARGET_DATABASE")
    runs = source.get("runs") or []
    require(runs and runs[0]["status"] == "completed", "LATEST_RUN_NOT_COMPLETE")
    run = runs[0]
    require(not run.get("error_message"), "SOURCE_HAS_HEALTH_ALERT")
    finished = datetime.fromisoformat(run["finished_at"].replace("Z", "+00:00"))
    require(finished.tzinfo is not None and 0 <= (now - finished).total_seconds() <= 36 * 3600,
            "SOURCE_STALE_OR_FUTURE")
    codes = [code.upper() for code in run["class_names"]]
    require(codes and len(codes) == len(set(codes)), "DUPLICATE_OR_EMPTY_SCOPE")
    if len(runs) > 1 and runs[1]["status"] == "completed":
        require(len(codes) * 10 >= len(runs[1]["class_names"]) * 7, "CLASS_SCOPE_DROPPED")
        require(run["row_count"] * 10 >= runs[1]["row_count"] * 7,
                "SOURCE_ROWS_DROPPED")
    mappings = source.get("mappings") or []
    require(len(mappings) == len(codes), "MISSING_CLASS_MAPPING")
    by_id, by_code = {}, {}
    for item in mappings:
        class_id, code = item["class_id"], item["class_code"].upper()
        require(class_id.isdigit() and code in codes, "INVALID_CLASS_MAPPING")
        require(class_id not in by_id and code not in by_code, "DUPLICATE_CLASS_MAPPING")
        by_id[class_id], by_code[code] = code, class_id
    require(set(by_code) == set(codes), "MISSING_CLASS_MAPPING")
    members = source.get("members") or []
    require(members, "EMPTY_ELIGIBLE_ROSTER")
    source_counts = source.get("memberCounts") or {}
    require(run["row_count"] == source_counts.get("snapshot_rows")
            and isinstance(source_counts.get("active_rows"), int)
            and source_counts["active_rows"] >= source_counts.get("eligible_rows", -1)
            and source_counts["snapshot_rows"] >= source_counts["active_rows"],
            "SOURCE_SNAPSHOT_COUNT_MISMATCH")
    member_by_key, counts = {}, Counter()
    for item in members:
        key = (item["class_id"], item["contact_id"])
        require(item["class_id"] in by_id and item["contact_id"].isdigit(),
                "MEMBER_OUTSIDE_SCOPE")
        require(item["class_code"].upper() == by_id[item["class_id"]],
                "MEMBER_CLASS_CONFLICT")
        require(item["sync_run_id"] == run["id"], "MEMBER_RUN_CONFLICT")
        require(item["source_state"] == "active", "MEMBER_NOT_ACTIVE")
        require(item["registration_status"] == "on_going", "MEMBER_NOT_ONGOING")
        require(bool((item["student_name"] or "").strip()), "MEMBER_NAME_MISSING")
        require(key not in member_by_key, "DUPLICATE_MEMBER")
        member_by_key[key] = item
        counts[item["class_id"]] += 1
    require(len(member_by_key) == source_counts["eligible_rows"],
            "SOURCE_MEMBER_COUNT_MISMATCH")
    require(all(counts[class_id] > 0 for class_id in by_id), "EMPTY_CLASS_ROSTER")
    target_by_id, target_by_code = {}, {}
    for item in target.get("mappings") or []:
        class_id, code = item["class_id"], item["class_code"].upper()
        require(class_id not in target_by_id and code not in target_by_code,
                "DUPLICATE_TARGET_MAPPING")
        target_by_id[class_id], target_by_code[code] = code, class_id
    for class_id, code in by_id.items():
        require(target_by_id.get(class_id, code) == code
                and target_by_code.get(code, class_id) == class_id,
                "SOURCE_TARGET_CLASS_CONFLICT")
    definitions = target.get("definitions") or []
    require({row["slug"] for row in definitions if row["is_active"]} == set(TEST_SLUGS),
            "TEST_DEFINITIONS_NOT_READY")
    roster_by_key, refs_by_test = {}, set()
    for item in target.get("roster") or []:
        key = (item["test_slug"], item["class_id"], item["contact_id"])
        ref = (item["test_slug"], item["student_ref"])
        require(item["test_slug"] in TEST_SLUGS and key not in roster_by_key
                and ref not in refs_by_test, "DUPLICATE_TARGET_ROSTER")
        roster_by_key[key] = item
        refs_by_test.add(ref)
    added = preserved = renamed = 0
    for slug in TEST_SLUGS:
        for (class_id, contact_id), member in member_by_key.items():
            old = roster_by_key.get((slug, class_id, contact_id))
            if old is None:
                added += 1
            else:
                require(bool(old["student_ref"]), "MISSING_EXISTING_STUDENT_REF")
                preserved += 1
                renamed += old["student_name"] != member["student_name"]
    outside = sum(1 for _, class_id, contact_id in roster_by_key
                  if class_id not in by_id or (class_id, contact_id) not in member_by_key)
    return {"toolOutcome": "success", "businessOutcome": "dry_run_only",
            "syncRunId": run["id"], "classCount": len(by_id),
            "eligibleStudents": len(member_by_key), "testCount": len(TEST_SLUGS),
            "classMappingsToAdd": len(by_id.keys() - target_by_id.keys()),
            "classMappingsToPreserve": len(by_id.keys() & target_by_id.keys()),
            "rosterRowsToAdd": added, "rosterRowsToPreserve": preserved,
            "existingNamesChanged": renamed,
            "targetRosterRowsOutsideCurrentScope": outside,
            "classroomUnmatchedClasses": sum(not row.get("classroom_course_id")
                                             for row in mappings),
            "productionWrites": 0}


def prepare_import_payload(source, target, now=None, uuid_factory=uuid4):
    """Lập hàng mới trong RAM; không ghi và không xuất hồ sơ lên stdout."""
    summary = plan_diff(source, target, now)
    existing_classes = {row["class_id"] for row in target.get("mappings") or []}
    existing_roster = {
        (row["test_slug"], row["class_id"], row["contact_id"])
        for row in target.get("roster") or []
    }
    refs = {(row["test_slug"], row["student_ref"])
            for row in target.get("roster") or []}
    mappings = [
        {"class_id": row["class_id"], "class_code": row["class_code"]}
        for row in sorted(source["mappings"], key=lambda item: int(item["class_id"]))
        if row["class_id"] not in existing_classes
    ]
    members = sorted(source["members"],
                     key=lambda item: (int(item["class_id"]), int(item["contact_id"])))
    roster = []
    for slug in TEST_SLUGS:
        for member in members:
            key = (slug, member["class_id"], member["contact_id"])
            if key in existing_roster:
                continue
            try:
                student_ref = str(UUID(str(uuid_factory())))
            except (TypeError, ValueError, AttributeError) as exc:
                raise SnapshotError("INVALID_NEW_STUDENT_REF") from exc
            require((slug, student_ref) not in refs, "DUPLICATE_NEW_STUDENT_REF")
            refs.add((slug, student_ref))
            roster.append({"test_slug": slug, "class_id": member["class_id"],
                           "contact_id": member["contact_id"],
                           "student_ref": student_ref,
                           "student_name": member["student_name"]})
    require(len(mappings) == summary["classMappingsToAdd"]
            and len(roster) == summary["rosterRowsToAdd"], "IMPORT_PAYLOAD_COUNT_MISMATCH")
    return {"syncRunId": summary["syncRunId"], "summary": summary,
            "expectedMappings": target.get("mappings") or [],
            "expectedRoster": target.get("roster") or [],
            "newMappings": mappings, "newRoster": roster}


def prepare_access_payload(source, target, now=None):
    """Chỉ lập phạm vi quyền khi toàn bộ roster đã nhập và cổng quyền tồn tại."""
    summary = plan_diff(source, target, now)
    require(target.get("accessExists") is True, "CLASS_ACCESS_GATE_NOT_INSTALLED")
    require(summary["classMappingsToAdd"] == 0
            and summary["rosterRowsToAdd"] == 0,
            "ROSTER_NOT_READY_FOR_ACCESS")
    eligible_keys = {(row["class_id"], row["contact_id"])
                     for row in source["members"]}
    require(all(row.get("is_eligible") is ((row["class_id"], row["contact_id"])
                                            in eligible_keys)
                for row in target["roster"]), "ROSTER_ELIGIBILITY_NOT_RECONCILED")
    classes = sorted(source["mappings"], key=lambda row: int(row["class_id"]))
    members = sorted(source["members"],
                     key=lambda row: (int(row["class_id"]), int(row["contact_id"])))
    return {"syncRunId": summary["syncRunId"], "summary": summary,
            "scopeClasses": [{"class_id": row["class_id"], "class_code": row["class_code"]}
                             for row in classes],
            "eligibleMembers": [{"class_id": row["class_id"],
                                 "contact_id": row["contact_id"]} for row in members],
            "expectedRosterRefs": [
                {"test_slug": row["test_slug"], "class_id": row["class_id"],
                 "contact_id": row["contact_id"], "student_ref": row["student_ref"]}
                for row in target["roster"] if row["is_eligible"]
            ],
            "expectedAccess": target.get("access") or []}


def plan_eligibility_diff(source, target, now=None):
    """Chỉ đếm drift sau migration; học viên nghỉ vẫn giữ roster lịch sử."""
    summary = plan_diff(source, target, now)
    require(target.get("accessExists") is True, "CLASS_ACCESS_GATE_NOT_INSTALLED")
    current = {(row["class_id"], row["contact_id"])
               for row in source["members"]}
    scope_classes = {row["class_id"] for row in source["mappings"]}
    require(all(type(row.get("is_eligible")) is bool for row in target["roster"]),
            "ELIGIBILITY_COLUMN_NOT_READY")
    to_activate = sum(not row["is_eligible"]
                      for row in target["roster"]
                      if (row["class_id"], row["contact_id"]) in current)
    to_deactivate = sum(row["is_eligible"]
                        for row in target["roster"]
                        if (row["class_id"], row["contact_id"]) not in current)
    enabled_pairs = {(row["test_slug"], row["class_id"])
                     for row in target.get("access") or [] if row["enabled"]}
    wanted_pairs = {(slug, class_id) for slug in TEST_SLUGS
                    for class_id in scope_classes}
    return {"toolOutcome": "success", "businessOutcome": "read_only_eligibility_diff",
            "syncRunId": summary["syncRunId"],
            "classCount": summary["classCount"],
            "eligibleStudents": summary["eligibleStudents"],
            "newClassMappings": summary["classMappingsToAdd"],
            "newRosterRows": summary["rosterRowsToAdd"],
            "rosterRowsToActivate": to_activate,
            "rosterRowsToDeactivate": to_deactivate,
            "classTestPairsToEnable": len(wanted_pairs - enabled_pairs),
            "classTestPairsToDisable": len(enabled_pairs - wanted_pairs),
            "manualReviewRequired": bool(to_deactivate or enabled_pairs - wanted_pairs),
            "productionWrites": 0}


def prepare_reconcile_payload(source, target, reviewed_run_id=None, now=None):
    """Lập dữ liệu đối soát B6 trong RAM; cần duyệt riêng khi có người/lớp rời phạm vi."""
    summary = plan_diff(source, target, now)
    diff = plan_eligibility_diff(source, target, now)
    require(summary["classMappingsToAdd"] == 0 and summary["rosterRowsToAdd"] == 0,
            "NEW_ROWS_REQUIRE_IMPORT_FIRST")
    access_keys = {(row["test_slug"], row["class_id"])
                   for row in target["access"]}
    require(all((slug, row["class_id"]) in access_keys
                for slug in TEST_SLUGS for row in source["mappings"]),
            "ACCESS_ROWS_REQUIRE_ENABLE_FIRST")
    if diff["manualReviewRequired"]:
        require(str(reviewed_run_id) == summary["syncRunId"],
                "DEACTIVATION_REQUIRES_RUN_REVIEW")
    return {
        "syncRunId": summary["syncRunId"],
        "sourceSummary": summary,
        "diff": diff,
        "reviewedSyncRunId": str(reviewed_run_id) if reviewed_run_id is not None else None,
        "scopeClasses": [
            {"class_id": row["class_id"], "class_code": row["class_code"]}
            for row in sorted(source["mappings"], key=lambda item: int(item["class_id"]))
        ],
        "eligibleMembers": [
            {"class_id": row["class_id"], "contact_id": row["contact_id"]}
            for row in sorted(source["members"],
                              key=lambda item: (int(item["class_id"]),
                                                int(item["contact_id"])))
        ],
        "expectedRoster": target["roster"],
        "expectedAccess": target["access"],
    }


def remote_select(client, container, script):
    """Thực thi SELECT qua SSH; tuyệt đối không in response nhạy cảm."""
    stdin, stdout, stderr = client.exec_command(
        f"docker exec -i {container} node --input-type=module -", timeout=35)
    stdin.write(script)
    stdin.channel.shutdown_write()
    body = stdout.read()
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(f"READ_FAILED_{container}")
    return json.loads(body.decode("utf-8"))


def main():
    # Dữ liệu vào: SSH credential trong Windows Credential Manager.
    # Việc chính: đọc hai database, đối chiếu trong RAM và đóng SSH.
    # Kết quả: chỉ số lượng; khi lỗi không xuất dữ liệu học viên.
    import paramiko
    import win32cred

    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0] or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        source = remote_select(client, "mapping-review-api", SOURCE_SCRIPT)
        target = (None if "--audit-counts" in sys.argv else
                  remote_select(client, "izone-k56-ic2264-api", TARGET_SCRIPT))
    finally:
        client.close()
    if "--audit-counts" in sys.argv:
        run = (source.get("runs") or [{}])[0]
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "read_only_counts",
                          "runRowCount": run.get("row_count"),
                          "snapshotRows": (source.get("memberCounts") or {}).get("snapshot_rows"),
                          "activeRows": (source.get("memberCounts") or {}).get("active_rows"),
                          "eligibleMemberRows": len(source.get("members") or []),
                          "classCount": len(run.get("class_names") or []),
                          "productionWrites": 0}, ensure_ascii=False))
        return
    if "--audit-eligibility" in sys.argv:
        print(json.dumps(plan_eligibility_diff(source, target), ensure_ascii=False))
        return
    print(json.dumps(plan_diff(source, target), ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, (SnapshotError, RuntimeError)) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code},
                         ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
