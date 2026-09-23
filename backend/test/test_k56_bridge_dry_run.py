"""Regression cho việc đối soát K56: lỗi phải dừng, không lộ hồ sơ học viên."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest


SCRIPT = (Path(__file__).parents[1] / "ops" / "releases" /
          "k56-class-access-20260924" / "bridge_dry_run.py")
spec = importlib.util.spec_from_file_location("k56_bridge_dry_run", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
NOW = datetime(2026, 9, 24, 8, 0, tzinfo=timezone.utc)


def fixture():
    # Dữ liệu vào: hai lớp và hai học viên giả, không phải hồ sơ thật.
    # Việc chính: tạo nguồn/đích có một mã học viên riêng theo từng đề.
    # Kết quả: fixture đủ kiểm giữ UUID mà không cần truy cập production.
    # Khi lỗi: mọi test fail nếu cấu trúc giả không còn theo hợp đồng.
    source = {
        "database": "mapping_db",
        "runs": [{"id": "102", "status": "completed", "class_names": ["IC2264", "IC2322"],
                  "row_count": 2, "error_message": None,
                  "finished_at": "2026-09-24T07:00:00Z"},
                 {"id": "98", "status": "completed", "class_names": ["IC2264"],
                  "row_count": 1}],
        "mappings": [
            {"class_id": "1252", "class_code": "IC2264", "classroom_course_id": "course-a"},
            {"class_id": "2322", "class_code": "IC2322", "classroom_course_id": None},
        ],
        "members": [
            {"class_id": "1252", "class_code": "IC2264", "contact_id": "101",
             "student_name": "Học viên giả A", "registration_status": "on_going",
             "source_state": "active", "sync_run_id": "102"},
            {"class_id": "2322", "class_code": "IC2322", "contact_id": "202",
             "student_name": "Học viên giả B", "registration_status": "on_going",
             "source_state": "active", "sync_run_id": "102"},
        ],
        "memberCounts": {"snapshot_rows": 2, "active_rows": 2, "eligible_rows": 2},
    }
    target = {
        "database": "izone_mapping_k56_ic2264",
        "mappings": [{"class_id": "1252", "class_code": "IC2264"}],
        "definitions": [{"slug": slug, "is_active": True} for slug in bridge.TEST_SLUGS],
        "roster": [
            {"test_slug": slug, "class_id": "1252", "contact_id": "101",
             "student_name": "Học viên giả A",
             "is_eligible": True,
             "student_ref": f"00000000-0000-4000-8000-{index:012d}"}
            for index, slug in enumerate(bridge.TEST_SLUGS, start=1)
        ],
    }
    return source, target


def ready_target(source, target):
    # Dữ liệu vào: fixture nguồn/đích tổng hợp, không có hồ sơ thật.
    # Việc chính: mô phỏng B3–B5 đã hoàn tất để kiểm drift B6.
    # Kết quả: đích trong RAM có roster và quyền ba đề; không ghi database.
    additions = bridge.prepare_import_payload(source, target, NOW)
    target["mappings"].extend(additions["newMappings"])
    target["roster"].extend({**row, "is_eligible": True}
                            for row in additions["newRoster"])
    target["accessExists"] = True
    target["access"] = [
        {"test_slug": slug, "class_id": mapping["class_id"], "enabled": True}
        for slug in bridge.TEST_SLUGS for mapping in source["mappings"]
    ]


class BridgeDryRunTest(unittest.TestCase):
    def fail_code(self, source, target, expected):
        with self.assertRaises(bridge.SnapshotError) as raised:
            bridge.plan_diff(source, target, NOW)
        self.assertEqual(str(raised.exception), expected)

    def test_preserves_per_test_refs_and_reports_only_counts(self):
        source, target = fixture()
        result = bridge.plan_diff(source, target, NOW)
        self.assertEqual(result["classMappingsToAdd"], 1)
        self.assertEqual(result["rosterRowsToAdd"], 3)
        self.assertEqual(result["rosterRowsToPreserve"], 3)
        self.assertEqual(result["classroomUnmatchedClasses"], 1)
        self.assertEqual(result["productionWrites"], 0)
        self.assertNotIn("Học viên", str(result))
        self.assertNotIn("student_ref", str(result))
        self.assertNotIn("contact_id", str(result))
        self.assertEqual(len(set(row["student_ref"] for row in target["roster"])), 3)

    def test_reordered_source_and_rerun_have_identical_diff(self):
        source, target = fixture()
        baseline = bridge.plan_diff(source, target, NOW)
        source["mappings"].reverse()
        source["members"].reverse()
        self.assertEqual(bridge.plan_diff(source, target, NOW), baseline)
        for slug in bridge.TEST_SLUGS:
            target["roster"].append({"test_slug": slug, "class_id": "2322",
                                     "contact_id": "202", "student_name": "Học viên giả B",
                                     "student_ref": f"00000000-0000-4000-9000-00000000000{len(target['roster'])}"})
        target["mappings"].append({"class_id": "2322", "class_code": "IC2322"})
        rerun = bridge.plan_diff(source, target, NOW)
        self.assertEqual(rerun["rosterRowsToAdd"], 0)
        self.assertEqual(rerun["rosterRowsToPreserve"], 6)
        self.assertEqual(rerun["classMappingsToAdd"], 0)

    def test_latest_run_query_sorts_numeric_id_not_text_alias(self):
        self.assertIn("ORDER BY run.id DESC LIMIT 2", bridge.SOURCE_SCRIPT)
        source, target = fixture()
        self.assertEqual(bridge.plan_diff(source, target, NOW)["syncRunId"], "102")

    def test_zero_members_and_empty_class_fail_closed(self):
        source, target = fixture()
        source["members"] = []
        self.fail_code(source, target, "EMPTY_ELIGIBLE_ROSTER")
        source, target = fixture()
        source["members"].pop()
        self.fail_code(source, target, "SOURCE_MEMBER_COUNT_MISMATCH")

    def test_missing_one_member_or_incorrect_run_total_fail_closed(self):
        source, target = fixture()
        source["runs"][0]["row_count"] = 3
        self.fail_code(source, target, "SOURCE_SNAPSHOT_COUNT_MISMATCH")
        source, target = fixture()
        source["members"].pop()
        self.fail_code(source, target, "SOURCE_MEMBER_COUNT_MISMATCH")

    def test_run_total_may_include_students_not_ongoing(self):
        source, target = fixture()
        source["runs"][0]["row_count"] = 3
        source["memberCounts"] = {"snapshot_rows": 3, "active_rows": 3,
                                  "eligible_rows": 2}
        self.assertEqual(bridge.plan_diff(source, target, NOW)["eligibleStudents"], 2)

    def test_stale_failed_or_degraded_run_fail_closed(self):
        source, target = fixture()
        source["runs"][0]["finished_at"] = (NOW - timedelta(hours=37)).isoformat()
        self.fail_code(source, target, "SOURCE_STALE_OR_FUTURE")
        source, target = fixture()
        source["runs"][0]["status"] = "failed"
        self.fail_code(source, target, "LATEST_RUN_NOT_COMPLETE")
        source, target = fixture()
        source["runs"][0]["error_message"] = "health alert"
        self.fail_code(source, target, "SOURCE_HAS_HEALTH_ALERT")
        source, target = fixture()
        source["runs"][1]["class_names"] = [f"IC{i}" for i in range(10)]
        self.fail_code(source, target, "CLASS_SCOPE_DROPPED")

    def test_wrong_database_or_missing_definition_fail_closed(self):
        source, target = fixture()
        source["database"] = "wrong"
        self.fail_code(source, target, "WRONG_SOURCE_DATABASE")
        source, target = fixture()
        target["database"] = "wrong"
        self.fail_code(source, target, "WRONG_TARGET_DATABASE")
        source, target = fixture()
        target["definitions"].pop()
        self.fail_code(source, target, "TEST_DEFINITIONS_NOT_READY")

    def test_duplicate_members_and_class_identity_conflict_fail_closed(self):
        source, target = fixture()
        source["members"].append(deepcopy(source["members"][0]))
        self.fail_code(source, target, "DUPLICATE_MEMBER")
        source, target = fixture()
        target["mappings"].append({"class_id": "9999", "class_code": "IC2322"})
        self.fail_code(source, target, "SOURCE_TARGET_CLASS_CONFLICT")
        source, target = fixture()
        source["mappings"][1]["class_id"] = "1252"
        self.fail_code(source, target, "DUPLICATE_CLASS_MAPPING")

    def test_cross_class_member_or_wrong_run_fail_closed(self):
        source, target = fixture()
        source["members"][1]["class_code"] = "IC2264"
        self.fail_code(source, target, "MEMBER_CLASS_CONFLICT")
        source, target = fixture()
        source["members"][1]["sync_run_id"] = "98"
        self.fail_code(source, target, "MEMBER_RUN_CONFLICT")

    def test_outside_scope_roster_is_reported_not_deleted(self):
        source, target = fixture()
        target["roster"].append({"test_slug": bridge.TEST_SLUGS[0], "class_id": "9999",
                                 "contact_id": "999", "student_name": "Ngoài phạm vi",
                                 "student_ref": "00000000-0000-4000-8000-000000000099"})
        result = bridge.plan_diff(source, target, NOW)
        self.assertEqual(result["targetRosterRowsOutsideCurrentScope"], 1)
        self.assertEqual(result["productionWrites"], 0)

    def test_import_payload_uses_class_and_contact_ids_not_classroom_or_name(self):
        source, target = fixture()
        payload = bridge.prepare_import_payload(source, target, NOW)
        self.assertEqual(payload["syncRunId"], "102")
        self.assertEqual(payload["newMappings"],
                         [{"class_id": "2322", "class_code": "IC2322"}])
        self.assertEqual({(row["test_slug"], row["class_id"], row["contact_id"])
                          for row in payload["newRoster"]},
                         {(slug, "2322", "202") for slug in bridge.TEST_SLUGS})
        self.assertEqual(len({row["student_ref"] for row in payload["newRoster"]}), 3)
        self.assertNotIn("classroom_course_id", str(payload["newMappings"]))
        self.assertEqual(payload["expectedRoster"], target["roster"])
        self.assertEqual(payload["summary"]["productionWrites"], 0)

    def test_import_payload_preserves_existing_refs_on_rerun(self):
        source, target = fixture()
        old_refs = {(row["test_slug"], row["class_id"], row["contact_id"]):
                    row["student_ref"] for row in target["roster"]}
        payload = bridge.prepare_import_payload(source, target, NOW)
        target["mappings"].extend(payload["newMappings"])
        target["roster"].extend(payload["newRoster"])
        rerun = bridge.prepare_import_payload(source, target, NOW)
        self.assertEqual(rerun["newMappings"], [])
        self.assertEqual(rerun["newRoster"], [])
        self.assertEqual({key: row["student_ref"] for row in target["roster"]
                          if (key := (row["test_slug"], row["class_id"],
                                      row["contact_id"])) in old_refs}, old_refs)

    def test_import_payload_is_order_independent_and_rejects_ref_collision(self):
        source, target = fixture()
        first = bridge.prepare_import_payload(source, target, NOW)
        source["mappings"].reverse()
        source["members"].reverse()
        second = bridge.prepare_import_payload(source, target, NOW)
        self.assertEqual([(row["test_slug"], row["class_id"], row["contact_id"])
                          for row in first["newRoster"]],
                         [(row["test_slug"], row["class_id"], row["contact_id"])
                          for row in second["newRoster"]])
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "DUPLICATE_NEW_STUDENT_REF"):
            bridge.prepare_import_payload(
                source, target, NOW,
                uuid_factory=lambda: "00000000-0000-4000-8000-000000000001")

    def test_access_payload_waits_for_gate_and_complete_roster(self):
        source, target = fixture()
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "CLASS_ACCESS_GATE_NOT_INSTALLED"):
            bridge.prepare_access_payload(source, target, NOW)
        target["accessExists"] = True
        target["access"] = [{"test_slug": slug, "class_id": "1252", "enabled": True}
                            for slug in bridge.TEST_SLUGS]
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "ROSTER_NOT_READY_FOR_ACCESS"):
            bridge.prepare_access_payload(source, target, NOW)
        additions = bridge.prepare_import_payload(source, target, NOW)
        target["mappings"].extend(additions["newMappings"])
        target["roster"].extend({**row, "is_eligible": True}
                                for row in additions["newRoster"])
        access = bridge.prepare_access_payload(source, target, NOW)
        self.assertEqual(len(access["scopeClasses"]), 2)
        self.assertEqual(len(access["eligibleMembers"]), 2)
        self.assertEqual(len(access["expectedRosterRefs"]), 6)
        self.assertEqual(len(access["expectedAccess"]), 3)
        self.assertNotIn("Học viên", str(access))
        target["roster"].pop()
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "ROSTER_NOT_READY_FOR_ACCESS"):
            bridge.prepare_access_payload(source, target, NOW)

    def test_access_payload_keeps_inactive_historical_roster_out_of_scope(self):
        source, target = fixture()
        target["accessExists"] = True
        target["access"] = [{"test_slug": slug, "class_id": "1252", "enabled": True}
                            for slug in bridge.TEST_SLUGS]
        additions = bridge.prepare_import_payload(source, target, NOW)
        target["mappings"].extend(additions["newMappings"])
        target["roster"].extend({**row, "is_eligible": True}
                                for row in additions["newRoster"])
        target["roster"].append({"test_slug": bridge.TEST_SLUGS[0],
                                 "class_id": "9999", "contact_id": "999",
                                 "student_name": "Học viên lịch sử giả",
                                 "student_ref": "00000000-0000-4000-8000-000000000099",
                                 "is_eligible": False})
        access = bridge.prepare_access_payload(source, target, NOW)
        self.assertEqual(len(access["expectedRosterRefs"]), 6)
        target["roster"][0]["is_eligible"] = False
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "ROSTER_ELIGIBILITY_NOT_RECONCILED"):
            bridge.prepare_access_payload(source, target, NOW)

    def test_eligibility_diff_reports_departure_without_deleting_history(self):
        source, target = fixture()
        source["members"].append({"class_id": "1252", "class_code": "IC2264",
                                  "contact_id": "303", "student_name": "Học viên giả C",
                                  "registration_status": "on_going",
                                  "source_state": "active", "sync_run_id": "102"})
        source["runs"][0]["row_count"] = 3
        source["memberCounts"] = {"snapshot_rows": 3, "active_rows": 3,
                                  "eligible_rows": 3}
        ready_target(source, target)
        clean = bridge.plan_eligibility_diff(source, target, NOW)
        self.assertEqual(clean["rosterRowsToDeactivate"], 0)
        self.assertFalse(clean["manualReviewRequired"])
        source["members"].pop()
        source["memberCounts"]["eligible_rows"] = 2
        drift = bridge.plan_eligibility_diff(source, target, NOW)
        self.assertEqual(drift["rosterRowsToDeactivate"], 3)
        self.assertTrue(drift["manualReviewRequired"])
        self.assertEqual(len(target["roster"]), 9)
        self.assertNotIn("Học viên", str(drift))

    def test_eligibility_diff_requires_gate_and_migrated_column(self):
        source, target = fixture()
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "CLASS_ACCESS_GATE_NOT_INSTALLED"):
            bridge.plan_eligibility_diff(source, target, NOW)
        target["accessExists"] = True
        target["roster"][0].pop("is_eligible")
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "ELIGIBILITY_COLUMN_NOT_READY"):
            bridge.plan_eligibility_diff(source, target, NOW)

    def test_reconcile_payload_requires_review_for_student_departure(self):
        source, target = fixture()
        source["members"].append({"class_id": "1252", "class_code": "IC2264",
                                  "contact_id": "303", "student_name": "Học viên giả C",
                                  "registration_status": "on_going",
                                  "source_state": "active", "sync_run_id": "102"})
        source["runs"][0]["row_count"] = 3
        source["memberCounts"] = {"snapshot_rows": 3, "active_rows": 3,
                                  "eligible_rows": 3}
        ready_target(source, target)
        clean = bridge.prepare_reconcile_payload(source, target, now=NOW)
        self.assertFalse(clean["diff"]["manualReviewRequired"])
        source["members"].pop()
        source["memberCounts"]["eligible_rows"] = 2
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "DEACTIVATION_REQUIRES_RUN_REVIEW"):
            bridge.prepare_reconcile_payload(source, target, now=NOW)
        approved = bridge.prepare_reconcile_payload(source, target,
                                                    reviewed_run_id="102", now=NOW)
        self.assertEqual(approved["diff"]["rosterRowsToDeactivate"], 3)
        self.assertEqual(len(approved["expectedRoster"]), 9)
        self.assertEqual(approved["reviewedSyncRunId"], "102")

    def test_reconcile_payload_waits_for_import_of_new_roster(self):
        source, target = fixture()
        target["accessExists"] = True
        target["access"] = []
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "NEW_ROWS_REQUIRE_IMPORT_FIRST"):
            bridge.prepare_reconcile_payload(source, target, now=NOW)
        ready_target(source, target)
        target["access"].pop()
        with self.assertRaisesRegex(bridge.SnapshotError,
                                    "ACCESS_ROWS_REQUIRE_ENABLE_FIRST"):
            bridge.prepare_reconcile_payload(source, target, now=NOW)


if __name__ == "__main__":
    unittest.main()
