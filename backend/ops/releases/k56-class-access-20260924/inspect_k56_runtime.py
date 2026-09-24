"""Đọc topology container để chuẩn bị canary, không xuất giá trị environment."""

import json
import sys

import paramiko
import win32cred

from trial_shared_migrations import remote


def main():
    # Dữ liệu vào: inspect hai API và database chung.
    # Việc chính: chỉ liệt kê network, tên env và volume mount không nhạy cảm.
    # Kết quả: topology để thiết kế canary không đổi API thật.
    # Khi lỗi: dừng, không suy đoán network hoặc compose.
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
        data = {}
        for name in ("mapping-review-api", "izone-k56-ic2264-api", "mapping-postgres"):
            raw = remote(client, f"docker inspect {name}", code="DOCKER_INSPECT_FAILED")
            items = json.loads(raw)
            if len(items) != 1:
                raise RuntimeError("DOCKER_INSPECT_AMBIGUOUS")
            item = items[0]
            data[name] = {
                "image": item["Config"]["Image"],
                "imageId": item["Image"],
                "networks": sorted(item["NetworkSettings"]["Networks"]),
                "environmentKeys": sorted(value.split("=", 1)[0]
                                          for value in item["Config"]["Env"]),
                "mountDestinations": sorted(mount["Destination"]
                                            for mount in item.get("Mounts") or []),
                "composeProject": item["Config"].get("Labels", {}).get(
                    "com.docker.compose.project"),
                "composeService": item["Config"].get("Labels", {}).get(
                    "com.docker.compose.service"),
                "health": item["State"].get("Health", {}).get("Status"),
            }
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "read_only_runtime_topology",
                          "containers": data, "productionWrites": 0}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
