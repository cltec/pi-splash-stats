#!/usr/bin/env python3
"""Exercise the verifier, NOT the proposed extension, using real Pi and a no-op fixture."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("verify", HERE / "verify.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class HarnessTests(unittest.TestCase):
    runs = []

    def test_environment_is_allowlisted(self):
        env = verify.clean_env(Path("/tmp/unused-verifier-test"))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn("HTTP_PROXY", env)
        self.assertNotIn("PI_SESSION_FILE", env)
        self.assertEqual(env["PI_OFFLINE"], "1")
        self.assertEqual(env["PI_TELEMETRY"], "0")

    def test_ansi_removal(self):
        self.assertEqual(verify.ANSI.sub("", "\x1b[32m50%\x1b[0m"), "50%")

    def test_summary_settings_keep_sessions_compactible(self):
        self.assertEqual(verify.build_settings("compact")["compaction"],
                         {"enabled": False, "keepRecentTokens": 200})
        self.assertEqual(verify.build_settings("chat")["compaction"], {"enabled": False})
        self.assertEqual(verify.build_settings("tree")["compaction"], {"enabled": False})

    def test_tree_cursor_detection_uses_displayed_text(self):
        screen = (
            "Session Tree\n"
            " • [system]\n"
            "› • user: Verify tree-turn-1.\n"
            " (1/2)\n"
            "↑↓ navigate\n"
        )
        self.assertTrue(verify.tree_cursor_on(screen, "Verify tree-turn-1."))
        self.assertFalse(verify.tree_cursor_on(screen, "Verify tree-turn-2."))
        self.assertFalse(verify.tree_cursor_on("no tree here", "Verify tree-turn-1."))

    def invoke(self, *args):
        command = [str(HERE / "verify.py"), *args]
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            out, err = child.communicate(timeout=65)
        except subprocess.TimeoutExpired:
            # subprocess.run(timeout=...) would SIGKILL the controller and orphan its separate Pi group.
            child.send_signal(verify.signal.SIGINT)
            out, err = child.communicate()  # Let the helper's bounded finally cleanup finish.
            self.fail(f"Verifier timed out; interrupted with cleanup: {out} {err}")
        result = subprocess.CompletedProcess(command, child.returncode, out, err)
        first, rest = result.stdout.split("\n", 1)
        evidence = Path(first.removeprefix("Evidence: "))
        report = json.loads(rest)
        report["test_context"] = "Verifier infrastructure test only; no-op/missing package, NOT product proof."
        verify.dump(evidence / "result.json", report)
        self.runs.append({"evidence": str(evidence), "exit_code": result.returncode, "status": report["status"]})
        self.assertTrue((evidence / "result.json").is_file())
        self.assertTrue(report["scratch_removed"])
        self.assertTrue(report["fixture_closed"])
        self.assertTrue(report["evidence_survives"])
        for cleanup in evidence.rglob("process-cleanup.json"):
            self.assertTrue(json.loads(cleanup.read_text())["group_gone"])
        # Evidence deliberately survives these tests, including failed product assertions.
        return result.returncode, report, evidence

    def test_real_pi_harness_and_missing_feature_detection(self):
        with tempfile.TemporaryDirectory(prefix="verifier-noop-package-") as tmp:
            package = Path(tmp)
            (package / "src").mkdir()
            (package / "package.json").write_text(json.dumps({"name": "pi-splash-stats", "version": "0.0.0",
                "private": True, "type": "module", "pi": {"extensions": ["./src/index.ts"]}}))
            (package / "src/index.ts").write_text("export default function () {}\n")
            code, report, _ = self.invoke("self-test")
            self.assertEqual((code, report["status"]), (0, "HARNESS_ONLY_PASS"))
            for scenario in ("non-splash", "print", "json", "rpc"):
                with self.subTest(scenario=scenario):
                    code, report, evidence = self.invoke("run", scenario, "--package", str(package))
                    self.assertEqual((code, report["status"]), (0, "PASS"), report)
                    self.assertNotEqual(report["coverage"], ["chat"])
                    self.assertTrue((evidence / "http.jsonl").is_file())
            code, report, _ = self.invoke("run", "chat", "--package", str(package))
            self.assertEqual((code, report["status"]), (1, "FAIL"))
            self.assertIn("50%", report["reason"])
        # Missing package preconditions must be blocked rather than a passing self-test fallback.
        with tempfile.TemporaryDirectory(prefix="verifier-empty-package-") as tmp:
            code, report, _ = self.invoke("run", "chat", "--package", tmp)
            self.assertEqual((code, report["status"]), (2, "BLOCKED"))


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False).result
    summary = verify.ROOT / ".verification-evidence" / ("harness-tests-" + verify.uuid.uuid4().hex[:8] + ".json")
    verify.dump(summary, {"purpose": "Verifier infrastructure only; no-op package is NOT the product",
                          "passed": result.wasSuccessful(), "runs": HarnessTests.runs})
    print(f"Harness test evidence: {summary}")
    raise SystemExit(0 if result.wasSuccessful() else 1)
