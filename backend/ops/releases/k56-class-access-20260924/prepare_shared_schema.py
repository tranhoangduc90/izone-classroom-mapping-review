"""Tạo migration K56 đã đổi schema từ bản pg_dump chỉ-schema đã kiểm."""

import hashlib
import json
from pathlib import Path
import re
import sys


SOURCE = Path("E:/Codex-Data/izone-release-candidates/k56-shared-database/k56-assessment-schema.sql")
EXPECTED_SOURCE_SHA256 = "905758b7666d85c61d8f8ddf4d114a43e561629f1866d2690b63d34900ae2ce6"
TARGET = Path(__file__).resolve().parents[2] / "migrations" / "202609240003_k56_assessment_schema.sql"


def build_migration(source):
    # Dữ liệu vào: DDL không chứa hàng dữ liệu từ đúng database K56 đã kiểm hash.
    # Việc chính: đổi tên schema trong DDL, bỏ lệnh meta psql và đặt trong giao dịch.
    # Kết quả: migration chỉ tạo schema K56 mới, không sửa schema bài thi K67.
    # Khi lỗi: dừng trước khi ghi nếu còn tham chiếu schema cũ hoặc câu lệnh phá hủy.
    if "CREATE SCHEMA assessment;" not in source:
        raise ValueError("SOURCE_SCHEMA_NOT_FOUND")
    body = source[source.index("CREATE SCHEMA assessment;"):]
    body = "\n".join(line for line in body.splitlines() if not line.startswith("\\"))
    body, replacements = re.subn(r"\bassessment\b", "assessment_k56", body)
    if replacements < 50 or "CREATE SCHEMA assessment_k56;" not in body:
        raise ValueError("SCHEMA_REWRITE_INCOMPLETE")
    if (re.search(r"\bassessment\b", body) or "CREATE SCHEMA mapping" in body
            or re.search(r"\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|COPY)\s+", body)):
        # Function demo hiện chứa DELETE/UPDATE trong thân hàm; chỉ chặn câu ghi cấp đầu.
        for line in body.splitlines():
            if re.match(r"^(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|COPY)\s+", line):
                raise ValueError("UNEXPECTED_TOP_LEVEL_MUTATION")
        if re.search(r"\bassessment\b", body) or "CREATE SCHEMA mapping" in body:
            raise ValueError("UNEXPECTED_SCHEMA_REFERENCE")
    header = (
        "-- Dữ liệu vào: DDL chỉ-schema của database K56 hiện hành; SHA-256 nguồn: "
        + EXPECTED_SOURCE_SHA256 + ".\n"
        "-- Việc chính: tạo schema bài thi K56 bên trong mapping_db, không đổi assessment K67.\n"
        "-- Kết quả: bảng, view, sequence, function và ràng buộc K56 đúng nguồn.\n"
        "-- Khi lỗi: toàn giao dịch rollback; không sửa dữ liệu K67 hoặc hồ sơ học viên.\n"
        "BEGIN;\nSET LOCAL lock_timeout = '3s';\n"
        "SET LOCAL statement_timeout = '120s';\n"
        "SET LOCAL check_function_bodies = off;\n\n"
    )
    return header + body.rstrip() + "\n\nCOMMIT;\n"


def main():
    # Dữ liệu vào: file riêng tư E: do công cụ xuất chỉ-schema tạo ra.
    # Việc chính: kiểm dấu nguồn rồi tạo migration review được trong Git.
    # Kết quả: đường dẫn/hash migration; không lấy nội dung đề hoặc học viên.
    raw = SOURCE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED_SOURCE_SHA256:
        raise RuntimeError("SOURCE_SCHEMA_HASH_CHANGED")
    candidate = build_migration(raw.decode("utf-8"))
    if TARGET.exists():
        raise RuntimeError("TARGET_MIGRATION_ALREADY_EXISTS")
    TARGET.write_text(candidate, encoding="utf-8", newline="\n")
    print(json.dumps({"toolOutcome": "success", "businessOutcome": "local_migration_generated",
                      "sourceSha256": EXPECTED_SOURCE_SHA256,
                      "migrationSha256": hashlib.sha256(candidate.encode("utf-8")).hexdigest(),
                      "path": TARGET.as_posix(), "productionWrites": 0}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
