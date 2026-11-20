#!/usr/bin/env python3
"""S5a probe driver: isolated real-Pi TUI run (chat turns + /tree branch summary).

Stdlib only. PTY-driven. Creates a temporary scratch (PI_CODING_AGENT_DIR,
HOME, TMPDIR), starts the loopback fake server, runs the interactive TUI with
the probe extension, sends two chat turns, opens /tree, navigates to the first
user entry, and answers "Summarize" to the branch-summary prompt. Evidence
(probe hook log, server log, terminal capture, actions) is written under the
worktree probe/evidence-tui/ directory.
"""
import errno
import fcntl
import json
import os
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from pathlib import Path

import importlib.util

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


class Term:
    def __init__(self, command, env, cwd, evidence):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.master = master
        self.raw = (evidence / "terminal.ansi").open("wb")
        self.output = b""
        self.actions = []
        self.proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                     cwd=cwd, env=env, start_new_session=True)
        os.close(slave)

    def pump(self, seconds=0.1):
        if select.select([self.master], [], [], seconds)[0]:
            try:
                data = os.read(self.master, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                data = b""
            self.output += data
            self.raw.write(data)
            self.raw.flush()

    def send(self, text):
        self.actions.append(text)
        (self.evidence_actions()).append(text) if False else None
        with (EVIDENCE / "actions.jsonl").open("a") as f:
            f.write(json.dumps({"input": text}) + "\n")
        os.write(self.master, b"\x15\x1b[200~" + text.encode() + b"\x1b[201~")
        self.pump(0.1)
        os.write(self.master, b"\r")
        self.pump(0.2)

    def key(self, seq, name):
        with (EVIDENCE / "actions.jsonl").open("a") as f:
            f.write(json.dumps({"key": name}) + "\n")
        os.write(self.master, seq)
        self.pump(0.3)

    def wait(self, predicate, reason, timeout=20):
        deadline = time.monotonic() + timeout
        while not predicate():
            if self.proc.poll() is not None:
                raise SystemExit(f"Pi exited {self.proc.returncode} while waiting for {reason}")
            if time.monotonic() >= deadline:
                raise SystemExit(f"timeout waiting for {reason}; see terminal.ansi")
            self.pump(0.1)

    def close(self):
        if self.proc.poll() is None:
            try:
                # Clear any restored editor text so /quit is not concatenated
                # into a prompt (ctrl+u = delete line backward).
                os.write(self.master, b"\x15")
                self.pump(0.3)
                os.write(self.master, b"/quit\r")
            except OSError:
                pass
            deadline = time.monotonic() + 8
            while self.proc.poll() is None and time.monotonic() < deadline:
                self.pump(0.1)
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.raw.close()
        os.close(self.master)


EVIDENCE = None


def main():
    global EVIDENCE
    pi = os.path.abspath(shutil.which("pi") or "")
    if not pi:
        raise SystemExit("pi not on PATH")
    version = subprocess.check_output([pi, "--version"], timeout=15).decode().strip()
    print(f"pi={pi} version={version}")
    assert version == "1.5.2", version

    scratch = Path(tempfile.mkdtemp(prefix="s5a-tui-"))
    EVIDENCE = WORKTREE / "probe" / "evidence-tui"
    EVIDENCE.mkdir(exist_ok=True)
    for p in ("home", "tmp", "agent", "work"):
        (scratch / p).mkdir()
    env = clean_env(scratch)
    probe_log = EVIDENCE / "probe-hooks.jsonl"
    probe_log.write_text("")
    env["PROBE_LOG"] = str(probe_log)

    server = ProbeServer(EVIDENCE / "server.jsonl")
    (EVIDENCE / "server.jsonl").write_text("")
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
        {"quietStartup": True, "compaction": {"enabled": False}, "packages": []}))

    command = [pi, "--no-approve", "--no-tools", "--no-skills", "--no-prompt-templates",
               "--no-context-files", "--no-mcp", "--no-extensions",
               "--provider", PROVIDER, "--model", MODEL, "--thinking", "off",
               "--tui-mode", "regular",
               "-e", str(WORKTREE / "probe" / "probe-ext.ts")]
    (EVIDENCE / "command.json").write_text(json.dumps(command, indent=2))

    def posts():
        return sum(1 for e in server.events if e.get("method") == "POST")

    term = Term(command, env, scratch / "work", EVIDENCE)
    try:
        term.wait(lambda: MODEL.encode() in term.output,
                  "provider/model footer", timeout=25)
        # Footer renders before startup finishes; wait for "Startup is still in
        # progress" to disappear so the first prompt is not queued for 20+s.
        time.sleep(1.0)
        term.pump(0.1)
        deadline = time.monotonic() + 30
        while b"Startup is still in progress" in term.output and time.monotonic() < deadline:
            term.pump(0.2)
        (EVIDENCE / "ready.screen.txt").write_text("see terminal.ansi")
        term.send(f"Probe chat turn 1.")
        term.wait(lambda: posts() > 0, "chat 1 request", timeout=40)
        time.sleep(1.0)
        term.send(f"Probe chat turn 2.")
        term.wait(lambda: posts() > 1, "chat 2 request")
        time.sleep(1.5)  # let streams settle
        term.send("/tree")
        term.wait(lambda: b"Summarize branch?" in term.output or b"tree" in term.output.lower(),
                  "tree selector", timeout=10)
        time.sleep(0.5)
        # Tree selector: move selection up to the first user entry, then Enter.
        for i in range(3):
            term.key(b"\x1b[A", f"up-{i}")
        time.sleep(0.3)
        term.key(b"\r", "enter-tree-selection")
        term.wait(lambda: b"Summarize branch?" in term.output, "summarize prompt", timeout=10)
        # "Summarize" is the second option: down once, Enter.
        term.key(b"\x1b[B", "down-to-summarize")
        time.sleep(0.3)
        term.key(b"\r", "enter-summarize")
        term.wait(lambda: posts() > 2, "branch summary request", timeout=25)
        time.sleep(1.0)
    except SystemExit as e:
        (EVIDENCE / "failure.txt").write_text(str(e) + "\n")
        raise
    finally:
        term.close()
        server.shutdown()
        shutil.rmtree(scratch, ignore_errors=True)
    print(f"tui exit_code={term.proc.returncode}")
    print(f"evidence={EVIDENCE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
