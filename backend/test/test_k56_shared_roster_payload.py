"""Kiểm chuyển roster K56 sang kho chung bằng dữ liệu giả, không dùng học viên thật."""

from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
import unittest
from uuid import UUID


RELEASE = Path(__file__).parents[1] / "ops" / "releases" / "k56-class-access-20260924"
sys.path.insert(0, str(RELEASE))
from import_shared_roster import prepare_rows  # noqa: E402
from bridge_dry_run import SnapshotError, TEST_SLUGS  # noqa: E402

BRIDGE_TEST = Path(__file__).parent / "test_k56_bridge_dry_run.py"
spec = importlib.util.spec_from_file_location("k56_bridge_fixture", BRIDGE_TEST)
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)
NOW = datetime(2026, 9, 24, 8, 0, tzinfo=timezone.utc)


def three_classes():
    source, pilot = fixture_module.fixture()
    source["runs"][0]["class_names"].append("IC2326")
    source["runs"][0]["row_count"] = 3
    source["memberCounts"] = {"snapshot_rows": 3, "active_rows": 3,
                              "eligible_rows": 3}
    source["mappings"].append({"class_id": "2326", "class_code": "IC2326",
                                "classroom_course_id": None})
    source["members"].append({"class_id": "2326", "class_code": "IC2326",
                              "contact_id": "303", "student_name": "Học viên giả C",
                              "registration_status": "on_going", "source_state": "active",
                              "sync_run_id": "102"})
    return source, pilot


class SharedRosterPayloadTest(unittest.TestCase):
    def test_preserves_pilot_uuids_and_includes_two_classes_without_classroom(self):
        source, pilot = three_classes()
        fixed_uuid = lambda: UUID("00000000-0000-4000-a000-000000000123")
        with self.assertRaises(SnapshotError):
            prepare_rows(source, pilot, NOW, fixed_uuid)
        counter = iter(range(100, 106))
        summary, rows = prepare_rows(source, pilot, NOW,
                                     lambda: UUID(f"00000000-0000-4000-a000-{next(counter):012d}"))
        self.assertEqual(summary["classCount"], 3)
        self.assertEqual(summary["classroomUnmatchedClasses"], 2)
        self.assertEqual(len(rows), 9)
        self.assertEqual({row["class_id"] for row in rows}, {"1252", "2322", "2326"})
        original = {(row["test_slug"], row["class_id"], row["contact_id"]): row["student_ref"]
                    for row in pilot["roster"]}
        self.assertEqual({key: row["student_ref"] for row in rows
                          if (key := (row["test_slug"], row["class_id"],
                                      row["contact_id"])) in original}, original)
        self.assertEqual({row["test_slug"] for row in rows}, set(TEST_SLUGS))

    def test_missing_approved_class_or_historical_pilot_fails_closed(self):
        source, pilot = three_classes()
        source["mappings"].pop()
        with self.assertRaises(SnapshotError):
            prepare_rows(source, pilot, NOW)
        source, pilot = three_classes()
        pilot["roster"].append({"test_slug": TEST_SLUGS[0], "class_id": "9999",
                                "contact_id": "999", "student_name": "Ngoài phạm vi",
                                "student_ref": "00000000-0000-4000-8000-000000000099",
                                "is_eligible": False})
        with self.assertRaisesRegex(SnapshotError,
                                    "PILOT_HISTORICAL_ROWS_REQUIRE_SEPARATE_PLAN"):
            prepare_rows(source, pilot, NOW)


if __name__ == "__main__":
    unittest.main()
