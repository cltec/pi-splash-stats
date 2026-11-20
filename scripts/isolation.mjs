import { isAbsolute, join } from "node:path";

/** Allowlist, never a copy of the parent environment: no credentials or user hooks. */
export function childEnvironment(root, source = process.env) {
  if (!isAbsolute(root)) throw new Error("Isolation root must be absolute");
  return {
    PATH: source.PATH || "/usr/bin:/bin",
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LANG: "C.UTF-8",
    CI: "1",
  };
}
