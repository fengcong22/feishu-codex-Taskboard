import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { createBridge } from "./bridge.mjs";
import { createBridgeServer } from "./server.mjs";
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
const bridge = createBridge({
  config,
  store: new JsonStateStore(config.stateFile),
  taskboard: new TaskboardClient(config.taskboardUrl),
  resolveRecordTitle: (...args) => resolveRecordTitle?.(...args),
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
  getHealth: () => ({
    ok: true,
    feishuListener: feishuListener?.state ?? "disabled",
  }),
});
const address = await app.listen();
console.log(`Feishu bridge listening on http://127.0.0.1:${address.port}`);

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
      onStatus: (status, error) => {
        if (status === "error" && error) console.error(`Feishu listener error: ${error.message}`);
      },
    });
    void feishuListener.start().then(() => {
      console.log("Feishu WebSocket listener started");
    }).catch((error) => {
      console.error(`Feishu WebSocket listener failed: ${error.message}`);
    });
  } catch (error) {
    await app.close();
    throw error;
  }
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await feishuListener?.stop();
  await app.close();
}
process.once("SIGINT", () => close().then(() => process.exit(0)));
process.once("SIGTERM", () => close().then(() => process.exit(0)));
