# Windows Codex CLI discovery

## Problem and approved scope

Codex Desktop can open normally while Explorer-launched Taskboard cannot find `codex.exe`: the launcher currently searches only PATH and one default npm vendor directory. Deployment-session environment overrides do not persist into later double-click launches. The remote machine's exact installation has not been inspected; this change addresses the demonstrated discovery gap.

## Design

- Share PowerShell 5.1-compatible discovery between startup and dependency checking.
- Preserve explicit override and PATH priority. Add controlled Desktop CLI candidates under `%LOCALAPPDATA%\OpenAI\Codex\bin` and native-architecture npm vendor candidates from the actual npm global root and the default location. Resolve npm's JavaScript entry beside its installed shim and invoke it directly with Node. Do not scan whole drives or launch Desktop GUI binaries.
- Validate candidate executables with bounded `--version` probes, accepting successful `codex-cli` version responses. Continue past missing, invalid, or timed-out candidates. Suppress raw probe output.
- Create probes suspended, attach them to a private Windows Job Object, then resume. Clean the entire job on completion or timeout; inherit only the three standard-stream pipe handles. Decode output as UTF-8 and cap each stream at 32 KiB. If native setup fails, reject the candidate.
- Use read-only npm root lookup with logging, timing, update notifications and network disabled. Preserve npm prefix configuration, but use its existing installation directory for cache to avoid creating configured cache/log locations.
- Enumerate version directories on each invocation; never write versioned installation paths to user/machine environment or repository configuration.
- Add `check-local.ps1 -DependenciesOnly` to check Node and CLI without requiring configuration or running services. Regular checks also validate the CLI, preserving existing health checks.
- Retain loopback, secrets, task routing, automatic execution settings, and service lifecycle behavior.

## Verification and delivery

Use harmless executable fixtures in isolated temporary directories to cover Desktop-only/fresh-process discovery, npm custom locations, architecture, stale overrides, version updates, malformed responses and timeouts. Run existing startup and deployment checks plus repository verification, then obtain independent review. Publish the reviewed fix through a branch and pull request after checks pass. No live service operation, remote-machine changes, or Codex installation/login is part of this task.
