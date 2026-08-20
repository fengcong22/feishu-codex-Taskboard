import { createServer } from "node:http";

import { safeDeliveryErrorCode } from "./retry-policy.mjs";

const BODY_LIMIT = 1_000_000;

function publicFailure(error) {
  return {
    code: safeDeliveryErrorCode(error?.code, "BRIDGE_FAILURE"),
    message: "Bridge request failed",
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
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

export function createBridgeServer({ host, port, configSummary, handleEvent, getHealth }) {
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
      if (request.method === "POST" && url.pathname === "/api/simulate/record-changed") {
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
