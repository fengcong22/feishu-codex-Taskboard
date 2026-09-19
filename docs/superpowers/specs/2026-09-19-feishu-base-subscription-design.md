# Feishu Base Subscription Controls

## Goal

Let an operator inspect, create, and cancel the Feishu record-change event subscription for a Base from Taskboard without exposing Feishu credentials to the browser.

## User Experience

The left Base navigation shows a compact subscription state beside each Base name. The Base action menu contains `Refresh subscription status` and either `Subscribe events` or `Cancel subscription`.

Cancellation requires a confirmation dialog. It explains that the change applies to every subject in that Base, stops future record-change notifications, and does not alter existing Taskboard tasks or data in Feishu. A request in progress disables the related controls. Success and failure are reported through the existing Taskboard feedback surface.

The subscription state and the local listener state remain distinct. A subscribed Base can still lack a running local listener; the UI describes only the Base event subscription.

## Architecture

Only Bridge owns the Feishu SDK client and calls `drive.v1.file.getSubscribe`, `subscribe`, and `deleteSubscribe` with `file_type: bitable`. Bridge exposes three authenticated loopback workflow endpoints accepting a validated Base token. Their responses contain only `{ subscribed: boolean }`; SDK errors, credentials, and remote error details remain private.

Taskboard accepts a Base token only after its local workflow store confirms the Base exists. It proxies the request to Bridge with the existing Taskboard-to-Bridge secret, maps remote failures to safe local API errors, and never persists subscription status. Each status read is live, so external changes are reflected after Refresh.

The browser calls only Taskboard local APIs. The base navigator fetches the current status when a Base is expanded, lets the operator refresh it, and performs the approved mutation. It keeps other Base rows usable while one Base is busy.

## Error Handling and Tests

Invalid or unknown Base tokens are rejected before contacting Bridge. Bridge rejects missing authentication, unsupported HTTP methods, malformed tokens, absent SDK methods, malformed SDK responses, and non-success SDK replies with controlled codes. A mutation is followed by a read-back verification before reporting success.

Tests cover Bridge request authentication and SDK request shapes, Taskboard's known-Base boundary and proxy behavior, and navigator status rendering, confirmation, busy state, success, and retryable failure.
