## Summary

<!-- What changed and why. Link an issue if one exists. -->

## Related issue

<!-- Fixes #... or N/A -->

## Changes

<!-- Bullet the important changes. -->

## Verification

Paste the command output, not just "tests pass".

```text
$ npm run check
...
```

```text
$ npm run test:e2e
...
```

- [ ] `npm run check` passes; output is pasted above.
- [ ] `npm run test:e2e` passes for wiring, packaging, command-contract, or Pi-baseline changes.
- [ ] New behavior has a test; a bug fix has a regression test that fails without the fix.
- [ ] `README.md`, relevant `docs/`, and `CHANGELOG.md` are updated for user-visible changes.
- [ ] Cancellation and cleanup are implemented and tested for any new subprocess, timer, server, temporary file, or open handle.
- [ ] Package contents still match the allowlist; no agent docs, tests, e2e files, docs, secrets, environment files, or tarballs are packed.
- [ ] No new runtime dependency, or the dependency is justified and host packages remain peer dependencies.
- [ ] No credentials, prompts, private session content, or real home-directory paths are included.
- [ ] No tag or publish step is included in this change.
- [ ] AI assistance is disclosed if required by your employer or the project.

## Notes for reviewers

<!-- Trade-offs, follow-up work, or open questions. -->
