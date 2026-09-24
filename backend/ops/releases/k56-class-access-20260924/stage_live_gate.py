"""Chạy regression trên bản sao source K56 production đã ghép cổng quyền.

Chỉ đọc VPS. Bản sao tạm nằm dưới backend worktree và được dọn sau kiểm tra.
Không đưa source live, hồ sơ học viên hoặc credential vào Git hay stdout.
"""

import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import paramiko
import win32cred

from reconcile_live_gate import FILES, read_live_files, smoke_sql, try_overlay


BACKEND = Path(__file__).resolve().parents[3]
RELEASE = Path(__file__).resolve().parent
EXPORT_ROOT = Path("E:/Codex-Data/izone-release-candidates")
TESTS = (
    "term-test-k56-class-access-database.test.js",
    "k56-portal-class-scope.test.js",
    "term-test-portal-sync-class-access-database.test.js",
    "term-tests-database.test.js",
)
TEST_MIGRATIONS = (
    "202608260002_term_test_submission_reliability.sql",
    "202609230001_term_test_writing_draft_revision.sql",
    "202609230002_term_test_listening_checkpoint.sql",
    "202609240001_term_test_k56_class_access.sql",
    "202609240002_term_test_k56_roster_eligibility.sql",
    "202609240003_k56_assessment_schema.sql",
    "202609240004_k56_roster_eligibility.sql",
    "202609240005_k56_class_access.sql",
    "202609240006_k56_shared_api_grants.sql",
    "202609240007_k56_roster_reconcile_grants.sql",
)
BROADER_TESTS = (
    "api.test.js", "term-tests.test.js", "term-test-writing-grading.test.js",
    "writing-tests.test.js", "writing-tests-database.test.js",
)
UNIFIED_BRANCH_MODULES = (
    "app.js", "auth.js", "assessment-schema-pool.js", "config.js", "db.js",
    "deployment-profile.js",
    "learning-contracts.js", "learning-domain.js", "learning-outbox.js",
    "learning-routes.js", "learning-service.js", "learning-sql.js",
    "server.js", "sql.js", "teacher-class-access-sql.js",
    "teacher-class-access-health.js", "term-test-assets.js",
    "term-test-result-events.js", "term-test-writing-grading.js",
    "lark-replica-worker.js", "writing-portal-worker.js",
)
CURRENT_LIVE_IMAGE = "sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956"
CURRENT_LIVE_TAG = "izone-k56-live-results:20260924.4-roster-reconcile"
ROSTER_RECONCILE_MODULES = (
    "assessment-schema-pool.js", "config.js", "server.js", "k56-roster-reconcile.js",
)
REMOTE_TREE_SCRIPT = r"""
// Dữ liệu vào: thư mục src trong container K56 đang chạy.
// Việc chính: chỉ đọc file .js để dựng bản kiểm tạm trên máy vận hành.
// Kết quả: code được mã hóa base64 qua SSH, không đọc .env hoặc dữ liệu học viên.
// Khi lỗi: exit khác 0; không tạo bản stage từ cây source thiếu.
import fs from 'node:fs';
import path from 'node:path';
const files = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const filename = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (entry.isFile() && filename.endsWith('.js')) {
      files[filename] = fs.readFileSync(filename).toString('base64');
    }
  }
}
walk('src');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageHashes = {};
for (const name of ['package.json', 'package-lock.json']) {
  packageHashes[name] = fs.existsSync(name)
    ? (await import('node:crypto')).createHash('sha256')
      .update(fs.readFileSync(name)).digest('hex')
    : null;
}
process.stdout.write(JSON.stringify({files, packageHashes,
  dependencies: packageJson.dependencies ?? {},
  devDependencies: packageJson.devDependencies ?? {},
  nodeVersion: process.version}));
"""


def read_live_tree():
    # Dữ liệu vào: SSH credential và container K56 hiện hành.
    # Việc chính: chỉ đọc các file JS trong src, không in nội dung.
    # Kết quả: dict source ở RAM; lỗi SSH/JSON làm dừng stage.
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
            "docker exec -i izone-k56-ic2264-api node --input-type=module -", timeout=45)
        stdin.write(REMOTE_TREE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read()
        stderr.read()
        if stdout.channel.recv_exit_status() != 0:
            raise RuntimeError("LIVE_SOURCE_TREE_READ_FAILED")
        image_stdin, image_stdout, image_stderr = client.exec_command(
            "docker inspect --format '{{.Image}}|{{.Config.Image}}' izone-k56-ic2264-api",
            timeout=20)
        image_stdin.channel.shutdown_write()
        image = image_stdout.read().decode("utf-8").strip()
        image_stderr.read()
        if image_stdout.channel.recv_exit_status() != 0:
            raise RuntimeError("LIVE_IMAGE_READ_FAILED")
    finally:
        client.close()
    remote = json.loads(body.decode("utf-8"))
    encoded = remote.get("files") or {}
    if not encoded or not set(FILES).issubset(encoded):
        raise RuntimeError("LIVE_SOURCE_TREE_INCOMPLETE")
    for name in encoded:
        pure = Path(name)
        if (not name.startswith("src/") or pure.is_absolute()
                or ".." in pure.parts or not name.endswith(".js")):
            raise RuntimeError("LIVE_SOURCE_TREE_UNSAFE_PATH")
    image_parts = image.split("|")
    expected_image = (CURRENT_LIVE_IMAGE if "--from-current-live" in sys.argv else None)
    expected_tag = (CURRENT_LIVE_TAG if "--from-current-live" in sys.argv
                    else "izone-k56-live-results:20260920.1-teacher-session")
    if (len(image_parts) != 2 or not image_parts[0].startswith("sha256:")
            or image_parts[1] != expected_tag
            or (expected_image and image_parts[0] != expected_image)
            or not all(remote.get("packageHashes", {}).get(name)
                       for name in ("package.json", "package-lock.json"))):
        raise RuntimeError("LIVE_IMAGE_OR_PACKAGE_UNEXPECTED")
    local_package = json.loads((BACKEND / "package.json").read_text(encoding="utf-8"))
    if (remote["dependencies"] != local_package.get("dependencies")
            or remote["devDependencies"] != local_package.get("devDependencies")):
        raise RuntimeError("LIVE_DEPENDENCY_VERSIONS_DIFFER")
    return ({name: base64.b64decode(value, validate=True)
             for name, value in encoded.items()},
            {"imageId": image_parts[0], "imageTag": image_parts[1],
             "packageHashes": remote["packageHashes"],
             "nodeVersion": remote["nodeVersion"]})


def seal_source_files(files):
    """Dấu toàn cây dùng cùng hợp đồng đường dẫn với bộ kiểm trong Docker."""
    seal = hashlib.sha256()
    for relative in sorted(files):
        seal.update(relative.encode("utf-8") + b"\0")
        seal.update(files[relative])
        seal.update(b"\0")
    return seal.hexdigest()


def export_build_context(stage_root, candidate_sha, base_sha, base_meta, test_summary):
    """Chỉ lưu bản đã qua test vào ổ E; không sao chép .env hoặc dữ liệu học viên."""
    root = EXPORT_ROOT.resolve()
    root.mkdir(parents=True, exist_ok=True)
    exported = Path(tempfile.mkdtemp(prefix="k56-class-access-", dir=root)).resolve()
    if not exported.is_relative_to(root):
        raise RuntimeError("UNSAFE_EXPORT_PATH")
    shutil.copytree(stage_root / "src", exported / "src")
    release_out = exported / "ops" / "releases" / "k56-class-access-20260924"
    release_out.mkdir(parents=True)
    for name in ("Dockerfile", "verify-source-hashes.mjs"):
        shutil.copy2(RELEASE / name, release_out / name)
    migrations_out = exported / "ops" / "migrations"
    migrations_out.mkdir(parents=True)
    for name in TEST_MIGRATIONS[-4:]:
        shutil.copy2(BACKEND / "ops" / "migrations" / name, migrations_out / name)
    verification = subprocess.run(
        ["node", str(release_out / "verify-source-hashes.mjs"),
         str(exported / "src"), candidate_sha], capture_output=True,
        encoding="utf-8", errors="replace", timeout=20)
    if verification.returncode != 0:
        raise RuntimeError("EXPORTED_SOURCE_HASH_MISMATCH")
    manifest = {
        "toolOutcome": "success", "businessOutcome": "tested_build_context_exported",
        "candidateSourceSha256": candidate_sha,
        "baseSourceSha256": base_sha,
        "baseImageId": base_meta["imageId"],
        "baseImageTag": base_meta["imageTag"],
        "basePackageHashes": base_meta["packageHashes"],
        "baseNodeVersion": base_meta["nodeVersion"],
        "testSummary": test_summary, "productionWrites": 0,
        "imageBuilt": False, "productionDeployed": False,
    }
    (exported / "release-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return exported.as_posix()


def run_stage():
    # Dữ liệu vào: source live, hai commit cổng quyền và test trên branch.
    # Việc chính: dựng bản sao tạm bên trong backend, chạy test rồi dọn đúng đích.
    # Kết quả: số test đạt/không đạt; không ảnh hưởng production.
    # Khi lỗi: trả mã lỗi và không tuyên bố release sẵn sàng.
    controls = {} if "--from-current-live" in sys.argv else read_live_files()
    tree, base_meta = read_live_tree()
    base_source_sha = seal_source_files(tree)
    if "--audit-admin" in sys.argv:
        auth = tree["src/auth.js"].decode("utf-8")
        sql = tree["src/sql.js"].decode("utf-8")
        app = tree["src/app.js"].decode("utf-8")
        legacy = re.search(r"export const listTermTestTeacherOptionsLegacySql = `([\s\S]*?)`;", sql)
        return {"toolOutcome": "success", "businessOutcome": "read_only_admin_audit",
                "roleAutomaticallyGrantsAllClasses": "role === 'admin'" in auth,
                "legacyOptionsAcceptsAdminParameter": bool(legacy and "$2" in legacy.group(1)),
                "appPassesAdminFlag": "[req.reviewer.email, req.reviewer.canAccessAllClasses]" in app,
                "teacherResponseIncludesAccessMode": "accessMode: row.access_mode" in app,
                "productionWrites": 0}
    if "--from-current-live" in sys.argv:
        candidates = {}
    else:
        for name in FILES:
            if hashlib.sha256(controls[name]).digest() != hashlib.sha256(tree[name]).digest():
                raise RuntimeError("LIVE_SOURCE_CHANGED_DURING_READ")
        summary, candidates = try_overlay(controls, return_candidates=True)
        if any(row["status"] != "compatible" for row in summary.values()):
            raise RuntimeError("LIVE_OVERLAY_CONFLICT")
    selected_tests = TESTS + (("production-profiles.test.js",)
                              if "--profile-tests" in sys.argv else ())
    if "--export-context" in sys.argv and not ({"--unified-candidate", "--full-suite"}
                                               <= set(sys.argv)):
        raise RuntimeError("EXPORT_REQUIRES_FULL_UNIFIED_SUITE")
    if "--broader-tests" in sys.argv:
        selected_tests += BROADER_TESTS
    if "--full-suite" in sys.argv:
        if "--unified-candidate" not in sys.argv:
            raise RuntimeError("FULL_SUITE_REQUIRES_UNIFIED_CANDIDATE")
        selected_tests = tuple(path.name for path in sorted((BACKEND / "test").glob("*.test.js")))
    stage_root = Path(tempfile.mkdtemp(prefix=".k56-gate-stage-", dir=BACKEND)).resolve()
    if not stage_root.is_relative_to(BACKEND.resolve()):
        raise RuntimeError("UNSAFE_STAGE_PATH")
    try:
        (stage_root / "src").mkdir(exist_ok=True)
        (stage_root / "test").mkdir(exist_ok=True)
        (stage_root / "ops" / "migrations").mkdir(parents=True, exist_ok=True)
        (stage_root / "docs" / "migrations").mkdir(parents=True, exist_ok=True)
        shutil.copy2(BACKEND / "package.json", stage_root / "package.json")
        if "--full-suite" in sys.argv:
            shutil.copytree(BACKEND / "ops", stage_root / "ops", dirs_exist_ok=True)
            shutil.copytree(BACKEND.parent / "docs", stage_root / "docs", dirs_exist_ok=True)
            shutil.copytree(BACKEND / "scripts", stage_root / "scripts", dirs_exist_ok=True)
            shutil.copytree(BACKEND / "workflows", stage_root / "workflows",
                            dirs_exist_ok=True)
        for name, raw in tree.items():
            destination = stage_root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        for name, code in candidates.items():
            (stage_root / name).write_text(code, encoding="utf-8", newline="\n")
        if "--unified-candidate" in sys.argv:
            overlay_names = (ROSTER_RECONCILE_MODULES if "--from-current-live" in sys.argv
                             else UNIFIED_BRANCH_MODULES)
            for name in overlay_names:
                shutil.copy2(BACKEND / "src" / name, stage_root / "src" / name)
        if "--full-suite" in sys.argv:
            for original in (BACKEND / "src").rglob("*.js"):
                destination = stage_root / "src" / original.relative_to(BACKEND / "src")
                if not destination.exists():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(original, destination)
        sql_smoke = smoke_sql((stage_root / "src" / "sql.js").read_text(encoding="utf-8"))
        for name in selected_tests:
            original = (BACKEND / "test" / name).read_text(encoding="utf-8")
            if "--compat-k56-live" in sys.argv and name == "term-tests-database.test.js":
                live_sql = tree["src/sql.js"].decode("utf-8")
                modern = re.search(r"export const listTermTestTeacherOptionsSql = `([\s\S]*?)`;",
                                   live_sql)
                anchor = "listTermTestTeacherOptionsSql, ['teacher@gmail.com', false]"
                if modern is None or "$2" in modern.group(1) or original.count(anchor) != 1:
                    raise RuntimeError("UNEXPECTED_K56_OPTIONS_CONTRACT")
                original = original.replace(
                    anchor, "listTermTestTeacherOptionsSql, ['teacher@gmail.com']", 1)
            if "--diagnose-query" in sys.argv and name == "term-tests-database.test.js":
                marker = "  const database = new PGlite();"
                wrapper = r"""  const database = new PGlite();
  let stagedQueryNumber = 0;
  const stagedOriginalQuery = database.query.bind(database);
  database.query = async (...args) => {
    stagedQueryNumber += 1;
    try { return await stagedOriginalQuery(...args); }
    catch (error) {
      const queryLabel = args[0] === listTermTestTeacherOptionsLegacySql
        ? 'legacy_options' : args[0] === listTermTestTeacherOptionsSql ? 'options' : 'other';
      const placeholders = [...String(args[0]).matchAll(/\$(\d+)/g)]
        .map(match => Number(match[1]));
      error.message = `STAGED_QUERY_${stagedQueryNumber}_${queryLabel}`
        + `_ARGS_${args[1]?.length ?? 0}_MAX_${Math.max(0, ...placeholders)} ${error.message}`;
      throw error;
    }
  };"""
                if original.count(marker) != 1:
                    raise RuntimeError("STAGE_DIAGNOSTIC_ANCHOR_MISSING")
                original = original.replace(marker, wrapper, 1)
            for migration in re.findall(r"\.\./\.\./docs/migrations/([^'\"]+)", original):
                shutil.copy2(BACKEND.parent / "docs" / "migrations" / migration,
                             stage_root / "docs" / "migrations" / migration)
            staged = original.replace("../../docs/migrations/", "../docs/migrations/")
            if name == "term-test-writing-capacity.test.js":
                staged = staged.replace("resolve(backendRoot, '..', 'docs'",
                                        "resolve(backendRoot, 'docs'")
            (stage_root / "test" / name).write_text(staged, encoding="utf-8")
        for migration in TEST_MIGRATIONS:
            shutil.copy2(BACKEND / "ops" / "migrations" / migration,
                         stage_root / "ops" / "migrations" / migration)
        # Đóng dấu toàn bộ source ứng viên để lần build image phải dùng đúng cây đã kiểm.
        source_seal = hashlib.sha256()
        for candidate_file in sorted((stage_root / "src").rglob("*.js")):
            relative = candidate_file.relative_to(stage_root).as_posix()
            source_seal.update(relative.encode("utf-8") + b"\0")
            source_seal.update(candidate_file.read_bytes())
            source_seal.update(b"\0")
        candidate_sha = source_seal.hexdigest()
        command = ["node", "--test", *[f"test/{name}" for name in selected_tests]]
        process = subprocess.run(command, cwd=stage_root, capture_output=True,
                                 timeout=240, encoding="utf-8", errors="replace")
        summary_lines = re.findall(r"[ℹ#] (?:tests|pass|fail|skipped) \d+", process.stdout)
        failure_lines = re.findall(
            r"(?:✖|error:|code:|failureType:|ERR_MODULE_NOT_FOUND|STAGED_QUERY_\d+|\bat [^\n]*\.test\.js:\d+:\d+)[^\n]*",
            process.stdout + "\n" + process.stderr)[:12]
        failed_tests = re.findall(r"^✖ [^\n]*", process.stdout, re.MULTILINE)[:30]
        error_messages = re.findall(r"^\s*error: [^\n]*", process.stdout, re.MULTILINE)[:30]
        failed_at = process.stdout.find("error: bind message")
        failure_context = (process.stdout[failed_at:failed_at + 900].splitlines()[:12]
                           if failed_at >= 0 else [])
        test_locations = re.findall(r"term-tests-database\.test\.js:\d+:\d+",
                                    process.stdout)
        exported = (export_build_context(stage_root, candidate_sha, base_source_sha,
                                         base_meta, summary_lines)
                    if process.returncode == 0 and "--export-context" in sys.argv
                    else None)
        return {"toolOutcome": "success" if process.returncode == 0 else "failure",
                "businessOutcome": "stage_tests_passed" if process.returncode == 0
                else "stage_tests_failed", "exitCode": process.returncode,
                "sourceFiles": len(tree), "overlayFiles": len(candidates),
                "candidateSourceSha256": candidate_sha,
                "baseSourceSha256": base_source_sha,
                "baseImageId": base_meta["imageId"],
                "basePackageHashes": base_meta["packageHashes"],
                "buildContext": exported,
                "candidateMode": "unified_branch_modules" if "--unified-candidate" in sys.argv
                else "live_gate_overlay",
                "sqlSmokePassed": sql_smoke["passed"], "testSummary": summary_lines,
                "failureSummary": failure_lines,
                "failedTests": failed_tests,
                "errorMessages": error_messages,
                "failureContext": failure_context,
                "testLocations": list(dict.fromkeys(test_locations))[:8],
                "productionWrites": 0}
    finally:
        if not stage_root.is_relative_to(BACKEND.resolve()):
            raise RuntimeError("UNSAFE_STAGE_CLEANUP_PATH")
        shutil.rmtree(stage_root)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        result = run_stage()
        print(json.dumps(result, ensure_ascii=False))
        if result["toolOutcome"] != "success":
            raise SystemExit(2)
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
