# Windows Codex CLI Discovery Implementation Plan

**Goal:** Make Windows source deployments discover a usable existing Codex CLI independently of a temporary deployment-session override.

**Architecture:** A shared PowerShell discovery helper owns candidate selection and bounded version validation. Startup consumes its resolved path; dependency checks exercise the same logic before deployment is accepted.

**Tech Stack:** Windows PowerShell 5.1, .NET process APIs, Node.js test runner.

## Constraints

Include the batch-policy fix in the release. Do not change services, local configuration, credentials, state or the other person's computer. Keep loopback and execution controls intact. Publish a reviewed branch and require the complete Windows CI verification before merging.

## Steps

- [x] Add failing isolated tests for Desktop-only discovery, npm location handling, candidate validation, priority, architecture and update recovery.
- [x] Implement `scripts/codex-discovery.ps1`; integrate into `scripts/start-local.ps1` and `scripts/check-local.ps1`.
- [x] Add and verify `-DependenciesOnly` integration tests; adapt the existing resolver regression tests to the shared helper and valid fixtures.
- [x] Update README and Windows deployment guide, requiring a fresh-process dependency check without temporary `CODEX_EXECUTABLE`.
- [x] Run focused tests and isolated real-process checks, then `npm.cmd test`; document any pre-existing failures separately.
- [x] Request independent review, address findings, inspect the final diff and report actual results.

## Verification record

- Helper suite: 15 passed, including actual npm prefix configuration, CP437/936, bounded output and whole-process-tree cleanup. Dependency-only integration and the three documented deployment-preflight tests pass.
- Real local Codex CLI is discovered and version-verified in a new PowerShell process with no `CODEX_EXECUTABLE` and PATH reduced to the Node installation directory. No service start/stop or real task execution was performed.
- Independent review reproduced and then verified fixes for UTF-8 decoding and descendant cleanup. Additional 32-bit PowerShell and repeated-probe handle checks passed; no remaining actionable finding.
- Initial complete Node test run via `npm.cmd test`: 1688 passed, 3 skipped, 1 failed. The unrelated existing `legacy registration cannot gain automatic execution eligibility without an active subject snapshot` test failed with Node fetch `bad port` after a random port allocation. Its entire file was rerun: 6 passed.
- Release-time local run: 1687 passed, 3 skipped, 2 failed in existing stage-registration and Auto-Cut lifecycle fixtures (`bad port` and `FEISHU_BRIDGE_UNAVAILABLE`). The machine's dynamic TCP port range is 1024–15000, which overlaps Fetch's prohibited ports; tests bind port 0. Local full runs are not claimed fully green. The reviewed branch must pass the unchanged complete Windows CI gate before merging; do not change the machine's networking configuration for these tests.
- Typecheck, web build, and all 92 component tests passed separately. Build retains existing CSS/bundle-size warnings.
- Earlier validation exposed inherited `npm_config_prefix` in the new test fixture, now isolated. Concurrent duplicate startup suites contended on the existing global lifecycle mutex; final full-suite verification ran without that duplicate suite.
