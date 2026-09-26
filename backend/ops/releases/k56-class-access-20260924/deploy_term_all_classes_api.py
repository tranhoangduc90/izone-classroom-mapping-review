"""Phát hành API Term K56 đã thử; chỉ đổi service K56 khi hàng chờ còn trống."""

import argparse
import json
import sys

import paramiko
import win32cred

from deploy_term_minimal_api import REMOTE_ROLLBACK_SCRIPT, REMOTE_SCRIPT


REPLACEMENTS = {
    "izone-k56-live-results:20260924.6-term-minimal-portal-rc":
        "izone-k56-live-results:20260924.7-term-all-classes-rc",
    "sha256:81dcbf688730155737084b87bc2250851317d283aeb2519a4c47276012517608":
        "sha256:79dacbc8af471f28b6b598041f5a455dcbd33457e394289e3159aa3a17f17531",
    "compose.term-minimal-portal.yml": "compose.term-all-classes.yml",
    "k56-term-minimal-portal-20260926.6": "k56-term-all-classes-20260926.7",
    "dd90c33bcd53f8dc145f98ceb1aa14957c4321676221dbd6d66efc0743168545":
        "3a828ccfa105aa994dd06cc4dbb856044c403700b964327ae898cfccbd8d1954",
}
REQUIRED_IN_ROLLBACK = set(list(REPLACEMENTS)[:3])


def build_script(template, deploy=None):
    # Dữ liệu vào: kịch bản phát hành/rollback đã có guard và định danh image mới.
    # Việc chính: thay đúng tag, digest, overlay và nhãn build; không bỏ guard.
    # Kết quả: mã chạy trên VPS chỉ in trạng thái tổng hợp.
    # Khi lỗi: dừng trước SSH và không thay container.
    result = template
    for old, new in REPLACEMENTS.items():
        if old not in result and (deploy is not None or old in REQUIRED_IN_ROLLBACK):
            raise RuntimeError("DEPLOY_TEMPLATE_CHANGED")
        result = result.replace(old, new)
    if deploy is not None:
        if result.count("__DEPLOY__") != 1:
            raise RuntimeError("DEPLOY_MODE_PLACEHOLDER_CHANGED")
        result = result.replace("__DEPLOY__", "True" if deploy else "False")
    if any(old in result for old in REPLACEMENTS):
        raise RuntimeError("DEPLOY_OLD_IMAGE_REFERENCE_REMAINS")
    return result


def remote_call(script):
    # Dữ liệu vào: credential SSH trong Windows Keyring, không vào file hoặc log.
    # Việc chính: chạy đúng một kịch bản đã khóa trên VPS1.
    # Kết quả: báo cáo JSON không chứa env hoặc định danh học viên.
    # Khi lỗi: giữ trạng thái lỗi; không tự chạy lại hoặc rollback mù.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=240)
        stdin.write(script)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        if stdout.channel.recv_exit_status() != 0:
            try:
                code = json.loads(error).get("errorCode", "REMOTE_RELEASE_FAILED")
            except (ValueError, TypeError):
                code = "REMOTE_RELEASE_FAILED"
            raise RuntimeError(code)
        report = json.loads(body)
        if report.get("toolOutcome") != "success":
            raise RuntimeError("RELEASE_REPORT_INVALID")
        return report
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deploy", action="store_true")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    if args.deploy and args.rollback:
        parser.error("--deploy và --rollback loại trừ nhau")
    if args.rollback:
        script = build_script(REMOTE_ROLLBACK_SCRIPT)
    else:
        script = build_script(REMOTE_SCRIPT, deploy=args.deploy)
    report = remote_call(script)
    expected = ("api_rolled_back_writer_unchanged" if args.rollback
                else "api_deployed_awaiting_e2e" if args.deploy
                else "preflight_ready")
    if report.get("businessOutcome") != expected:
        raise RuntimeError("RELEASE_OUTCOME_INVALID")
    print(json.dumps(report))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
