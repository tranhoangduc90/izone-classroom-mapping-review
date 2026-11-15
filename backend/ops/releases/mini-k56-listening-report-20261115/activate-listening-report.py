"""Activate only Mini K56 Listening reporting on the pinned shared K56 runtime."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import time
from types import FunctionType


ROOT = Path(__file__).resolve().parent
PREVIOUS = Path("/opt/izone-mini-k56-recovery-20261112/operator.py")
API = "izone-k56-ic2264-api"
OLD = API + "-before-listening-report-20261115"
NEW = API + "-listening-report-candidate-20261115"
BOT_MOUNT = "/run/mini-k56-listening-report/telegram.json"
POLICY_MOUNT = "/run/mini-k56-listening-report-policy"
SOURCE_DIR = "/app/src/"
BASE_FILES = {
    "src/mini-offline.mjs", "src/mini-k56-recovery-core.mjs",
    "src/k56-exam-order.js", "src/app.js",
    "src/exam-journal-runtime/adapters/term-k56-offline.mjs",
    "src/exam-journal-runtime/adapters/term.mjs",
}
MODULES = {
    "contract.mjs", "telegram-alerts.mjs", "listening-report-runtime.mjs",
    "listening-report-native.mjs", "listening-report-online.mjs",
    "listening-report-ingress.mjs", "listening-report-queue.mjs",
}
MIGRATION = "mini-listening-report.sql"


def check(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def private_mount(ident, target):
    matches = [row for row in ident["Mounts"] if row["Destination"] == target and not row["RW"]]
    check(len(matches) == 1, "MISSING_EXACT_READ_ONLY_MOUNT")
    source = Path(matches[0]["Source"])
    check(source.is_absolute() and source.is_file() and not source.is_symlink(), "INVALID_READ_ONLY_SOURCE")
    return source


def credential_from_collector(switch):
    collector = switch.inspect("izone-log-k67-v1")
    settings = json.loads(private_mount(collector, "/run/exam-journal/config.json").read_text())
    target = settings["alerting"]["telegram"]["credentialFile"]
    check(target.startswith("/run/"), "INVALID_TELEGRAM_CREDENTIAL_PATH")
    source = private_mount(collector, target)
    check(stat.S_IMODE(source.stat().st_mode) & 0o077 == 0, "UNSAFE_TELEGRAM_CREDENTIAL_MODE")
    bound = json.loads(source.read_text())
    expected = (ROOT / "authorized-destination.private.txt").read_text().strip()
    check(re.fullmatch(r"-[1-9][0-9]{5,15}", expected) and str(bound["chatId"]) == expected,
          "WRONG_AUTHORIZED_TELEGRAM_DESTINATION")
    return source


def plan(h):
    cmd, switch, env_of = (h[key] for key in ("cmd", "switch", "env_of"))
    manifest = json.loads((ROOT / "manifest.json").read_text())
    build = (ROOT / "release-sha.txt").read_text().strip()
    check(re.fullmatch("[a-f0-9]{40}", build), "MISSING_RELEASE_SHA")
    check(manifest["product"] == "mini-test-k56" and manifest["overlayVersion"] == 1, "WRONG_RELEASE")
    check(set(manifest["sourceHashes"]) == BASE_FILES, "WRONG_BASE_SCOPE")
    paths = BASE_FILES | {"src/mini-listening-report/" + filename for filename in MODULES} | {MIGRATION}
    check(set(manifest["outputHashes"]) == paths, "WRONG_OUTPUT_SCOPE")
    live = switch.inspect(API)
    container_names = set(cmd("docker", "ps", "-a", "--format", "{{.Names}}").splitlines())
    check(not {OLD, NEW} & container_names, "RELEASE_CONTAINER_ALREADY_PRESENT")
    check(not env_of(live).get("MINI_K56_LISTENING_REPORT_TELEGRAM_FILE"), "REPORTING_ALREADY_CONFIGURED")
    names = {"/app/" + path: checksum for path, checksum in manifest["sourceHashes"].items()}
    check(h["h"]["fingerprints"](API, list(names)) == names, "RUNNING_SOURCE_CHANGED")
    sources = {}
    for path, expected in manifest["outputHashes"].items():
        source = ROOT / path
        check(source.is_file() and not source.is_symlink(), "MISSING_OVERLAY_FILE")
        data = source.read_bytes()
        check(sha(data) == expected, "OVERLAY_HASH_MISMATCH")
        if path != MIGRATION:
            cmd("docker", "exec", "-i", API, "node", "--input-type=module", "--check", data=data)
            sources["/app/" + path] = source
    sources[BOT_MOUNT] = credential_from_collector(switch)
    policy = ROOT / "policy"
    check(policy.is_dir() and not policy.is_symlink() and
          json.loads((policy / "config.json").read_text()) == {"enabled": True}, "WRONG_REPORT_POLICY")
    sources[POLICY_MOUNT] = policy
    command, sql = h["private_db"](live)
    h["check_idle"](sql)
    h["rpc"]()
    delta = {"BUILD_SHA": build, "MINI_K56_LISTENING_REPORT_TELEGRAM_FILE": BOT_MOUNT,
             "MINI_K56_LISTENING_REPORT_POLICY_FILE": POLICY_MOUNT + "/config.json"}
    # Use the previous compare-and-preserve implementation with this release's
    # directory for the generated Compose candidate.
    previous_persistent = h["persistent"]
    persistent = FunctionType(previous_persistent.__code__, {**previous_persistent.__globals__, "ROOT": ROOT})
    compose = persistent(live, sources, delta)
    payload, expected, addresses = h["container_spec"](live, sources, delta)
    return manifest, build, live, sources, command, sql, compose, payload, expected, addresses


def report_ready(cmd):
    probe = """
const port=process.env.PORT||'8788';
const response=await fetch('http://127.0.0.1:'+port+'/api/term-tests/mini-test-k56/listening/report',{
 method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(4000)
});
const row=await response.json();
console.log(JSON.stringify({status:response.status,code:row.error}));
"""
    for _ in range(12):
        row = json.loads(cmd("docker", "exec", "-i", API, "node", "--input-type=module", "-", data=probe.encode()))
        if row == {"status": 400, "code": "LISTENING_REPORT_INVALID"}:
            return
        time.sleep(1)
    raise RuntimeError("MINI_REPORT_INGRESS_NOT_READY")


def apply(h, release):
    manifest, build, live, sources, command, sql, compose, payload, expected, addresses = release
    cmd, switch, atomic = (h[key] for key in ("cmd", "switch", "atomic"))
    config_file, original, updated = compose
    backup = command("pg_dump", "--format=custom", "--schema=assessment_k56", "--lock-wait-timeout=4s")
    listing = cmd("docker", "exec", "-i", "mapping-postgres", "pg_restore", "--list", data=backup, timeout=35)
    check(backup.startswith(b"PGDMP") and "term_test_attempt" in listing, "SCHEMA_BACKUP_UNVERIFIED")
    atomic(ROOT / "database-before.private.dump", backup)
    atomic(ROOT / "compose-before.private.yml", original)
    h["check_idle"](sql)
    check(config_file.read_bytes() == original, "COMPOSE_CHANGED_AFTER_PREFLIGHT")
    before = h["mini"]["data_digest"](sql)
    sql("BEGIN; SET LOCAL lock_timeout = '4s';\n" + (ROOT / MIGRATION).read_text() + "\nCOMMIT;")
    check(h["mini"]["data_digest"](sql) == before, "NATIVE_DATA_CHANGED_DURING_PREP")
    candidate = switch.engine("POST", "/v1.48/containers/create?name=" + NEW, payload, (201,))["Id"]
    switch.compare_mounts(expected, switch.inspect(candidate), sources)
    h["check_idle"](sql)
    check(switch.inspect(API)["Id"] == live["Id"], "LIVE_CHANGED_BEFORE_SWITCH")
    before_build = h["env_of"](live)["BUILD_SHA"]
    started = time.monotonic()
    try:
        cmd("docker", "stop", "--time", "10", live["Id"])
        cmd("docker", "rename", live["Id"], OLD)
        cmd("docker", "rename", candidate, API)
        cmd("docker", "start", candidate)
        h["ready"](build)
        now = switch.inspect(API)
        check(now["Id"] == candidate and not switch.state(live["Id"]), "WRONG_RUNNING_CONTAINER")
        check(addresses == {key: value["IPAddress"] for key, value in now["NetworkSettings"]["Networks"].items()},
              "K56_ADDRESS_CHANGED")
        switch.compare_mounts(expected, now, sources)
        hashes = {"/app/" + key: value for key, value in manifest["outputHashes"].items() if key != MIGRATION}
        check(h["h"]["fingerprints"](API, list(hashes)) == hashes, "LIVE_OVERLAY_HASH_MISMATCH")
        h["rpc"]()
        report_ready(cmd)
        check(config_file.read_bytes() == original, "COMPOSE_CHANGED_DURING_SWITCH")
        atomic(config_file, updated, stat.S_IMODE(config_file.stat().st_mode))
    except Exception:
        if switch.state(candidate):
            cmd("docker", "stop", "--time", "10", candidate)
        if switch.inspect(candidate)["Name"] == "/" + API:
            cmd("docker", "rename", candidate, NEW)
        if switch.inspect(live["Id"])["Name"] != "/" + API:
            cmd("docker", "rename", live["Id"], API)
        if not switch.state(live["Id"]):
            cmd("docker", "start", live["Id"])
        if config_file.read_bytes() == updated:
            atomic(config_file, original, stat.S_IMODE(config_file.stat().st_mode))
        h["ready"](before_build)
        h["rpc"]()
        raise
    receipt = {"status": "mini_listening_reporting_live", "build": build, "previous": live["Id"], "live": candidate,
               "backupSha": sha(backup), "elapsedMs": round((time.monotonic() - started) * 1000)}
    atomic(ROOT / "release-receipt.json", json.dumps(receipt).encode())
    print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    os.umask(0o077)
    check(os.geteuid() == 0 and Path.cwd() == ROOT and ROOT.parent == Path("/opt"), "WRONG_RELEASE_DIRECTORY")
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    check(mode in ("preflight", "apply"), "SELECT_PREFLIGHT_OR_APPLY")
    with (ROOT / "switch.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        helpers = runpy.run_path(str(PREVIOUS))
        release = plan(helpers)
        if mode == "preflight":
            print("MINI_K56_REPORT_PREFLIGHT_PASSED", flush=True)
        else:
            apply(helpers, release)
