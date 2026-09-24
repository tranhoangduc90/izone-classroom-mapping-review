"""Dựng image K56 từ đúng cây source production đã kiểm thử, chưa đổi service."""

import argparse
import json
import posixpath
from pathlib import Path
import re
import shlex
import subprocess
import sys

import paramiko
import win32cred


RELEASE_DIR = Path(__file__).resolve().parent
VERIFY_SCRIPT = RELEASE_DIR / "verify-source-hashes.mjs"
REMOTE_PREFIX = "/opt/izone-k56-shared-db-20260924-build-"


def checked_output(client, command, code):
    """Chạy lệnh đã khóa tham số và không phát tán output thô khi lỗi."""
    channel = client.get_transport().open_session(timeout=20)
    channel.set_combine_stderr(True)
    channel.settimeout(300)
    channel.exec_command(command)
    body = channel.makefile("r").read().decode("utf-8", errors="replace")
    if channel.recv_exit_status() != 0:
        raise RuntimeError(code)
    return body.strip()


def validate_context(context):
    """Chỉ nhận gói source đã xuất và có dấu SHA đúng lần test đầy đủ."""
    manifest = json.loads((context / "release-manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("toolOutcome") != "success"
            or manifest.get("businessOutcome") != "tested_build_context_exported"
            or manifest.get("productionWrites") != 0
            or manifest.get("imageBuilt") is not False
            or manifest.get("productionDeployed") is not False
            or "ℹ fail 0" not in manifest.get("testSummary", [])
            or "ℹ skipped 0" not in manifest.get("testSummary", [])):
        raise RuntimeError("BUILD_CONTEXT_NOT_TESTED")
    required = ["candidateSourceSha256", "baseSourceSha256", "baseImageId",
                "baseImageTag", "basePackageHashes"]
    if any(not manifest.get(key) for key in required):
        raise RuntimeError("BUILD_CONTEXT_MANIFEST_INCOMPLETE")
    package_hashes = manifest["basePackageHashes"]
    if any(not re.fullmatch(r"[0-9a-f]{64}", value or "")
           for value in [manifest["candidateSourceSha256"],
                         manifest["baseSourceSha256"],
                         package_hashes.get("package.json"),
                         package_hashes.get("package-lock.json")]):
        raise RuntimeError("BUILD_CONTEXT_HASH_INVALID")
    subprocess.run(["node", str(VERIFY_SCRIPT), str(context / "src"),
                    manifest["candidateSourceSha256"]],
                   check=True, capture_output=True, text=True)
    expected_files = {"release-manifest.json",
                      "ops/releases/k56-class-access-20260924/Dockerfile",
                      "ops/releases/k56-class-access-20260924/verify-source-hashes.mjs"}
    present = {path.relative_to(context).as_posix()
               for path in context.rglob("*") if path.is_file()}
    if not expected_files.issubset(present):
        raise RuntimeError("BUILD_CONTEXT_FILES_MISSING")
    if any(path.is_symlink() for path in context.rglob("*")):
        raise RuntimeError("BUILD_CONTEXT_SYMLINK_NOT_ALLOWED")
    return manifest, sorted(path for path in context.rglob("*") if path.is_file())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--remote-suffix", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()
    context = args.context.resolve(strict=True)
    if not re.fullmatch(r"[a-z0-9-]{1,32}", args.remote_suffix):
        raise RuntimeError("REMOTE_SUFFIX_INVALID")
    if not re.fullmatch(r"izone-k56-live-results:20260924\.[a-z0-9.-]{1,40}", args.tag):
        raise RuntimeError("IMAGE_TAG_INVALID")
    manifest, files = validate_context(context)
    remote_dir = REMOTE_PREFIX + args.remote_suffix
    if args.preflight_only:
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "build_context_checked",
                          "candidateSourceSha256": manifest["candidateSourceSha256"],
                          "fileCount": len(files), "remoteDirectory": remote_dir,
                          "imageTag": args.tag, "productionWrites": 0}))
        return

    # Dữ liệu vào: source đã qua 214 test, Credential Manager trên máy vận hành.
    # Việc chính: kiểm image nền, tải source vào thư mục mới rồi build image không cache.
    # Kết quả: image đã kiểm SHA; API production vẫn dùng image cũ.
    # Khi lỗi: dừng, báo mã lỗi; không đổi container hoặc database.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    uploaded = False
    try:
        quoted_base = shlex.quote(manifest["baseImageTag"])
        base_id = checked_output(client,
                                 f"docker image inspect --format '{{{{.Id}}}}' {quoted_base}",
                                 "BASE_IMAGE_MISSING")
        if base_id != manifest["baseImageId"]:
            raise RuntimeError("BASE_IMAGE_CHANGED")
        quoted_tag = shlex.quote(args.tag)
        _stdin, stdout, stderr = client.exec_command(
            f"docker image inspect {quoted_tag} >/dev/null 2>&1", timeout=20)
        stdout.read()
        stderr.read()
        if stdout.channel.recv_exit_status() == 0:
            raise RuntimeError("TARGET_IMAGE_ALREADY_EXISTS")
        sftp = client.open_sftp()
        try:
            try:
                sftp.stat(remote_dir)
            except FileNotFoundError:
                pass
            else:
                raise RuntimeError("REMOTE_BUILD_DIRECTORY_ALREADY_EXISTS")
            sftp.mkdir(remote_dir, mode=0o700)
            for local in files:
                relative = local.relative_to(context).as_posix()
                remote = posixpath.join(remote_dir, relative)
                parents = relative.split("/")[:-1]
                folder = remote_dir
                for part in parents:
                    folder = posixpath.join(folder, part)
                    try:
                        sftp.mkdir(folder, mode=0o700)
                    except OSError:
                        sftp.stat(folder)
                sftp.put(str(local), remote)
            uploaded = True
        finally:
            sftp.close()

        verify = posixpath.join(remote_dir,
            "ops/releases/k56-class-access-20260924/verify-source-hashes.mjs")
        checked_output(client,
                       f"node {shlex.quote(verify)} "
                       f"{shlex.quote(posixpath.join(remote_dir, 'src'))} "
                       f"{manifest['candidateSourceSha256']}",
                       "REMOTE_SOURCE_HASH_MISMATCH")
        dockerfile = posixpath.join(remote_dir,
            "ops/releases/k56-class-access-20260924/Dockerfile")
        args_list = [
            "docker", "build", "--no-cache",
            "--build-arg", f"BASE_IMAGE={manifest['baseImageTag']}",
            "--build-arg", f"EXPECTED_BASE_SOURCE_SHA={manifest['baseSourceSha256']}",
            "--build-arg", f"EXPECTED_BASE_PACKAGE_SHA={manifest['basePackageHashes']['package.json']}",
            "--build-arg", f"EXPECTED_BASE_LOCK_SHA={manifest['basePackageHashes']['package-lock.json']}",
            "--build-arg", f"EXPECTED_CANDIDATE_SOURCE_SHA={manifest['candidateSourceSha256']}",
            "-f", dockerfile, "-t", args.tag, remote_dir,
        ]
        build_command = " ".join(shlex.quote(part) for part in args_list)
        checked_output(client, build_command, "IMAGE_BUILD_FAILED")
        image_id = checked_output(client,
                                  f"docker image inspect --format '{{{{.Id}}}}' {quoted_tag}",
                                  "IMAGE_READBACK_FAILED")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "image_built_not_deployed",
                          "imageId": image_id,
                          "candidateSourceSha256": manifest["candidateSourceSha256"],
                          "remoteDirectory": remote_dir,
                          "imageTag": args.tag, "productionServiceChanged": False}))
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                          "sourceUploaded": uploaded, "productionServiceChanged": False}),
              file=sys.stderr)
        raise SystemExit(2)
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
