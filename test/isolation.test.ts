import assert from "node:assert/strict";
import test from "node:test";
import { childEnvironment } from "../scripts/isolation.mjs";

test("child environment is an explicit allowlist with isolated state and no inherited credentials", () => {
  const environment = childEnvironment("/tmp/example", {
    PATH: "/usr/bin", HOME: "/real/home", OPENAI_API_KEY: "test-secret", ANTHROPIC_API_KEY: "test-secret",
    NODE_OPTIONS: "--import=untrusted", PI_CODING_AGENT_DIR: "/real/config", HTTPS_PROXY: "http://invalid",
    PI_OFFLINE: "0", NPM_TOKEN: "test-secret",
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin", HOME: "/tmp/example/home", USERPROFILE: "/tmp/example/home",
    TMPDIR: "/tmp/example/tmp", XDG_CONFIG_HOME: "/tmp/example/config", XDG_CACHE_HOME: "/tmp/example/cache",
    PI_CODING_AGENT_DIR: "/tmp/example/agent", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0", LANG: "C.UTF-8", CI: "1",
  });
});

test("isolation requires an absolute root and a usable fallback PATH", () => {
  assert.throws(() => childEnvironment("relative", {}));
  assert.equal(childEnvironment("/tmp/example", {}).PATH, "/usr/bin:/bin");
});
