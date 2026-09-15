# Task Codex live status repair

**Goal:** A newly started task discovers its Codex conversation and updates its processing duration without reloading the page.

**Root cause:** The task binding event is published before asynchronous AI thread creation. The board refreshes tasks, while AiChat only loads its thread list on mount and subscribes to already known conversations. A single list refresh on task.updated would still race creation.

**Design:** Pass the active tasks' bound thread IDs from App to AiChat. While any bound thread is unknown, discover it through the existing read-only thread list immediately and then every two seconds. Stop discovery once all are known or tasks leave processing. Subscribe to known active task threads even when their initial state is idle, so the subsequent run-start hint is not missed. Discovery only adds missing threads and never changes panel selection or replaces fresher snapshots. Cancel requests and timers when the discovery scope changes or the component unmounts.

**Tradeoff:** This uses bounded-interval discovery during the short thread-creation gap instead of adding a second server event protocol. Existing per-thread SSE remains responsible for live progress. No backend restart is needed to load the rebuilt web client.

**Constraints:** Do not restart or interrupt the current Auto-Cut run. Do not alter production records, credentials, execution eligibility, ports, task routing, or persistent runtime state.

## Implementation and verification

- [x] Add component regressions with the real AiChat and task presentation: late thread creation, idle-to-running SSE transition, no panel-selection change, cleanup/retry behavior, and an older initial list arriving after discovery.
- [x] Run those regressions before implementation and confirm the expected failures.
- [x] Connect active task bindings in App; add discovery and active-thread subscriptions in AiChat, preserving newer thread objects on initial-list races.
- [x] Run component regressions, focused chat/progress tests, typecheck, and the standard npm test command.
- [x] Update README with automatic status synchronization and the meaning of processing duration.
- [x] Obtain independent review, rebuild the frontend, verify the local stack and existing running task through read-only checks, and commit locally.

## Validation evidence

- Ten component regressions failed before implementation because no discovery request or idle-thread subscription occurred; all ten passed after implementation.
- Full npm test: 1,560 Node tests passed, 3 skipped, 0 failed; 52 component tests passed. Typecheck and frontend build passed.
- Review found a delayed initial list could override a conversation selected after the request began. An eleventh regression reproduced this; a selection revision guard fixed it. Final component suite: 53 passed; final typecheck and build passed.
- The rebuilt page shows FEI-29 in processing with its running duration and conversation menu; the original delayed-creation case is covered by the component regressions without remounting the page.
- check-local.ps1 -RequireFeishu passed with sdk_managed. No services were restarted and no task was launched or interrupted for validation.
- Final independent review found no remaining Critical or Important issues. An unrelated duplicate review test run hit two ephemeral-port `fetch: bad port` failures; both affected task-start tests passed when rerun individually.

## Known minor limitation

Older native task bindings without structured threadBinding metadata can remain discovery candidates even though their IDs are absent from the local AI list. While such a task remains in processing, this causes an extra read-only list request every two seconds; it does not change execution or task state. Disambiguating those historical IDs is outside this Feishu status repair.
