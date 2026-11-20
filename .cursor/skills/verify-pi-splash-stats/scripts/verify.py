#!/usr/bin/env python3
"""Isolated real-Pi verification. Python stdlib only; no extension implementation."""
import argparse
import errno
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[4]
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
MODEL = "verify-model"
SCENARIOS = ("chat", "cached", "non-splash", "switch", "abort-prefill",
             "abort-generation", "reload", "print", "json", "rpc", "compact", "tree",
             "tree-negative")
# Summary journeys need real (persisted, in-scratch) sessions: /compact summarizes a
# persisted conversation and /tree navigates one. They keep that session file as
# side-effect evidence instead of treating it as an unexpected write.
SUMMARY_SCENARIOS = ("compact", "tree", "tree-negative")


class Blocked(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def clean_env(scratch):
    # Never inherit credentials, proxies, NODE_OPTIONS, or the parent Pi session.
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(scratch / "home"), "TMPDIR": str(scratch / "tmp"),
            "XDG_CONFIG_HOME": str(scratch / "home/.config"),
            "XDG_CACHE_HOME": str(scratch / "home/.cache"),
            "XDG_DATA_HOME": str(scratch / "home/.local/share"),
            "PI_CODING_AGENT_DIR": str(scratch / "agent"),
            "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
            "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
            "PI_IMAGE_PROTOCOL": "none", "PI_PROGRAM_STATUS": "0"}


def version(binary, env, cwd):
    return subprocess.check_output([binary, "--version"], env=env, cwd=cwd,
                                   stderr=subprocess.STDOUT, timeout=15).decode().strip()


def preflight(args):
    pi = shutil.which(args.pi)
    node = shutil.which("node")
    if not pi or not node:
        raise Blocked("Install the approved Pi 1.5.2 and Node runtime before verification; no auto-install.")
    if not shutil.which("fd") or not shutil.which("rg"):
        raise Blocked("Put preinstalled fd and rg on PATH; Pi TUI must not download managed tools during verification.")
    # Resolve the executable before changing HOME. Do not resolve a Pi shell wrapper to a different install.
    pi = os.path.abspath(pi)
    with tempfile.TemporaryDirectory(prefix="splash-doctor-") as tmp:
        scratch = Path(tmp)
        for p in ("home", "tmp", "agent", "work"):
            (scratch / p).mkdir()
        env = clean_env(scratch)
        pv = version(pi, env, scratch / "work")
        nv = version(node, env, scratch / "work")
    if pv != "1.5.2":
        raise Blocked(f"Pi {pv} is not the qualified 1.5.2 baseline; qualify/version the harness explicitly.")
    if tuple(map(int, nv.lstrip("v").split(".")[:3])) < (22, 18, 0):
        raise Blocked(f"Node {nv} is below the specification's 22.18.0 baseline.")
    package = args.package.resolve()
    info = {"pi": pi, "pi_version": pv, "node_version": nv, "os": platform.platform(),
            "package": str(package), "target": "harness-only" if args.command == "self-test" else "extension"}
    if args.command != "self-test":
        manifest_path = package / "package.json"
        if not manifest_path.is_file():
            raise Blocked(f"No {manifest_path}: this checkout is specification-only; implement the extension first.")
        manifest = json.loads(manifest_path.read_text())
        require(manifest.get("name") == "pi-splash-stats", "Unexpected package identity")
        require(manifest.get("pi", {}).get("extensions") == ["./src/index.ts"],
                "Expected package manifest pi.extensions = ['./src/index.ts']")
        if not (package / "src/index.ts").is_file():
            raise Blocked(f"Missing {package / 'src/index.ts'}: implement the runtime entry before verification.")
        # Fingerprint all runtime source, including a supplied extracted package.
        info["source_sha256"] = {str(p.relative_to(package)): hashlib.sha256(p.read_bytes()).hexdigest()
                                  for p in sorted((package / "src").rglob("*")) if p.is_file()}
        info["manifest_sha256"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    return info


class Fixture(http.server.ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, evidence, scenario):
        super().__init__(("127.0.0.1", 0), Handler)
        self.evidence = evidence
        self.scenario = scenario
        self.events = []
        self.lock = threading.Lock()
        self.streams = []
        self.stopping = threading.Event()

    def record(self, **entry):
        with self.lock:
            entry["time"] = time.monotonic()
            self.events.append(entry)
            with (self.evidence / "http.jsonl").open("a") as f:
                f.write(json.dumps(entry) + "\n")


class Handler(http.server.BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *args):
        pass

    def authorized(self):
        return self.headers.get("Authorization") == "Bearer verification-only"

    def do_GET(self):
        owned = self.path == "/splash/v1/models"
        valid = owned or self.path == "/other/v1/models"
        ok = self.authorized()
        self.server.record(method="GET", path=self.path, auth_ok=ok)
        body = json.dumps({"object": "list", "data": [{"id": MODEL, "object": "model",
                           "owned_by": "splash" if owned else "llama.cpp"}]}).encode()
        self.send_response(200 if valid and ok else 401 if not ok else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        payload = json.loads(body)
        other = self.path.startswith("/other/")
        state = {"prefill": threading.Event(), "generation": threading.Event(),
                 "done": threading.Event(), "release_prefill": threading.Event(),
                 "release_generation": threading.Event(), "other": other}
        with self.server.lock:
            self.server.streams.append(state)
        # Only allowlisted transport metadata; never persist prompts, output, tools or headers.
        self.server.record(method="POST", path=self.path, model=payload.get("model"),
                           stream=payload.get("stream"), return_progress=payload.get("return_progress"),
                           stream_options=payload.get("stream_options"), auth_ok=self.authorized(),
                           payload_sha256=hashlib.sha256(body).hexdigest())
        if not self.authorized() or self.path not in ("/splash/v1/chat/completions", "/other/v1/chat/completions"):
            self.send_error(401 if not self.authorized() else 404)
            state["done"].set()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            def emit(delta=None, **extra):
                chunk = {"id": "verification", "object": "chat.completion.chunk", "created": 1,
                         "model": MODEL, "choices": [{"index": 0, "delta": delta or {}, "finish_reason": None}]}
                chunk.update(extra)
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.flush()

            def gate(name):
                state[name].set()
                self.server.record(phase=name)
                # A bounded fixture gate makes transient UI observable without injecting extension state.
                deadline = time.monotonic() + 12
                while not state["release_" + name].wait(.05):
                    if self.server.stopping.is_set() or time.monotonic() > deadline:
                        return

            emit({"role": "assistant", "content": ""})
            # A non-Splash backend deliberately emits compatible fields: they are NOT identity proof.
            if payload.get("return_progress") is True or other:
                for processed, elapsed in ((20, 0), (40, 1000), (60, 2000)):
                    emit(prompt_progress={"total": 100, "cache": 20, "processed": processed, "time_ms": elapsed})
                    time.sleep(.2)
            gate("prefill")
            for text in ("Verification ", "response ", "complete."):
                emit({"content": text})
                time.sleep(.2)
            gate("generation")
            emit(choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 timings={"predicted_n": 9, "predicted_per_second": 82.4,
                          "prompt_per_second": 20.0, "prompt_n": 100, "cache_n": 20,
                          "prompt_ms": 4000, "predicted_ms": 70})
            emit(choices=[], usage={"prompt_tokens": 100, "completion_tokens": 7, "total_tokens": 107})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.server.record(phase="done")
        except (BrokenPipeError, ConnectionResetError):
            self.server.record(phase="disconnected")
        finally:
            state["done"].set()


def reap_group(proc, pump=None):
    """Bounded teardown of the group we created, even after its leader exits."""
    def alive():
        proc.poll()  # Reap our leader so its zombie cannot keep the group alive.
        try:
            os.killpg(proc.pid, 0)
            return True
        except ProcessLookupError:
            return False

    signaled = False
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not alive():
            break
        signaled = True
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + 3
        while alive() and time.monotonic() < deadline:
            if pump:
                pump(.05)
            else:
                time.sleep(.05)
    proc.wait(timeout=3)
    return {"exit_code": proc.returncode, "group_gone": not alive(), "group_signaled": signaled}


class Terminal:
    def __init__(self, command, env, scratch, evidence):
        self.evidence, self.scratch = evidence, scratch
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.master = master
        self.proc = None
        self.raw = (evidence / "terminal.ansi").open("wb")
        self.output = b""
        dump(evidence / "command.json", command)
        try:
            self.proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                         cwd=scratch / "work", env=env, start_new_session=True)
        except BaseException:
            os.close(master)
            self.raw.close()
            raise
        finally:
            os.close(slave)

    def pump(self, seconds=.1):
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

    def wait(self, predicate, reason, timeout=10):
        deadline = time.monotonic() + timeout
        while not predicate():
            if self.proc.poll() is not None:
                raise AssertionError(f"Pi exited {self.proc.returncode} while waiting for {reason}")
            if time.monotonic() >= deadline:
                raise AssertionError(f"Timed out waiting for {reason}; inspect terminal.ansi")
            self.pump()

    def send(self, text):
        with (self.evidence / "actions.jsonl").open("a") as f:
            f.write(json.dumps({"time": time.monotonic(), "input": text}) + "\n")
        # Bracketed paste avoids autocomplete selecting a slash-command instead of the exact command.
        os.write(self.master, b"\x15\x1b[200~" + text.encode() + b"\x1b[201~")
        self.pump(.1)
        os.write(self.master, b"\r")

    def key(self, seq, name):
        """Send raw key bytes (selector arrows/Enter) with bounded pumping."""
        with (self.evidence / "actions.jsonl").open("a") as f:
            f.write(json.dumps({"time": time.monotonic(), "key": name}) + "\n")
        os.write(self.master, seq)
        self.pump(.3)

    def snapshot(self, name):
        log = self.scratch / "agent/pi-debug.log"
        if log.exists():
            log.unlink()
        self.send("/debug")
        self.wait(log.exists, "/debug rendered snapshot")
        content = log.read_text()
        (self.evidence / f"{name}.debug.txt").write_text(content)
        lines = []
        for line in content.splitlines():
            match = re.match(r"^\[\d+\] \(w=\d+\) (.*)$", line)
            if match:
                lines.append(ANSI.sub("", json.loads(match.group(1))))
        require(lines, "Pi /debug format changed: cannot assert rendered state")
        screen = "\n".join(lines)
        (self.evidence / f"{name}.screen.txt").write_text(screen + "\n")
        return screen

    def close(self):
        result = {"pid": self.proc.pid, "group": self.proc.pid, "forced": False}
        if self.proc.poll() is None:
            self.send("/quit")
            deadline = time.monotonic() + 4
            while self.proc.poll() is None and time.monotonic() < deadline:
                self.pump()
            if self.proc.poll() is None:
                result["forced"] = True
                os.killpg(self.proc.pid, signal.SIGTERM)
                deadline = time.monotonic() + 3
                while self.proc.poll() is None and time.monotonic() < deadline:
                    self.pump()
                if self.proc.poll() is None:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                    self.proc.wait(timeout=3)
        result.update(reap_group(self.proc, self.pump))
        os.close(self.master)
        self.raw.close()
        return result


def no_stats(screen):
    require("Prefilling" not in screen and "Generating" not in screen,
            "Stats leaked into idle/ineligible UI")


def build_settings(scenario):
    """Isolated Pi settings; the compact scenario keeps seeded sessions compactible."""
    compaction = {"enabled": False}
    if scenario == "compact":
        # The default 20k keepRecentTokens makes a small seeded session report
        # "Nothing to compact (session too small)" without any provider request.
        compaction["keepRecentTokens"] = 200
    return {"quietStartup": False, "compaction": compaction, "packages": []}


def tree_cursor_on(screen, target):
    """True when the /tree Session Tree cursor is on the row displaying `target`.

    Pi 1.5.2 renders the selected tree row with a `›` prefix, e.g.
    `› • user: Verify tree-turn-1.`. Selection is driven by the displayed
    prompt text via the tree's type-to-search filter, never by coordinates.
    """
    for line in screen.splitlines():
        stripped = line.strip()
        if stripped.startswith("›") and target in stripped:
            return True
    return False


def observe_files(scratch):
    configs = {}
    for name in ("models.json", "settings.json", "auth.json"):
        path = scratch / "agent" / name
        configs[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    return {"config_hashes": configs,
            "files": sorted(str(p.relative_to(scratch)) for p in scratch.rglob("*") if p.is_file())}


def seed_turn(terminal, server, evidence, label, pad=False):
    """One real user turn through the owned PTY; no product-stats assertions.

    These turns are conversation scaffolding for the summary journeys, not the
    chat journey under test. They settle on the actual assistant response so
    the following /compact or /tree starts from an idle, complete session.
    """
    before = len(server.streams)
    text = f"Verify {label}."
    if pad:
        text += " " + " ".join(["context"] * 180)
    terminal.send(text)
    terminal.wait(lambda: len(server.streams) > before, f"{label} completion request")
    stream = server.streams[before]
    stream["release_prefill"].set()
    stream["release_generation"].set()
    terminal.wait(stream["done"].is_set, f"{label} fixture completion")
    deadline = time.monotonic() + 8
    while True:
        end = time.monotonic() + .25
        terminal.wait(lambda: time.monotonic() >= end, "seed settle render")
        terminal.snapshot(label + "-idle")
        debug = (evidence / f"{label}-idle.debug.txt").read_text()
        messages = [json.loads(line) for line in debug.split("=== Agent messages (JSONL) ===\n")[1].splitlines() if line]
        if messages and messages[-1].get("role") == "assistant" and messages[-1].get("stopReason") == "stop":
            break
        require(time.monotonic() < deadline, "Seed turn did not settle to an assistant response")
    posts = [e for e in server.events if e.get("method") == "POST"]
    require(len(posts) == before + 1, "Duplicate inference request during seed")
    post = posts[-1]
    require(post["auth_ok"] and post["model"] == MODEL and post["stream"] is True,
            "Wrong seed inference auth/model/stream")


def run_summary(terminal, server, evidence, scenario, journey):
    """Drive the /compact and /tree branch-summary journeys.

    Seed turns scaffold the conversation. The summary stream is gated exactly
    like chat: the Pi spinner must stay visible while the above-editor stats
    are asserted during prefill and generation. The final chat turn re-uses
    the ordinary journey so a usable response after summary is required.
    """
    spinner = {"compact": "Compacting context", "tree": "Summarizing branch"}.get(scenario, "")
    baseline = len(server.streams)
    for i in (1, 2, 3):
        seed_turn(terminal, server, evidence, f"{scenario}-turn-{i}", pad=scenario == "compact")
    if scenario == "compact":
        terminal.send("/compact")
        terminal.wait(lambda: len(server.streams) > baseline, "actual /compact summary request")
    else:
        offset = len(terminal.output)
        terminal.send("/tree")
        terminal.wait(lambda: b"Session Tree" in terminal.output, "session tree opens", timeout=15)
        target = f"Verify {scenario}-turn-1."
        # Type-to-search filters the tree to the displayed prompt text; the
        # selection follows the (unique) match, so no coordinates are involved.
        terminal.key(target.encode(), "tree-search-target")
        terminal.wait(lambda: tree_cursor_on(ANSI.sub("", terminal.output[offset:].decode("utf-8", "replace")), target),
                      "tree cursor on target entry", timeout=15)
        terminal.key(b"\r", "tree-select-entry")
        terminal.wait(lambda: b"Summarize branch?" in terminal.output, "branch summary menu", timeout=15)
        if scenario == "tree":
            terminal.key(b"\x1b[B", "menu-to-summarize")
            terminal.key(b"\r", "menu-choose-summarize")
            terminal.wait(lambda: len(server.streams) > baseline, "actual branch summary request")
        else:
            nav_offset = len(terminal.output)
            pre_nav = len(server.streams)
            terminal.key(b"\r", "menu-no-summary")
    if scenario in ("compact", "tree"):
        stream = server.streams[-1]
        posts = [e for e in server.events if e.get("method") == "POST"]
        require(len(posts) == len(server.streams), "Duplicate summary inference request")
        post = posts[-1]
        require(post["auth_ok"] and post["model"] == MODEL and post["stream"] is True,
                "Wrong summary inference auth/model/stream")
        require(post["path"] == "/splash/v1/chat/completions", "Summary hit an unexpected endpoint")
        dump(evidence / "summary-request.json", post)
        terminal.wait(stream["prefill"].is_set, "summary prefill samples")
        end = time.monotonic() + .35
        terminal.wait(lambda: time.monotonic() >= end, "summary prefill render")
        screen = terminal.snapshot("summary-prefill")
        require(spinner in screen, "Pi summary spinner missing from prefill snapshot")
        require("Prefilling" in screen and "50%" in screen, "Expected summary prefill stats")
        require("20.0 tok/s" in screen, "Expected summary prefill throughput")
        stream["release_prefill"].set()
        terminal.wait(stream["generation"].is_set, "summary generated output")
        end = time.monotonic() + .35
        terminal.wait(lambda: time.monotonic() >= end, "summary generation render")
        screen = terminal.snapshot("summary-generation")
        require(spinner in screen, "Pi summary spinner missing from generation snapshot")
        require("Generating" in screen and "≈" in screen, "Expected summary generation stats")
        require("Prefilling" not in screen, "Prefill remained during summary generation")
        stream["release_generation"].set()
        terminal.wait(stream["done"].is_set, "summary completion")
        nav_offset = len(terminal.output)
        # Post-summary UI work (compaction entry / branch navigation) is asynchronous.
        deadline = time.monotonic() + 8
        while True:
            end = time.monotonic() + .25
            terminal.wait(lambda: time.monotonic() >= end, "summary settle render")
            screen = terminal.snapshot("summary-idle")
            if spinner not in screen and "Prefilling" not in screen and "Generating" not in screen:
                break
            require(time.monotonic() < deadline, "Stale summary spinner/stats after completion")
        if scenario == "tree":
            require("Branch summary" in screen, "Branch summary entry not rendered after navigation")
            # Navigation restores the target prompt into the editor; wait for that
            # render, then clear it before sending further commands.
            terminal.wait(lambda: target.encode() in terminal.output[nav_offset:],
                          "editor restored after navigation", timeout=15)
        terminal.key(b"\x15", "clear-restored-editor-text")
    else:
        # "No summary": navigation must be instant and must not infer. Navigation
        # restores the target prompt into the editor; wait for that render, then
        # clear it before sending /debug.
        terminal.wait(lambda: target.encode() in terminal.output[nav_offset:],
                      "editor restored after navigation", timeout=15)
        terminal.pump(.2)
        terminal.key(b"\x15", "clear-restored-editor-text")
        screen = terminal.snapshot("tree-negative-idle")
        no_stats(screen)
        require(len(server.streams) == pre_nav, "Navigate-without-summary issued an inference request")
    journey(f"after-{scenario}")


def run_tui(command, env, scratch, evidence, server, scenario):
    terminal = Terminal(command, env, scratch, evidence)
    try:
        selected = command[command.index("--provider") + 1]
        marker = f"({selected}) {MODEL}".encode()
        terminal.wait(lambda: marker in terminal.output, "initialized provider/model footer", timeout=20)
        idle = terminal.snapshot("ready")
        require(MODEL in idle, "Not ready: selected model missing")
        require("Error" not in idle and "Failed to load" not in idle, "Pi startup error")
        no_stats(idle)
        dump(evidence / "doctor.json", {"pid": terminal.proc.pid, "alive": terminal.proc.poll() is None,
             "port": server.server_address[1], "loopback": True, "ready_snapshot": "ready.screen.txt"})

        def journey(label, other=False, abort=None):
            before = len(server.streams)
            terminal.send(f"Reply with the verification response for {label}.")
            terminal.wait(lambda: len(server.streams) > before, "one actual completion request")
            stream = server.streams[before]
            terminal.wait(stream["prefill"].is_set, "fixture prefill samples")
            # Wait for a complete renderer turn; snapshots are the assertions, not historical PTY bytes.
            end = time.monotonic() + .35
            terminal.wait(lambda: time.monotonic() >= end, "prefill render")
            screen = terminal.snapshot(label + "-prefill")
            if other:
                no_stats(screen)
            else:
                require("Prefilling" in screen and "50%" in screen, "Expected cache-aware 50% prefill")
                require("20.0 tok/s" in screen, "Expected uncached throughput of 20.0 tok/s")
            if abort == "prefill":
                with (evidence / "actions.jsonl").open("a") as f:
                    f.write(json.dumps({"time": time.monotonic(), "key": "Escape"}) + "\n")
                os.write(terminal.master, b"\x1b")
            stream["release_prefill"].set()
            if abort != "prefill":
                terminal.wait(stream["generation"].is_set, "generated output")
                end = time.monotonic() + .35
                terminal.wait(lambda: time.monotonic() >= end, "generation render")
                screen = terminal.snapshot(label + "-generation")
                if other:
                    no_stats(screen)
                else:
                    require("Generating" in screen and "≈" in screen, "Expected approximate generation count")
                    require("Prefilling" not in screen, "Prefill remained during generation")
                if abort == "generation":
                    with (evidence / "actions.jsonl").open("a") as f:
                        f.write(json.dumps({"time": time.monotonic(), "key": "Escape"}) + "\n")
                    os.write(terminal.master, b"\x1b")
            stream["release_generation"].set()
            terminal.wait(stream["done"].is_set, "fixture completion/disconnect")
            # Completion/abort handling is asynchronous. Wait for UI to settle using repeated read-only snapshots.
            deadline = time.monotonic() + 5
            while True:
                end = time.monotonic() + .25
                terminal.wait(lambda: time.monotonic() >= end, "settle render")
                screen = terminal.snapshot(label + "-idle")
                if "Prefilling" not in screen and "Generating" not in screen:
                    break
                require(time.monotonic() < deadline, "Stale stats after completion/abort")
            if not abort:
                debug = (evidence / f"{label}-idle.debug.txt").read_text()
                messages = [json.loads(line) for line in debug.split("=== Agent messages (JSONL) ===\n")[1].splitlines() if line]
                require(messages[-1].get("role") == "assistant" and messages[-1].get("stopReason") == "stop",
                        "Current turn has no successful assistant response")
                require(messages[-1].get("content") == [{"type": "text", "text": "Verification response complete."}],
                        "Current turn lost or altered the ordinary response")
            else:
                debug = (evidence / f"{label}-idle.debug.txt").read_text()
                require('"stopReason":"aborted"' in debug, "Escape did not abort the actual Pi request")
            posts = [e for e in server.events if e.get("method") == "POST"]
            require(len(posts) == before + 1, "Duplicate inference request")
            post = posts[-1]
            require(post["auth_ok"] and post["model"] == MODEL and post["stream"] is True,
                    "Wrong inference auth/model/stream")
            if not other:
                require(post["return_progress"] is True, "Verified Splash request was not enriched")
                require(post["stream_options"].get("include_usage") is True, "Missing include_usage")
            else:
                require(post["return_progress"] is None, "Non-Splash request was enriched")

        if scenario in SUMMARY_SCENARIOS:
            run_summary(terminal, server, evidence, scenario, journey)
            return terminal
        other = scenario == "non-splash"
        abort = scenario.removeprefix("abort-") if scenario.startswith("abort-") else None
        journey("first", other, abort)
        if scenario == "cached":
            journey("follow-up")
        elif scenario == "reload":
            terminal.send("/reload")
            # Wait for Pi's actual reload status, not an arbitrary startup delay.
            terminal.wait(lambda: b"Reloaded" in terminal.output or b"Reload complete" in terminal.output,
                          "reload completion", timeout=20)
            no_stats(terminal.snapshot("reloaded"))
            journey("after-reload")
        elif scenario == "switch":
            for provider, label, other in (("splash", "away", True), ("verify-local", "back", False)):
                terminal.output = b""
                terminal.send(f"/model {provider}/{MODEL}")
                terminal.wait(lambda: (f"Model: {MODEL}").encode() in terminal.output, "model selection")
                no_stats(terminal.snapshot(label + "-selected"))
                journey(label, other)
        return terminal
    except BaseException:
        dump(evidence / "process-cleanup.json", terminal.close())
        raise


def run_non_tui(command, env, scratch, evidence, server, scenario):
    event_start, stream_start = len(server.events), len(server.streams)
    command = command.copy()
    if scenario == "print":
        command += ["--print", "Reply with the verification response."]
    else:
        command += ["--mode", scenario]
        if scenario == "json":
            command += ["Reply with the verification response."]
    dump(evidence / "command.json", command)
    # File-backed output cannot fill a pipe while waiting for inference.
    with (evidence / "stdout.txt").open("wb") as stdout, (evidence / "stderr.txt").open("wb") as stderr:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE if scenario == "rpc" else stdout, stderr=stderr,
                                cwd=scratch / "work", env=env, start_new_session=True, bufsize=0)
        try:
            if scenario == "rpc":
                proc.stdin.write(b'{"id":"verify","type":"prompt","message":"Reply with the verification response."}\n')
                proc.stdin.flush()
            else:
                proc.stdin.close()
                proc.stdin = None
            deadline = time.monotonic() + 25
            pending, ended = b"", False
            while True:
                for stream in server.streams[stream_start:]:
                    stream["release_prefill"].set()
                    stream["release_generation"].set()
                if scenario == "rpc":
                    if select.select([proc.stdout], [], [], .05)[0]:
                        chunk = os.read(proc.stdout.fileno(), 65536)
                        require(chunk, "RPC closed before agent_end")
                        stdout.write(chunk)
                        stdout.flush()
                        pending += chunk
                        require(len(pending) <= 1024 * 1024, "RPC line exceeds 1 MiB")
                        while b"\n" in pending:
                            line, pending = pending.split(b"\n", 1)
                            if json.loads(line).get("type") == "agent_end":
                                ended = True
                    if ended:
                        proc.stdin.close()
                        proc.stdin = None
                        break
                elif proc.poll() is not None:
                    break
                else:
                    time.sleep(.05)
                require(time.monotonic() < deadline, "Non-TUI completion timeout")
                if scenario == "rpc":
                    require(proc.poll() is None, "RPC exited before agent_end")
            proc.wait(timeout=5)
            require(proc.returncode == 0, f"Pi exit {proc.returncode}")
        finally:
            cleanup = {"pid": proc.pid, **reap_group(proc)}
            dump(evidence / "process-cleanup.json", cleanup)
            require(cleanup["group_gone"], "Owned process group survived cleanup")
            if proc.stdout is not None:
                stdout.write(proc.stdout.read())
                proc.stdout.close()
            if proc.stdin is not None:
                proc.stdin.close()
    out, err = (evidence / "stdout.txt").read_bytes(), (evidence / "stderr.txt").read_bytes()
    require(not err.strip(), "Unexpected stderr in non-TUI mode")
    require(b"Verification response complete." in out, "Missing ordinary response")
    require(b"Prefilling" not in out and b"Generating" not in out, "Non-TUI stats output")
    if scenario in ("json", "rpc"):
        for line in out.splitlines():
            json.loads(line)
    events = server.events[event_start:]
    require(not [e for e in events if e.get("method") == "GET"], "Non-TUI discovery occurred")
    posts = [e for e in events if e.get("method") == "POST"]
    require(len(posts) == 1 and posts[0]["return_progress"] is None, "Non-TUI enrichment/duplicate call")
    dump(evidence / "doctor.json", {"pid": proc.pid, "inference_completed": True,
                                  "port": server.server_address[1]})



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("doctor", "run", "self-test"))
    parser.add_argument("scenario", nargs="?", choices=SCENARIOS, default="chat")
    parser.add_argument("--pi", default="pi", help="Path to preinstalled Pi 1.5.2 executable")
    parser.add_argument("--package", type=Path, default=ROOT, help="Checkout or extracted npm package")
    args = parser.parse_args()
    evidence = ROOT / ".verification-evidence" / (time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
    evidence.mkdir(parents=True)
    print(f"Evidence: {evidence}", flush=True)
    status, code = "FAIL", 1
    scratch = None
    server = None
    worker = None
    terminal = None
    report = {"command": args.command, "scenario": args.scenario, "coverage": [],
              "unverified": ["real Splash", "launcher", "tools", "summaries", "automatic/recovery compaction",
                             "remote/IPv6/auth failures", "exact final transient counts/rates", "narrow layout",
                             "other-extension coexistence", "packed package unless --package supplied"]}
    try:
        info = preflight(args)
        dump(evidence / "environment.json", info)
        if args.command == "doctor":
            status, code = "READY_TO_LAUNCH", 0
        else:
            scenario = "non-splash" if args.command == "self-test" else args.scenario
            report["scenario"] = scenario
            scratch = Path(tempfile.mkdtemp(prefix="pi-splash-verify-"))
            for p in ("home", "tmp", "agent", "work"):
                (scratch / p).mkdir()
            env = clean_env(scratch)
            server = Fixture(evidence, scenario)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"
            model = {"id": MODEL, "name": MODEL, "reasoning": False, "input": ["text"],
                     "contextWindow": 128000, "maxTokens": 4096,
                     "compat": {"supportsStore": False, "supportsDeveloperRole": False,
                                "supportsReasoningEffort": False}}
            providers = {name: {"baseUrl": base + prefix + "/v1", "api": "openai-completions",
                                "apiKey": "verification-only", "authHeader": True, "models": [model]}
                         for name, prefix in (("verify-local", "/splash"), ("splash", "/other"))}
            dump(scratch / "agent/models.json", {"providers": providers})
            dump(scratch / "agent/settings.json", build_settings(scenario))
            selected = "splash" if scenario == "non-splash" else "verify-local"
            session_flags = [] if scenario in SUMMARY_SCENARIOS else ["--no-session"]
            command = [info["pi"], "--offline", "--no-extensions", "--no-mcp", "--no-skills",
                       "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
                       *session_flags, "--no-tools", "--provider", selected, "--model", MODEL,
                       "--thinking", "off", "--tui-mode", "regular"]
            if args.command != "self-test":
                command += ["--extension", str(args.package.resolve())]
            before_files = observe_files(scratch)
            dump(evidence / "files-before.json", before_files)
            if scenario in ("print", "json", "rpc"):
                run_non_tui(command, env, scratch, evidence, server, scenario)
            else:
                terminal = run_tui(command, env, scratch, evidence, server, scenario)
            after_files = observe_files(scratch)
            dump(evidence / "files-after.json", after_files)
            require(before_files["config_hashes"]["models.json"] == after_files["config_hashes"]["models.json"],
                    "Provider configuration was modified")
            unexpected = [p for p in after_files["files"] if p.startswith("work/")]
            if scenario in SUMMARY_SCENARIOS:
                # The persisted session is the journey's expected side effect; keep it as evidence.
                require([p for p in after_files["files"] if "/sessions/" in p],
                        "No persisted session file recorded for the summary journey")
            else:
                unexpected += [p for p in after_files["files"] if "/sessions/" in p]
            require(not unexpected, "Unexpected working-directory/session writes")
            if args.command == "run" and scenario in ("non-splash", "print", "json", "rpc"):
                tested_post = [e for e in server.events if e.get("method") == "POST"][-1]
                if terminal:
                    cleanup = terminal.close()
                    terminal = None
                    dump(evidence / "process-cleanup.json", cleanup)
                    require(cleanup["group_gone"] and not cleanup["forced"], "Unclean shutdown before baseline drive")
                baseline = evidence / "baseline"
                baseline.mkdir()
                # Same fixture/config/cwd and user input, but do not load the extension.
                baseline_command = command[:-2]
                if scenario == "non-splash":
                    terminal = run_tui(baseline_command, env, scratch, baseline, server, scenario)
                else:
                    run_non_tui(baseline_command, env, scratch, baseline, server, scenario)
                baseline_post = [e for e in server.events if e.get("method") == "POST"][-1]
                require(tested_post["payload_sha256"] == baseline_post["payload_sha256"],
                        "Ineligible inference payload differs from no-extension baseline")
                report["payload_matches_baseline"] = True
                baseline_files = observe_files(scratch)
                dump(evidence / "files-after-baseline.json", baseline_files)
                require(after_files["config_hashes"] == baseline_files["config_hashes"],
                        "Configuration differs from no-extension baseline")
            status = "HARNESS_ONLY_PASS" if args.command == "self-test" else "PASS"
            report["coverage"] = [scenario]
            code = 0
    except Blocked as e:
        status, code = "BLOCKED", 2
        report["reason"] = str(e)
    except (Exception, KeyboardInterrupt) as e:
        report["reason"] = f"{type(e).__name__}: {e}"
    finally:
        # Always clean failed iterations too. Keep artifacts separate from scratch state.
        try:
            if terminal:
                cleanup = terminal.close()
                target = evidence / "baseline" if (evidence / "baseline").exists() else evidence
                dump(target / "process-cleanup.json", cleanup)
                if not cleanup["group_gone"] or cleanup["forced"]:
                    status, code = "FAIL", 1
                    report["reason"] = "Pi did not shut down cleanly; inspect process-cleanup.json"
        except Exception as e:
            status, code = "FAIL", 1
            report["reason"] = f"Cleanup failed: {type(e).__name__}: {e}"
        finally:
            if server:
                server.stopping.set()
                for stream in server.streams:
                    stream["release_prefill"].set()
                    stream["release_generation"].set()
                server.shutdown()
                server.server_close()
                worker.join(timeout=3)
            if scratch:
                shutil.rmtree(scratch)
            report.update(status=status, scratch_removed=scratch is None or not scratch.exists(),
                          fixture_closed=server is None or server.fileno() == -1,
                          evidence_survives=evidence.is_dir())
            dump(evidence / "result.json", report)
    print(json.dumps(report, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
