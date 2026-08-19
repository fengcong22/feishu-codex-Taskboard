import {
  BITABLE_RECORD_CHANGED_EVENT,
  normalizeBitableRecordChanged,
} from "./feishu-event.mjs";

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

function createClientSdk(sdk) {
  const value = sdk?.default && typeof sdk.default === "object" ? sdk.default : sdk;
  if (!value || typeof value.WSClient !== "function" || typeof value.EventDispatcher !== "function") {
    throw new Error("Feishu SDK must export WSClient and EventDispatcher");
  }
  return value;
}

async function stopClient(client) {
  for (const method of ["stop", "close", "disconnect"]) {
    if (typeof client?.[method] === "function") {
      await client[method]();
      return true;
    }
  }
  return false;
}

function safeErrorCode(error, fallback) {
  const code = typeof error?.code === "string" ? error.code.trim() : "";
  // Error codes are surfaced in health and logs, so accept only a bounded,
  // identifier-like value rather than accidentally exposing an error message.
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(code) ? code : fallback;
}

function safeErrorSummary(error, fallback) {
  return {
    code: safeErrorCode(error, fallback),
    at: Date.now(),
  };
}

/** Load the official SDK only when the real listener is enabled. */
export async function loadFeishuSdk() {
  try {
    return await import("@larksuiteoapi/node-sdk");
  } catch (error) {
    const wrapped = new Error(
      "Feishu listener requires @larksuiteoapi/node-sdk. Run npm install before enabling it.",
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
  handleEvent,
  sdk,
  logger = console,
  onStatus = () => {},
} = {}) {
  const normalizedAppId = nonEmpty(appId, "FEISHU_APP_ID");
  const normalizedSecret = nonEmpty(appSecret, "FEISHU_APP_SECRET");
  if (!Array.isArray(tables) || tables.length === 0) {
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

  function notifyStatus(status, detail) {
    try {
      onStatus(status, detail);
    } catch {
      // Status observers are diagnostics only and must not break event delivery.
    }
  }

  function recordStartFailure(error) {
    state = "error";
    lastError = safeErrorSummary(error, "FEISHU_LISTENER_START_FAILED");
    notifyStatus(state, lastError);
  }

  const eventDispatcher = new sdkModule.EventDispatcher({}).register({
    [BITABLE_RECORD_CHANGED_EVENT]: (payload) => {
      const source = sourceEvent(payload) ?? {};
      const fileToken = source.file_token ?? source.fileToken ?? source.base_token ?? source.baseToken;
      const tableIds = new Set([
        source.table_id,
        source.tableId,
        ...(Array.isArray(source.action_list)
          ? source.action_list.flatMap((action) => [action?.table_id, action?.tableId])
          : []),
      ].filter((value) => typeof value === "string" && value));
      const tokenTables = tables.filter((table) => (
        !table.baseToken || !fileToken || table.baseToken === fileToken
      ));
      const matchingTables = tableIds.size > 0
        ? tokenTables.filter((table) => tableIds.has(table.tableId))
        : tokenTables.length === 1 ? tokenTables : [];
      const events = matchingTables.flatMap((table) => normalizeBitableRecordChanged(payload, table));
      if (events.length === 0) return Promise.resolve();
      lastEventAt = Date.now();
      const processing = queue.then(async () => {
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
          state = "sdk_managed";
          notifyStatus(state);
          return value;
        }, (error) => {
          recordStartFailure(error);
          throw error;
        });
      } else {
        state = "sdk_managed";
        notifyStatus(state);
        startPromise = Promise.resolve(result);
      }
      return startPromise;
    },
    async stop() {
      await this.drain();
      const stopped = await stopClient(wsClient);
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
