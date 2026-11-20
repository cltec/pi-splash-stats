# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories:

https://github.com/OWNER/REPOSITORY/security/advisories/new

Do not open a public issue for a vulnerability. If the placeholder above has not been replaced, use the repository's **Security** tab and choose **Report a vulnerability**.

Include:

- The affected version.
- Pi and Node.js versions, the operating system, and whether the extension was loaded from a checkout or a package.
- A minimal reproduction, if possible.
- Impact and any suggested fix.
- Relevant output with credentials, prompts, and private session content removed.

Do not send API keys, access tokens, or user data. Redact paths and environment values that identify a person or machine.

## Scope

Extensions run inside the Pi process with the same operating-system permissions as Pi. A malicious or compromised extension can read files, run commands, and observe prompts that Pi can observe. This repository's example is deliberately small: it makes no network requests, reads no files, keeps no state, and registers only a command handler.

Security-relevant areas include:

- The extension entry point and command handler.
- Anything that expands the extension's file, process, network, or configuration access.
- Package contents, including accidental inclusion of agent instructions, tests, environment files, credentials, or development artifacts.
- Dependencies, if a fork adds any.
- Documentation that promises isolation, offline behavior, or data preservation the code does not provide.
- The e2e harness, which launches Pi, inspects and extracts tarballs with system `tar`, writes temporary Pi settings, and handles temporary homes. It does not exercise `pi install` or registry installation, so those paths need separate review if a fork relies on them.

If you add tools, resource files, subprocesses, network access, or configuration, extend this scope and document the trust and permission implications.

## What to expect

- Acknowledgment within 7 days.
- Triage and a remediation plan after validation.
- A GitHub Security Advisory and patched release when appropriate.
- Credit in the advisory unless you ask to remain anonymous.

## Safe harbor

Good-faith security research that follows this policy will not be pursued or reported as abuse. Do not access, modify, or exfiltrate data that is not yours. Stop testing and report promptly if you encounter third-party data or a service you do not own.

## Hardening notes for forks

- Keep the example's no-network, no-config, no-resource baseline until a feature needs otherwise.
- Keep packaging as an allowlist. The agent-facing files under `AGENTS.md`, `docs/`, `test/`, and `e2e/` are development material and must not be packed.
- Run tests in temporary homes and working directories. Never point tests at a real `~/.pi` configuration. Tooling fixtures belong under `os.tmpdir()` and must be removed in `finally`.
- Do not inherit provider credentials into the e2e Pi process. Pass an explicit environment allowlist.
- The packed e2e path loads an extracted local directory through temporary Pi settings; it does not run `pi install`. Do not treat that as proof that the `pi install` command or registry resolution is safe.
- Treat extension output and external command output as untrusted. Do not interpolate untrusted text into a shell command; pass arguments to `spawn`.
- Review dependency additions, install scripts, and optional dependencies before merging.
