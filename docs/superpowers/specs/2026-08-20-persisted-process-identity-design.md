# Persisted Process Identity Design

## Problem

The local launchers persist only numeric process IDs. Windows can reuse a stale
PID after its original process exits. Script-path validation reduces the risk,
but a different Node process using the same script path can still be mistaken
for the launcher-owned service and terminated.

## Design

Keep the existing `.runtime/taskboard.pid` and `.runtime/bridge.pid` files for
launcher compatibility. Add one ignored JSON identity sidecar per service. Each
sidecar records `version: 1`, the PID, and the process creation time reported by
`Win32_Process.CreationDate`. Creation ticks are encoded as a decimal string so
future JSON readers cannot lose 64-bit precision.

Before reusing, replacing, cleaning up, or stopping a process from a persisted
marker, require all applicable checks:

- PID and persisted creation time match the current process.
- The process uses the exact Node executable selected by the launcher and runs
  the exact expected script.
- Every listener owned by that PID on the expected port uses exactly the IPv4
  loopback address `127.0.0.1`; wildcard and IPv6 listeners are rejected.

A legacy PID-only marker may be adopted by the startup script without
interruption only when the script, listening port, endpoint health, and Bridge
mode checks succeed. Adoption immediately writes the identity sidecar. The stop
script never upgrades a legacy marker or terminates its process; it leaves the
process running and directs the user to run startup once for safe migration.
An unverified marker is removed, but its process is left running. A mode change
that would require stopping an unverified Bridge is rejected with an actionable
error.

Identity sidecars are written only after the child process has been observed
and its creation time is available. A healthy legacy or unmarked process is
re-queried after endpoint and mode validation; its creation identity, script,
and loopback port must still match before startup persists ownership. Startup
failure cleanup has no time-range fallback: without a captured exact creation
identity, it leaves the process and markers untouched.

Marker cleanup removes both the PID and identity sidecar only when they still
refer to the expected instance. Before removing a legacy or invalid marker, the
startup and stop scripts confirm that the identity sidecar remains absent or
has the same bytes they observed; Bridge mode sidecars are guarded by the same
snapshot check. If a live target cannot be verified or stopped, the stop script
continues checking the other target and then exits nonzero.

## Scope

Add `scripts/process-identity.ps1` and modify `scripts/start-local.ps1`,
`scripts/stop-local.ps1`, `test/startup-scripts.test.mjs`, and the launcher
explanation in `README.md`.
Do not change event filtering, Feishu credentials, ports, or loopback binding.

## Verification

Regression tests must prove both scripts require persisted creation identity
for destructive actions and safely handle legacy PID-only markers. PowerShell
5 parsing, the full Node test suite, and a real Feishu-enabled local health
check must pass before the branch is pushed.
