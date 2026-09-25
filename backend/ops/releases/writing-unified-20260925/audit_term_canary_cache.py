"""Đọc tồn tại của đúng hai khóa canary, không lấy giá trị bài hay secret."""

import argparse
import json
import re
import sys

from seed_term_canary_from_execution import PROFILES, load_anonymized_cache
from term_canary_container import connect, remote


def main():
    # Dữ liệu vào: runKey của đúng execution bài giả và tên khóa do canary tạo.
    # Việc chính: hỏi Redis EXISTS, không GET; chỉ in số khóa còn lại.
    # Kết quả: xác nhận workflow đã xóa cache sau khi callback hoàn tất.
    # Khi lỗi: giữ unknown, không xóa hoặc retry bài.
    parser = argparse.ArgumentParser()
    parser.add_argument("--sync-key")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="term")
    args = parser.parse_args()
    cache = json.loads(load_anonymized_cache(args.profile))
    run_key = cache["runKey"]
    if not re.fullmatch(re.escape(PROFILES[args.profile]["slug"])
                        + r":[A-Za-z0-9_:-]{1,200}", run_key):
        raise RuntimeError("TERM_CANARY_RUN_KEY_UNSAFE")
    client = connect()
    try:
        if args.sync_key:
            sync_key = args.sync_key
        else:
            _, raw = remote(client, "docker exec writing-term-api-canary node "
                            "ops/releases/writing-unified-20260925/term_canary_audit.mjs")
            sync_key = json.loads(raw)["syncKey"]
        if not re.fullmatch(
                r"codex:writing:term_canary:[0-9a-f-]{36}:sync_secret", sync_key):
            raise RuntimeError("TERM_CANARY_SYNC_KEY_UNSAFE")
        keys = [sync_key, "termtest:writing:direct:" + run_key]
        counts = []
        for key in keys:
            _, count = remote(client, "docker exec redis redis-cli --raw EXISTS " + key)
            if count not in {"0", "1"}:
                raise RuntimeError("TERM_CANARY_REDIS_EXISTS_INVALID")
            counts.append(int(count))
        return {"toolOutcome": "success", "businessOutcome": "readback",
                "syncKeyExists": counts[0] == 1,
                "cacheKeyExists": counts[1] == 1}
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(main()))
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                          "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
