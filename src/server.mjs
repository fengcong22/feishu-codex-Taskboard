import { createServer } from "node:http";
import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";

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

function loopbackAddress(value) {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/^::ffff:/u, "");
  return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

function matchingSecret(expected, supplied) {
  if (typeof expected !== "string" || expected.length === 0
    || typeof supplied !== "string" || supplied.length === 0) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertTaskboardCaller(request, expectedSecret) {
  if (!loopbackAddress(request.socket?.remoteAddress)) {
    const error = new Error("loopback caller required");
    error.code = "LOOPBACK_REQUIRED";
    error.status = 403;
    throw error;
  }
  if (!matchingSecret(expectedSecret, request.headers["x-feishu-bridge-secret"])
    || request.headers[BRIDGE_CLIENT_HEADER] !== "taskboard") {
    const error = new Error("Bridge authentication failed");
    error.code = "BRIDGE_AUTH_FAILED";
    error.status = 403;
    throw error;
  }
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error(`${name} must be an object`);
    error.code = "INVALID_CONTEXT_REQUEST";
    error.status = 400;
    throw error;
  }
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    const error = new Error(`${name} contains unsupported fields`);
    error.code = "INVALID_CONTEXT_REQUEST";
    error.status = 400;
    throw error;
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    const error = new Error(`${name} is required`);
    error.code = "INVALID_CONTEXT_REQUEST";
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function requiredVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    const error = new Error("configVersion is invalid");
    error.code = "INVALID_CONTEXT_REQUEST";
    error.status = 400;
    throw error;
  }
  return value;
}

function contextIdentity(body) {
  exactKeys(body, new Set(["subjectKey", "configVersion", "baseToken", "tableId", "recordId"]), "controlled context");
  return {
    subjectKey: requiredString(body.subjectKey, "subjectKey"),
    configVersion: requiredVersion(body.configVersion),
    baseToken: requiredString(body.baseToken, "baseToken"),
    tableId: requiredString(body.tableId, "tableId"),
    recordId: requiredString(body.recordId, "recordId"),
  };
}

function verifySubjectIdentity(subject, identity) {
  if (!subject || typeof subject !== "object"
    || subject.subjectKey !== identity.subjectKey
    || subject.configVersion !== identity.configVersion
    || (subject.baseToken && subject.baseToken !== identity.baseToken)
    || (subject.tableId && subject.tableId !== identity.tableId)) {
    const error = new Error("subject version does not match record identity");
    error.code = "SUBJECT_VERSION_MISMATCH";
    error.status = 409;
    throw error;
  }
}

function boundedContext(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    documentLinks: Array.isArray(input.documentLinks)
      ? input.documentLinks
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 32)
      : [],
    namingDisplayValue: typeof input.namingDisplayValue === "string"
      ? input.namingDisplayValue.slice(0, 1024)
      : "",
    namingValueUnique: input.namingValueUnique === true,
  };
}

function portableWorkflowSubject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const subject = structuredClone(value);
  if (subject.upload && typeof subject.upload === "object") {
    delete subject.upload.targetPath;
    delete subject.upload.artifactSourcePath;
  }
  if (subject.stages && typeof subject.stages === "object" && !Array.isArray(subject.stages)) {
    for (const stage of Object.values(subject.stages)) {
      if (stage && typeof stage === "object") {
        delete stage.artifactTargetPath;
        delete stage.artifact_target_path;
      }
    }
  }
  if (subject.packageConfig && typeof subject.packageConfig === "object") {
    delete subject.packageConfig.workspacePath;
    delete subject.packageConfig.prompt;
    delete subject.packageConfig.zipSourceDirectory;
  }
  return subject;
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

export function resolveSimulationEnabled({
  listenerEnabled = false,
  automaticExecutionEnabled = false,
} = {}) {
  return listenerEnabled === false && automaticExecutionEnabled === false;
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
  bridgeSecret = process.env.CODEX_FEISHU_BRIDGE_SECRET,
  metadataReader = null,
  baseMetadataReader,
  previewBase,
  workflowStore,
  getSubjectVersion = null,
  readControlledContext = null,
  syncSubject = null,
  simulationEnabled = false,
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
        const authenticatedReader = typeof metadataReader?.preview === "function"
          ? metadataReader
          : null;
        if (authenticatedReader) {
          try {
            assertTaskboardCaller(request, bridgeSecret);
          } catch (error) {
            return sendJson(response, controlledErrorStatus(error), {
              error: publicFailure(error),
            });
          }
        }
        let source;
        try {
          source = validateBasePreview(await readJson(request));
        } catch (error) {
          return sendJson(response, 400, {
            error: { code: "INVALID_BASE_LINK", message: "Invalid Base link" },
          });
        }
        const preview = authenticatedReader
          ? authenticatedReader.preview.bind(authenticatedReader)
          : typeof baseMetadataReader?.preview === "function"
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
      if (request.method === "POST" && url.pathname === "/api/feishu/workflow/controlled-context") {
        try {
          assertTaskboardCaller(request, bridgeSecret);
          const identity = contextIdentity(await readJson(request));
          const resolver = getSubjectVersion
            ?? (typeof workflowStore?.getSubjectVersion === "function"
              ? workflowStore.getSubjectVersion.bind(workflowStore)
              : null);
          if (!resolver) {
            const error = new Error("subject version store is unavailable");
            error.code = "WORKFLOW_VERSION_UNAVAILABLE";
            error.status = 503;
            throw error;
          }
          const subject = await resolver(identity.subjectKey, identity.configVersion);
          verifySubjectIdentity(subject, identity);
          const reader = readControlledContext
            ?? (typeof workflowStore?.readControlledContext === "function"
              ? workflowStore.readControlledContext.bind(workflowStore)
              : null);
          if (!reader) {
            const error = new Error("controlled context reader is unavailable");
            error.code = "CONTROLLED_CONTEXT_UNAVAILABLE";
            error.status = 503;
            throw error;
          }
          const context = await reader(subject, identity);
          return sendJson(response, 200, boundedContext(context));
        } catch (error) {
          return sendJson(response, controlledErrorStatus(error), {
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
        try {
          assertTaskboardCaller(request, bridgeSecret);
        } catch (error) {
          return sendJson(response, controlledErrorStatus(error), {
            error: publicFailure(error),
          });
        }
        const operation = syncSubject
          ?? (typeof workflowStore?.syncSubject === "function"
            ? workflowStore.syncSubject.bind(workflowStore)
            : null);
        if (!operation) {
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
          const subject = await operation(body.subject, {
            lifecycle: body.lifecycle,
            expectedVersion: body.expectedVersion,
          });
          return sendJson(response, 200, { subject: portableWorkflowSubject(subject) });
        } catch (error) {
          const status = controlledErrorStatus(error);
          return sendJson(response, status, { error: publicFailure(error) });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/simulate/record-changed") {
        let simulationAllowed;
        try {
          simulationAllowed = typeof simulationEnabled === "function"
            ? await simulationEnabled()
            : simulationEnabled;
        } catch {
          return sendJson(response, 503, {
            error: {
              code: "SIMULATION_POLICY_UNAVAILABLE",
              message: "Cannot verify the current automatic execution setting",
            },
          });
        }
        if (simulationAllowed !== true) {
          return sendJson(response, 403, {
            error: { code: "SIMULATION_DISABLED", message: "Simulated events are disabled" },
          });
        }
        if (!requireLocalJsonWrite(request, response, "local-operator")) return;
        let event;
        try {
          event = validateEvent(await readJson(request));
        } catch (error) {
          return sendJson(response, 400, {
            error: { code: "INVALID_EVENT", message: "Invalid simulated event" },
          });
        }
        const outcome = await handleEvent({ ...event, deliverySource: "simulation" });
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
