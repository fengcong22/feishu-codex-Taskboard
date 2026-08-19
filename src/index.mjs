import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { createBridge } from "./bridge.mjs";
import { createBridgeServer } from "./server.mjs";
import { createCompensationWorker } from "./compensation-worker.mjs";
import { JsonStateStore } from "./state-store.mjs";
import { TaskboardClient } from "./taskboard-client.mjs";
import { createFeishuWsListener, loadFeishuSdk } from "./feishu-ws.mjs";
import { createFeishuRecordTitleResolver } from "./feishu-record-reader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(process.env.BRIDGE_ENV_FILE ?? path.join(root, ".env.local"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const configFile = process.env.BRIDGE_CONFIG ?? path.join(root, "config", "bridge.local.json");
const config = await loadConfig(configFile);
let resolveRecordTitle = null;
const store = new JsonStateStore(config.stateFile);
const bridge = createBridge({
  config,
  store,
  taskboard: new TaskboardClient(config.taskboardUrl),
  resolveRecordTitle: (...args) => resolveRecordTitle?.(...args),
});
const compensationWorker = createCompensationWorker({
  bridge,
  pollIntervalMs: config.delivery.pollIntervalMs,
  logger: console,
});
let feishuListener = null;
const app = createBridgeServer({
  host: config.host,
  port: config.port,
  configSummary: {
    tables: config.tables.map(({
      baseToken,
      tableId,
      name,
      mode,
      triggerField,
      triggerFieldId,
      triggerValue,
      titleField,
      titleFieldId,
      fallbackTitleField,
      fallbackTitleFieldId,
      packageField,
      packageFieldId,
      defaultPackageAlias,
    }) => (
      {
        baseToken,
        tableId,
        name,
        mode,
        triggerField,
        triggerFieldId,
        triggerValue,
        titleField,
        titleFieldId,
        fallbackTitleField,
        fallbackTitleFieldId,
        packageField,
        packageFieldId,
        defaultPackageAlias,
      }
    )),
    packages: Object.keys(config.packages),
  },
  handleEvent: (event) => bridge.handle(event),
  getHealth: async () => ({
    ok: true,
    feishuListener: feishuListener?.health ?? {
      state: "disabled",
      lastEventAt: null,
      lastError: null,
    },
    queue: await bridge.getQueueStats(),
  }),
});
const address = await app.listen();
console.log(`Feishu bridge listening on http://127.0.0.1:${address.port}`);
compensationWorker.start();

const listenerEnabled = ["1", "true", "yes", "on"].includes(
  String(process.env.FEISHU_LISTENER_ENABLED ?? "").trim().toLowerCase(),
);
if (listenerEnabled) {
  try {
    const sdk = await loadFeishuSdk();
    const apiClient = new sdk.Client({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
    });
    resolveRecordTitle = createFeishuRecordTitleResolver({ client: apiClient, logger: console });
    feishuListener = createFeishuWsListener({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tables: config.tables,
      handleEvent: (event) => bridge.handle(event),
      sdk,
      logger: console,
      onStatus: (status, detail) => {
        if (status === "error" && detail?.code) {
          console.error(`Feishu listener error: ${detail.code}`);
        }
      },
    });
    void feishuListener.start().then(() => {
      console.log("Feishu WebSocket listener started");
    }).catch(() => {
      console.error("Feishu WebSocket listener failed: FEISHU_LISTENER_START_FAILED");
    });
  } catch (error) {
    await compensationWorker.stop();
    await app.close();
    throw error;
  }
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await compensationWorker.stop();
  await feishuListener?.stop();
  await app.close();
}
process.once("SIGINT", () => close().then(() => process.exit(0)));
process.once("SIGTERM", () => close().then(() => process.exit(0)));
