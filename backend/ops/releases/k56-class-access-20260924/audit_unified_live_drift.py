"""So hash source K56/K67 đang chạy với candidate Git; chỉ đọc production."""

import hashlib
import json
from pathlib import Path
import sys

import paramiko
import win32cred


BACKEND = Path(__file__).resolve().parents[3]
REMOTE_SCRIPT = r"""
// Dữ liệu vào: file JS trong src và DATABASE_URL của container hiện hành.
// Việc chính: chỉ tính hash sau chuẩn hóa CRLF, không gửi nội dung source.
// Kết quả: tên file, hash và database thực tế; không đọc .env hay học viên.
// Khi lỗi: exit khác 0 để không suy diễn bản đang chạy đã khớp candidate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
const files = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const name = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(name);
    else if (entry.isFile() && name.endsWith('.js')) {
      const content = fs.readFileSync(name).toString('utf8').replace(/\r\n/g, '\n');
      files[name.slice(4)] = crypto.createHash('sha256').update(content).digest('hex');
    }
  }
}
walk('src');
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 10000});
try {
  const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  process.stdout.write(JSON.stringify({database, files}));
} finally { await pool.end(); }
"""


def remote_read(client, container):
    # Dữ liệu vào: container đã xác định và code chỉ tính hash.
    # Việc chính: chạy SELECT + hash bên trong container, kiểm exit.
    # Kết quả: metadata không chứa source hoặc học viên.
    stdin, stdout, stderr = client.exec_command(
        f"docker exec -i {container} node --input-type=module -", timeout=45)
    stdin.write(REMOTE_SCRIPT)
    stdin.channel.shutdown_write()
    raw = stdout.read()
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(f"SOURCE_HASH_READ_FAILED_{container}")
    return json.loads(raw.decode("utf-8"))


def main():
    # Dữ liệu vào: quyền SSH trong Credential Manager và source branch hiện tại.
    # Việc chính: so theo tên file/hash nội dung, không theo thứ tự hoặc số dòng.
    # Kết quả: số lượng và tên module cần rà; không ghi VPS hoặc file.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0] or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        k56 = remote_read(client, "izone-k56-ic2264-api")
        k67 = remote_read(client, "mapping-review-api")
    finally:
        client.close()
    if (k56.get("database") != "izone_mapping_k56_ic2264"
            or k67.get("database") != "mapping_db"):
        raise RuntimeError("UNEXPECTED_PROFILE_DATABASE")
    candidate = {}
    for file in (BACKEND / "src").rglob("*.js"):
        name = file.relative_to(BACKEND / "src").as_posix()
        content = file.read_bytes().replace(b"\r\n", b"\n")
        candidate[name] = hashlib.sha256(content).hexdigest()
    categories = {name: [] for name in (
        "matches_both", "matches_k56_only", "matches_k67_only",
        "differs_both", "branch_only", "live_only")}
    k56_files, k67_files = k56["files"], k67["files"]
    for name in sorted(set(candidate) | set(k56_files) | set(k67_files)):
        if name not in candidate:
            category = "live_only"
        elif name not in k56_files and name not in k67_files:
            category = "branch_only"
        else:
            same_k56 = candidate[name] == k56_files.get(name)
            same_k67 = candidate[name] == k67_files.get(name)
            category = ("matches_both" if same_k56 and same_k67 else
                        "matches_k56_only" if same_k56 else
                        "matches_k67_only" if same_k67 else "differs_both")
        categories[category].append(name)
    print(json.dumps({"toolOutcome": "success", "businessOutcome": "read_only_audit",
                      "k56SourceCount": len(k56_files), "k67SourceCount": len(k67_files),
                      "candidateSourceCount": len(candidate),
                      "categories": categories,
                      "counts": {name: len(items) for name, items in categories.items()},
                      "productionWrites": 0}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
