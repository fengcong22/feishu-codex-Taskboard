import { createServer } from "node:http";
import { isIP } from "node:net";

import { safeDeliveryErrorCode } from "./retry-policy.mjs";
import { parseBaseLink } from "./feishu-base-metadata.mjs";

const BODY_LIMIT = 1_000_000;
const BRIDGE_CLIENT_HEADER = "x-feishu-bridge-client";

function publicFailure(error) {
  return {
    code: safeDeliveryErrorCode(error?.code, "BRIDGE_FAILURE"),
    message: "Bridge request failed",
  };
}

function controlledErrorStatus(error, fallback = 400) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
    ? error.status
    : fallback;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function isLoopbackHostname(value) {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") return true;
  return isIP(hostname) === 4 && hostname.split(".")[0] === "127";
}

function isLoopbackHostHeader(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value) {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && parsed.username === ""
      && parsed.password === ""
      && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function requireLocalJsonWrite(request, response, expectedClient) {
  if (!isLoopbackHostHeader(request.headers.host)) {
    sendJson(response, 403, {
      error: { code: "INVALID_HOST", message: "Local write request rejected" },
    });
    return false;
  }
  if (!isLoopbackOrigin(request.headers.origin)) {
    sendJson(response, 403, {
      error: { code: "INVALID_ORIGIN", message: "Local write request rejected" },
    });
    return false;
  }
  const contentType = request.headers["content-type"];
  const mediaType = typeof contentType === "string"
    ? contentType.split(";", 1)[0].trim().toLowerCase()
    : null;
  if (mediaType !== "application/json") {
    sendJson(response, 415, {
      error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" },
    });
    return false;
  }
  if (request.headers[BRIDGE_CLIENT_HEADER] !== expectedClient) {
    sendJson(response, 403, {
      error: { code: "BRIDGE_CLIENT_REQUIRED", message: "Local write request rejected" },
    });
    return false;
  }
  return true;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > BODY_LIMIT) throw new Error("request body is too large");
  }
  return JSON.parse(body || "null");
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("event must be an object");
  }
  for (const field of ["eventId", "baseToken", "tableId", "recordId", "fieldName"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  if (!event.fields || typeof event.fields !== "object" || Array.isArray(event.fields)) {
    throw new Error("fields must be an object");
  }
  return {
    ...event,
    eventId: event.eventId.trim(),
    baseToken: event.baseToken.trim(),
    tableId: event.tableId.trim(),
    recordId: event.recordId.trim(),
    recordTitle: typeof event.recordTitle === "string" ? event.recordTitle.trim() : "",
    fieldName: event.fieldName.trim(),
  };
}

function validateBasePreview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("Invalid Base link");
    error.code = "INVALID_BASE_LINK";
    throw error;
  }
  if (typeof value.url !== "string" || value.url.trim() === "") {
    const error = new Error("Invalid Base link");
    error.code = "INVALID_BASE_LINK";
    throw error;
  }
  const url = value.url.trim();
  parseBaseLink(url);
  return url;
}

export function createBridgeServer({
  host,
  port,
  configSummary,
  handleEvent,
  getHealth,
  baseMetadataReader,
  previewBase,
  workflowStore,
}) {
  let address = null;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        const health = typeof getHealth === "function" ? await getHealth() : { ok: true };
        return sendJson(response, 200, health);
      }
      if (request.method === "GET" && url.pathname === "/api/config-summary") {
        return sendJson(response, 200, configSummary);
      }
      if (request.method === "POST" && url.pathname === "/api/feishu/base-preview") {
        let source;
        try {
          source = validateBasePreview(await readJson(request));
        } catch (error) {
          return sendJson(response, 400, {
            error: { code: "INVALID_BASE_LINK", message: "Invalid Base link" },
          });
        }
        const preview = typeof baseMetadataReader?.preview === "function"
          ? baseMetadataReader.preview.bind(baseMetadataReader)
          : typeof previewBase === "function" ? previewBase : null;
        if (!preview) {
          return sendJson(response, 503, {
            error: { code: "FEISHU_METADATA_UNAVAILABLE", message: "Bridge request failed" },
          });
        }
        try {
          return sendJson(response, 200, await preview(source));
        } catch (error) {
          return sendJson(response, controlledErrorStatus(error, 502), {
            error: publicFailure(error),
          });
        }
      }
      if (url.pathname === "/api/feishu/workflow/share/export") {
        if (request.method !== "GET") {
          return sendJson(response, 405, {
            error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
          });
        }
        if (!workflowStore || typeof workflowStore.exportShareable !== "function") {
          return sendJson(response, 503, {
            error: { code: "WORKFLOW_SHARE_UNAVAILABLE", message: "Bridge request failed" },
          });
        }
        try {
          return sendJson(response, 200, {
            configuration: await workflowStore.exportShareable(),
          });
        } catch (error) {
          return sendJson(response, 502, { error: publicFailure(error) });
        }
      }
      if (url.pathname === "/api/feishu/workflow/share/import") {
        if (request.method !== "POST") {
          return sendJson(response, 405, {
            error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
          });
        }
        if (!requireLocalJsonWrite(request, response, "local-operator")) return;
        if (!workflowStore || typeof workflowStore.importShareable !== "function") {
          return sendJson(response, 503, {
            error: { code: "WORKFLOW_SHARE_UNAVAILABLE", message: "Bridge request failed" },
          });
        }
        let body;
        try {
          body = await readJson(request);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_JSON", message: "Invalid workflow share import" },
          });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)
          || !body.configuration || typeof body.configuration !== "object"
          || Array.isArray(body.configuration)
          || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) {
          return sendJson(response, 400, {
            error: { code: "INVALID_FIELD", message: "Invalid workflow share import" },
          });
        }
        const dryRun = body.dryRun ?? false;
        try {
          const result = await workflowStore.importShareable(body.configuration, { dryRun });
          const configuration = result?.configuration ?? result;
          const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
          const diagnosticsOk = typeof result?.diagnosticsOk === "boolean"
            ? result.diagnosticsOk
            : diagnostics.every((entry) => entry?.severity !== "error");
          return sendJson(response, 200, {
            configuration,
            diagnostics,
            diagnosticsOk,
            dryRun,
          });
        } catch (error) {
          const status = controlledErrorStatus(error);
          return sendJson(response, status, { error: publicFailure(error) });
        }
      }
      if (url.pathname === "/api/feishu/workflow/sync") {
        if (request.method !== "POST") {
          return sendJson(response, 405, {
            error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
          });
        }
        if (!requireLocalJsonWrite(request, response, "taskboard")) return;
        if (!workflowStore || typeof workflowStore.syncSubject !== "function") {
          return sendJson(response, 503, {
            error: { code: "WORKFLOW_SYNC_UNAVAILABLE", message: "Bridge request failed" },
          });
        }
        let body;
        try {
          body = await readJson(request);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_JSON", message: "Invalid request" },
          });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)
          || !body.subject || typeof body.subject !== "object"
          || !["enabled", "disabled"].includes(body.lifecycle)
          || !Number.isSafeInteger(body.expectedVersion)
          || body.expectedVersion < 1) {
          return sendJson(response, 400, {
            error: { code: "INVALID_FIELD", message: "Invalid workflow sync request" },
          });
        }
        try {
          const subject = await workflowStore.syncSubject(body.subject, {
            lifecycle: body.lifecycle,
            expectedVersion: body.expectedVersion,
          });
          return sendJson(response, 200, { subject });
        } catch (error) {
          const status = controlledErrorStatus(error);
          return sendJson(response, status, { error: publicFailure(error) });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/simulate/record-changed") {
        if (!requireLocalJsonWrite(request, response, "local-operator")) return;
        let event;
        try {
          event = validateEvent(await readJson(request));
        } catch (error) {
          return sendJson(response, 400, {
            error: { code: "INVALID_EVENT", message: "Invalid simulated event" },
          });
        }
        const outcome = await handleEvent(event);
        const status = outcome.kind === "pending" || outcome.kind === "dead_letter" ? 202
          : outcome.kind === "ready" || outcome.kind === "blocked" ? (outcome.duplicate ? 200 : 201)
            : 200;
        return sendJson(response, status, outcome);
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    } catch (error) {
      sendJson(response, 502, {
        error: publicFailure(error),
      });
    }
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        address = server.address();
        resolve(address);
      });
    }),
    close: () => new Promise((resolve, reject) => {
      if (!address) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
