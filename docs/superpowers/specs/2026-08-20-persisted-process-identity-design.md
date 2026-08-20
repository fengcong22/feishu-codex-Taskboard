# Persisted Process Identity Design

## Problem

The local launchers persist only numeric process IDs. Windows can reuse a stale
PID after its original process exits. Script-path validation reduces the risk,
but a different Node process using the same script path can still be mistaken
for the launcher-owned service and terminated.

## Design

Keep the existing `.runtime/taskboard.pid` and `.runtime/bridge.pid` files for
launcher compatibility. Add one ignored JSON identity sidecar per service. Each
sidecar records the PID and the process creation time reported by
`Win32_Process.CreationDate`.

Before reusing, replacing, cleaning up, or stopping a process from a persisted
marker, require all applicable checks:

- PID and persisted creation time match the current process.
- The process is Node running the exact expected script.
- The expected loopback listening port belongs to that PID when adopting a
  legacy PID-only marker.

A legacy PID-only marker may be adopted without interruption only when the
script and listening-port checks both succeed. Adoption immediately writes the
identity sidecar. An unverified legacy marker is removed, but its process is
left running. A mode change that would require stopping an unverified Bridge is
rejected with an actionable error.

Identity sidecars are written only after the child process has been observed
and its creation time is available. Marker cleanup removes both the PID and
identity sidecar only when they still refer to the expected instance.

## Scope

Modify `scripts/start-local.ps1`, `scripts/stop-local.ps1`,
`test/startup-scripts.test.mjs`, and the launcher explanation in `README.md`.
Do not change event filtering, Feishu credentials, ports, or loopback binding.

## Verification

Regression tests must prove both scripts require persisted creation identity
for destructive actions and safely handle legacy PID-only markers. PowerShell
5 parsing, the full Node test suite, and a real Feishu-enabled local health
check must pass before the branch is pushed.
