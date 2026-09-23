"""Thử ghép lớp vá cổng K56 vào source live trong RAM, không ghi VPS/file."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

FILES = (
    "src/sql.js", "src/app.js", "src/erp-sync.js", "src/k56-portal-pilot.js",
    "src/term-test-portal-sync.js", "src/term-test-writing-grading.js",
)
COMMITS = ("5b11f81", "25667ca")
SEMANTIC_GUARDS = {
    "src/sql.js": (("FROM assessment.term_test_class_access AS access", 3),
                   ("AND right($2, 4) <> '-k56'", 2)),
    "src/app.js": (("isK56PortalAttempt", 2),),
    "src/erp-sync.js": (("isK56ClassTestGranted", 2),),
    "src/k56-portal-pilot.js": (("isK56PortalAttempt", 1),),
    "src/term-test-portal-sync.js": (("assessment.term_test_class_access", 1),),
    "src/term-test-writing-grading.js": (("isK56PortalAttempt", 2),),
}
REMOTE_SCRIPT = r"""
// Dữ liệu vào: sáu file code trong image K56 hiện hành.
// Việc chính: gửi nội dung code qua SSH đến RAM máy đối soát, không đọc .env.
// Kết quả: base64 chỉ được xử lý trong tiến trình Python, không in ra báo cáo.
// Khi lỗi: exit khác 0 để dừng kiểm tra lớp vá.
import fs from 'node:fs';
const paths = ['src/sql.js', 'src/app.js', 'src/erp-sync.js',
  'src/k56-portal-pilot.js', 'src/term-test-portal-sync.js',
  'src/term-test-writing-grading.js'];
const files = {};
for (const path of paths) {
  if (!fs.existsSync(path)) throw new Error('required source missing');
  files[path] = fs.readFileSync(path).toString('base64');
}
process.stdout.write(JSON.stringify(files));
"""


def read_live_files():
    # Dữ liệu vào: quyền SSH trong Credential Manager và image K56 đang chạy.
    # Việc chính: chỉ đọc file code; toàn bộ nội dung ở RAM, không tạo backup.
    # Kết quả: dict path→bytes cho phép thử vá cục bộ.
    # Khi lỗi: không in nội dung source hoặc credential.
    import base64
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
        stdin, stdout, stderr = client.exec_command(
            "docker exec -i izone-k56-ic2264-api node --input-type=module -", timeout=35)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read()
        stderr.read()
        if stdout.channel.recv_exit_status() != 0:
            raise RuntimeError("LIVE_SOURCE_READ_FAILED")
    finally:
        client.close()
    encoded = json.loads(body.decode("utf-8"))
    if set(encoded) != set(FILES):
        raise RuntimeError("LIVE_SOURCE_FILES_MISMATCH")
    return {path: base64.b64decode(encoded[path], validate=True) for path in FILES}


def changed_hunks(commit, path):
    """Tách hunk từ Git diff; không ghi patch file hoặc động vào source."""
    result = subprocess.run(
        ["git", "diff", "--no-ext-diff", "--unified=3", f"{commit}^", commit,
         "--", f"backend/{path}"], capture_output=True, check=True)
    lines = result.stdout.decode("utf-8").splitlines(keepends=True)
    hunks = []
    old, new, removed, added, start = None, None, None, None, None
    for line in lines:
        if line.startswith("@@"):
            if old is not None:
                hunks.append((start, "".join(old), "".join(new), removed, added))
            start = int(re.match(r"@@ -(\d+)", line).group(1))
            old, new, removed, added = [], [], [], []
        elif old is not None and line.startswith(" "):
            old.append(line[1:])
            new.append(line[1:])
        elif old is not None and line.startswith("-"):
            old.append(line[1:])
            removed.append(line[1:])
        elif old is not None and line.startswith("+"):
            new.append(line[1:])
            added.append(line[1:])
    if old is not None:
        hunks.append((start, "".join(old), "".join(new), removed, added))
    return hunks


def try_overlay(data, return_candidates=False):
    """Áp hunk đúng một vị trí vào bản sao RAM; xung đột thì dừng an toàn."""
    result = {}
    candidates = {}
    for path, raw in data.items():
        value = raw.decode("utf-8")
        original_hash = hashlib.sha256(raw).hexdigest()
        line_endings = {"crlf": value.count("\r\n"),
                        "lf": value.count("\n") - value.count("\r\n")}
        value = value.replace("\r\n", "\n")
        count = 0
        conflict = None
        for commit in COMMITS:
            for start, old, new, removed, added in changed_hunks(commit, path):
                locations = []
                cursor = 0
                while True:
                    found = value.find(old, cursor)
                    if found < 0:
                        break
                    locations.append(found)
                    cursor = found + 1
                if locations:
                    distances = [(abs(value.count("\n", 0, pos) + 1 - start), pos)
                                 for pos in locations]
                    distances.sort()
                    if len(distances) > 1 and distances[0][0] == distances[1][0]:
                        conflict = {"commit": commit, "hunk": count + 1,
                                    "matchingLocations": len(locations), "reason": "ambiguous"}
                        break
                    pos = distances[0][1]
                    value = value[:pos] + new + value[pos + len(old):]
                elif len(removed) == len(added) == 1 and value.count(removed[0]) == 1:
                    # Một dòng đổi tên import duy nhất; context ở bản live khác branch.
                    value = value.replace(removed[0], added[0], 1)
                else:
                    conflict = {"commit": commit, "hunk": count + 1,
                                "matchingLocations": len(locations), "reason": "context_changed"}
                    break
                count += 1
            if conflict is not None:
                break
        syntax_valid = None
        if conflict is None:
            if any(value.count(fragment) < minimum
                   for fragment, minimum in SEMANTIC_GUARDS[path]):
                conflict = {"commit": "semantic", "hunk": count,
                            "matchingLocations": 0, "reason": "GATE_FRAGMENT_MISSING"}
        if conflict is None:
            syntax = subprocess.run(["node", "--check", "--input-type=module"],
                                    input=value.encode("utf-8"), capture_output=True)
            syntax_valid = syntax.returncode == 0
            if not syntax_valid:
                conflict = {"commit": "syntax", "hunk": count,
                            "matchingLocations": 0, "reason": "NODE_CHECK_FAILED"}
        result[path] = {"liveHash": original_hash, "lineEndings": line_endings,
                        "hunksAppliedInMemory": count,
                        "candidateHash": hashlib.sha256(value.encode("utf-8")).hexdigest()
                        if conflict is None else None,
                        "syntaxValid": syntax_valid,
                        "status": "compatible" if conflict is None else "conflict",
                        "conflict": conflict}
        if conflict is None:
            candidates[path] = value
    return (result, candidates) if return_candidates else result


def smoke_sql(code):
    """Chạy ba SQL đã ghép trên PostgreSQL RAM; không chuyển hồ sơ học viên."""
    exports = {}
    for name in ("listTermTestRosterSql", "findStudentForTermTestSql",
                 "registerTemporaryTermTestStudentSql"):
        match = re.search(rf"export const {name} = `([\s\S]*?)`;", code)
        if match is None:
            raise RuntimeError("OVERLAY_SQL_EXPORT_MISSING")
        exports[name] = match.group(1)
    script = Path(__file__).with_name("overlay_sql_smoke.mjs")
    backend = Path(__file__).parents[3]
    process = subprocess.run(["node", str(script)], cwd=backend,
                             input=json.dumps(exports).encode("utf-8"),
                             capture_output=True, timeout=30)
    if process.returncode != 0:
        raise RuntimeError("OVERLAY_SQL_SMOKE_FAILED")
    result = json.loads(process.stdout.decode("utf-8"))
    if result.get("toolOutcome") != "success" or result.get("passed") != 10:
        raise RuntimeError("OVERLAY_SQL_SMOKE_INVALID")
    return result


def main():
    # Dữ liệu vào: source live và hai commit chỉ chứa cổng quyền K56.
    # Việc chính: thử ghép từng hunk trong RAM, không ghi file/VPS.
    # Kết quả: chỉ hash/số hunk/xung đột; không in source code.
    files = read_live_files()
    result, candidates = try_overlay(files, return_candidates=True)
    smoke = None
    if all(row["status"] == "compatible" for row in result.values()):
        smoke = smoke_sql(candidates["src/sql.js"])
    print(json.dumps({"toolOutcome": "success", "businessOutcome":
                      "compatible" if all(row["status"] == "compatible"
                                          for row in result.values()) else "conflict",
                      "productionWrites": 0, "sqlSmoke": smoke,
                      "files": result}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
