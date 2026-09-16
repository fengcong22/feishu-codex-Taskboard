# Windows catalog lifecycle repair

**Goal:** Close all temporary catalog processes before returning success or failure so Windows workspaces can be released; explain the independent Auto-Cut input blocker in the upgrade guide.

**Design:** Retain the skills result/error while terminating its child. Settle only on `close`, with a bounded SIGTERM grace period followed by SIGKILL; model probe deadlines use SIGKILL. Wait for both parallel catalog probes even when one fails, returning the first reported rejection after cleanup. Concurrent failures do not have a guaranteed chronological diagnostic priority. Do not change Feishu routing, package snapshot trust, automatic execution settings or production data.

**Validation:** Node test runner on Windows with real fixture processes. The parent holds termination until an ordering assertion has run; avoid elapsed-time assertions and Windows signal handlers. Full repository tests and independent code review finish the repair.

- [x] Add failing success/error process-close regression tests.
- [x] Repair skills child lifecycle and parallel discovery cleanup; cover spawn errors, premature exit and sibling failures.
- [x] Trace the ZIP directory snapshot blocker and fix a reproducible repository defect or document the required local diagnosis without rewriting historical snapshots.
- [x] Update README and add a Windows upgrade follow-up guide with explicit test/production boundaries.
- [x] Run `npm test`, review the diff independently, and prepare the reviewed changes and upgrade instructions for delivery.

## Verification

Windows Node v24.18.0, 2026-09-16: full `npm test` exited 0; Node tests 1662 passed, 0 failed, 3 skipped (1665 total); typecheck and Web build passed; 85 component tests passed. Build emits the existing chunk-size advisory. No EBUSY or bad-port failure appeared in this full run.

Focused preflight runs exposed intermittent Fetch `bad port` from the machine's dynamic TCP range (1024–15000); those cases passed independently. No machine port settings, production services, credentials, local registry or persisted execution settings were changed. The full run and fixture ZIP completion do not claim real-media readiness on the deployment computer.

Independent review identified a model-probe SIGTERM timeout gap; the model deadline now uses SIGKILL and its regression passed before the full suite. Final review found no blocking issue in process cleanup, frozen ZIP source selection, receipt validation or upgrade instructions.
