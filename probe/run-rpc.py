#!/usr/bin/env python3
"""S5a probe driver: isolated real-Pi RPC run (chat turns + manual /compact).

Stdlib only. Creates a temporary scratch (PI_CODING_AGENT_DIR, HOME, TMPDIR),
starts the loopback fake server, runs `pi --mode rpc` with the probe
extension, sends 3 chat prompts then a manual compact request, closes stdin,
and tears everything down. Evidence (probe hook log, server log, rpc
transcript) is written under the worktree probe/evidence-rpc/ directory.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("fake_server", Path(__file__).parent / "fake-server.py")
_fake = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fake)
ProbeServer = _fake.ProbeServer

WORKTREE = Path(__file__).resolve().parent.parent
MODEL = "probe-model"
PROVIDER = "probe"


def clean_env(scratch):
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(scratch / "home"), "TMPDIR": str(scratch / "tmp"),
            "XDG_CONFIG_HOME": str(scratch / "home/.config"),
            "XDG_CACHE_HOME": str(scratch / "home/.cache"),
            "XDG_DATA_HOME": str(scratch / "home/.local/share"),
            "PI_CODING_AGENT_DIR": str(scratch / "agent"),
            "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
            "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
            "PI_IMAGE_PROTOCOL": "none", "PI_PROGRAM_STATUS": "0"}


def rpc_request(proc, transcript, rid, req, timeout=30, wait_settle=False):
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    transcript.write(json.dumps({"sent": req}) + "\n")
    deadline = time.monotonic() + timeout
    started = False
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            raise SystemExit(f"RPC stream closed before response to {rid}")
        msg = json.loads(line)
        transcript.write(json.dumps({"recv": msg}) + "\n")
        if msg.get("id") == rid and msg.get("type") == "response":
            if not (wait_settle and msg.get("success")
                    and msg.get("data", {}).get("disposition") == "started"):
                return msg
            started = True
            continue
        if started and msg.get("type") == "agent_settled":
            return {"id": rid, "settled": True}
    raise SystemExit(f"timeout waiting for response to {rid}")


def main():
    pi = shutil.which("pi")
    if not pi:
        raise SystemExit("pi not on PATH")
    pi = os.path.abspath(pi)
    version = subprocess.check_output([pi, "--version"], timeout=15).decode().strip()
    print(f"pi={pi} version={version}")
    assert version == "1.5.2", version

    scratch = Path(tempfile.mkdtemp(prefix="s5a-rpc-"))
    evidence = WORKTREE / "probe" / "evidence-rpc"
    evidence.mkdir(exist_ok=True)
    for p in ("home", "tmp", "agent", "work"):
        (scratch / p).mkdir()
    env = clean_env(scratch)
    probe_log = evidence / "probe-hooks.jsonl"
    probe_log.write_text("")
    env["PROBE_LOG"] = str(probe_log)

    server = ProbeServer(evidence / "server.jsonl")
    (evidence / "server.jsonl").write_text("")
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    port = server.server_address[1]

    model = {"id": MODEL, "name": MODEL, "reasoning": False, "input": ["text"],
             "contextWindow": 128000, "maxTokens": 4096,
             "compat": {"supportsStore": False, "supportsDeveloperRole": False,
                        "supportsReasoningEffort": False}}
    (scratch / "agent" / "models.json").write_text(json.dumps({"providers": {
        PROVIDER: {"baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions",
                   "apiKey": "probe-key", "authHeader": True, "models": [model]}}}, indent=2))
    (scratch / "agent" / "settings.json").write_text(json.dumps(
        {"quietStartup": True, "compaction": {"enabled": False, "keepRecentTokens": 200}, "packages": []}))

    command = [pi, "--mode", "rpc", "--no-session", "--no-approve", "--no-tools",
               "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
               "--no-extensions", "--provider", PROVIDER, "--model", MODEL,
               "--thinking", "off", "-e", str(WORKTREE / "probe" / "probe-ext.ts")]
    (evidence / "command.json").write_text(json.dumps(command, indent=2))

    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=scratch / "work", env=env, text=True,
                            encoding="utf-8")
    (evidence / "pid.json").write_text(json.dumps({"pid": proc.pid}))
    with (evidence / "rpc-transcript.jsonl").open("w") as transcript:
        try:
            rpc_request(proc, transcript, "state", {"id": "state", "type": "get_state"})
            for i in range(1, 4):
                message = f"Probe chat turn {i}."
                if i == 3:
                    # ~25 KB of padding so the session exceeds keepRecentTokens (200)
                    # and prepareCompaction finds a non-empty summarizable range.
                    message += " probe-padding " * 3000
                resp = rpc_request(proc, transcript, f"p{i}",
                                   {"id": f"p{i}", "type": "prompt", "message": message},
                                   wait_settle=True)
                assert resp.get("success") or resp.get("settled"), resp
            time.sleep(1.0)  # let the last stream event log flush
            resp = rpc_request(proc, transcript, "compact", {"id": "compact", "type": "compact"},
                               timeout=60, wait_settle=True)
            (evidence / "compact-response.json").write_text(json.dumps(resp, indent=2))
        finally:
            # Orderly shutdown: close stdin, bounded wait, then signal.
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            stderr = proc.stderr.read()
            if stderr:
                (evidence / "pi-stderr.txt").write_bytes(stderr)
    server.shutdown()
    shutil.rmtree(scratch, ignore_errors=True)
    print(f"probe exit_code={proc.returncode}")
    print(f"evidence={evidence}")
    return 0 if proc.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
