"""Chuẩn bị image API mới từ snapshot source production đã kiểm hash."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.live_source.resolve()
    output = args.output.resolve()
    root = Path(__file__).resolve().parent
    expected = json.loads((root / "live-api-baseline-sha256.json").read_text(encoding="utf-8"))
    if not source.is_dir() or output == source or source in output.parents or output in source.parents:
        raise RuntimeError("SOURCE_OR_OUTPUT_INVALID")
    if output.exists() and any(output.iterdir()):
        raise RuntimeError("OUTPUT_MUST_BE_EMPTY")

    # Dữ liệu nhận vào: bốn file source đọc từ image live, không chứa secret.
    # Việc chính: kiểm từng hash, sao chép vào nơi trống rồi áp bản vá đã review.
    # Kết quả: năm file dùng làm build context; không sửa image hoặc VPS.
    # Khi lỗi: dừng trước build và báo mã ngắn, giữ source live nguyên trạng.
    files = [name for name, digest in expected.items() if digest is not None]
    for name in files:
        actual = hashlib.sha256((source / name).read_bytes()).hexdigest()
        if actual != expected[name]:
            raise RuntimeError(f"LIVE_SOURCE_CHANGED:{name}")
    target = output / "src"
    target.mkdir(parents=True, exist_ok=True)
    for name in files:
        shutil.copy2(source / name, target / name)
    patch = root / "live-api-overlay.patch"
    for extra in ("--check", ""):
        command = ["git", "apply"] + ([extra] if extra else []) + [str(patch)]
        subprocess.run(command, cwd=output, check=True, capture_output=True)
    for name in expected:
        subprocess.run(["node", "--check", str(target / name)], check=True, capture_output=True)
    print(json.dumps({"outcome": "prepared", "files": len(expected), "source_hashes_verified": True}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"PREPARE_FAILED:{type(error).__name__}:{str(error)[:120]}", file=sys.stderr)
        sys.exit(1)
