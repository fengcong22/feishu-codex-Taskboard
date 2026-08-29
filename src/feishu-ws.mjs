import {
  BITABLE_RECORD_CHANGED_EVENT,
  normalizeBitableRecordChanged,
} from "./feishu-event.mjs";
import { safeDeliveryErrorCode } from "./retry-policy.mjs";

export { BITABLE_RECORD_CHANGED_EVENT } from "./feishu-event.mjs";

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be set`);
  }
  return value.trim();
}

function sourceEvent(payload) {
  return payload?.event && typeof payload.event === "object" ? payload.event : payload;
}

function sourceHeader(payload) {
  return payload?.header && typeof payload.header === "object" ? payload.header : {};
}

function createClientSdk(sdk) {
  const value = sdk?.default && typeof sdk.default === "object" ? sdk.default : sdk;
  if (!value || typeof value.WSClient !== "function" || typeof value.EventDispatcher !== "function") {
    throw new Error("Feishu SDK must export WSClient and EventDispatcher");
  }
  return value;
}

function findStopMethod(client) {
  for (const method of ["stop", "close", "disconnect"]) {
    if (typeof client?.[method] === "function") return method;
  }
  return null;
}

async function stopClient(client, method) {
  if (!method) return false;
  await client[method]();
  return true;
}

function safeErrorSummary(error, fallback) {
  return {
    code: safeDeliveryErrorCode(error?.code, fallback),
    at: Date.now(),
  };
}

function workflowConfigUnavailable(cause) {
  const error = new Error("Feishu workflow configuration is unavailable");
  error.code = "FEISHU_WORKFLOW_CONFIG_UNAVAILABLE";
  error.status = 503;
  Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}

/** Load the official SDK when Base metadata or the real listener is needed. */
export async function loadFeishuSdk() {
  try {
    return await import("@larksuiteoapi/node-sdk");
  } catch (error) {
    const wrapped = new Error(
      "Feishu integration requires @larksuiteoapi/node-sdk. Run npm install before using it.",
      { cause: error },
    );
    wrapped.code = "FEISHU_SDK_MISSING";
    throw wrapped;
  }
}

export function createFeishuWsListener({
  appId,
  appSecret,
  tables,
  getTables,
  handleEvent,
  sdk,
  logger = console,
  onStatus = () => {},
} = {}) {
  const normalizedAppId = nonEmpty(appId, "FEISHU_APP_ID");
  const normalizedSecret = nonEmpty(appSecret, "FEISHU_APP_SECRET");
  if ((!Array.isArray(tables) || tables.length === 0) && typeof getTables !== "function") {
    throw new Error("Feishu listener requires at least one table configuration");
  }
  if (typeof handleEvent !== "function") throw new Error("handleEvent must be a function");

  const sdkModule = createClientSdk(sdk);
  const wsClient = new sdkModule.WSClient({
    appId: normalizedAppId,
    appSecret: normalizedSecret,
    autoReconnect: true,
  });

  let queue = Promise.resolve();
  let state = "idle";
  let lastEventAt = null;
  let lastError = null;
  let startPromise = null;
  let stopRequested = false;

  function notifyStatus(status, detail) {
    try {
      onStatus(status, detail);
    } catch {
      // Status observers are diagnostics only and must not break event delivery.
    }
  }

  function recordStartFailure(error) {
    if (stopRequested) return;
    lastError = safeErrorSummary(error, "FEISHU_LISTENER_START_FAILED");
    state = "error";
    notifyStatus(state, lastError);
  }

  const eventDispatcher = new sdkModule.EventDispatcher({}).register({
    [BITABLE_RECORD_CHANGED_EVENT]: async (payload) => {
      const processing = queue.then(async () => {
        let currentTables;
        try {
          currentTables = typeof getTables === "function" ? await getTables() : tables;
        } catch (cause) {
          throw workflowConfigUnavailable(cause);
        }
        if (!Array.isArray(currentTables) || currentTables.length === 0) return;
        const source = sourceEvent(payload) ?? {};
        const header = sourceHeader(payload);
        const fileToken = source.file_token
          ?? source.fileToken
          ?? source.base_token
          ?? source.baseToken
          ?? header.token
          ?? header.file_token
          ?? header.fileToken
          ?? header.base_token
          ?? header.baseToken;
        const tableIds = new Set([
          source.table_id,
          source.tableId,
          ...(Array.isArray(source.action_list)
            ? source.action_list.flatMap((action) => [action?.table_id, action?.tableId])
            : []),
        ].filter((value) => typeof value === "string" && value));
        const tokenTables = currentTables.filter((table) => (
          !table.baseToken || !fileToken || table.baseToken === fileToken
        ));
        const idMatches = tableIds.size > 0
          ? tokenTables.filter((table) => tableIds.has(table.tableId))
          : [];
        // Missing Base tokens are ambiguous when multiple Bases reuse a table id.
        const duplicateTableId = new Set(idMatches.map((table) => table.tableId)).size !== idMatches.length;
        const matchingTables = tableIds.size > 0
          ? (!fileToken && duplicateTableId ? [] : idMatches)
          : tokenTables.length === 1 ? tokenTables : [];
        const events = matchingTables.flatMap((table) => normalizeBitableRecordChanged(payload, table));
        if (events.length === 0) return;
        lastEventAt = Date.now();
        for (const event of events) await handleEvent(event);
      });
      queue = processing.catch((error) => {
        const summary = safeErrorSummary(error, "FEISHU_EVENT_HANDLER_FAILED");
        lastError = summary;
        try {
          logger.error?.(`Feishu event handling failed: ${summary.code}`);
        } catch {
          // Logging must not turn a handled callback failure into a stuck queue.
        }
        notifyStatus("error", summary);
      });
      return processing;
    },
  });

  return {
    wsClient,
    eventDispatcher,
    get state() {
      return state;
    },
    get health() {
      return {
        state,
        lastEventAt,
        lastError: lastError ? { ...lastError } : null,
      };
    },
    start() {
      if (startPromise) return startPromise;
      state = "starting";
      notifyStatus(state);
      let result;
      try {
        result = wsClient.start({ eventDispatcher });
      } catch (error) {
        recordStartFailure(error);
        throw error;
      }
      if (result && typeof result.then === "function") {
        startPromise = Promise.resolve(result).then((value) => {
          if (!stopRequested) {
            state = "sdk_managed";
            notifyStatus(state);
          }
          return value;
        }, (error) => {
          recordStartFailure(error);
          throw error;
        });
      } else {
        if (!stopRequested) {
          state = "sdk_managed";
          notifyStatus(state);
        }
        startPromise = Promise.resolve(result);
      }
      return startPromise;
    },
    async stop() {
      const stopMethod = findStopMethod(wsClient);
      if (stopMethod) stopRequested = true;
      await this.drain();
      const stopped = await stopClient(wsClient, stopMethod);
      if (stopped) {
        state = "stopped";
        notifyStatus(state);
      }
    },
    drain() {
      return queue;
    },
  };
}
