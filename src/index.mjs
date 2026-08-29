import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { loadPackageRegistry } from "./package-config.mjs";
import { createBridge } from "./bridge.mjs";
import { createBridgeServer } from "./server.mjs";
import { createCompensationWorker } from "./compensation-worker.mjs";
import { JsonStateStore } from "./state-store.mjs";
import { TaskboardClient } from "./taskboard-client.mjs";
import { createFeishuWsListener } from "./feishu-ws.mjs";
import { createFeishuRecordTitleResolver } from "./feishu-record-reader.mjs";
import { createFeishuApiContext } from "./feishu-api.mjs";
import { createWorkflowConfigStore } from "./workflow-config-store.mjs";
import { createWorkflowRuntime } from "./workflow-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(process.env.BRIDGE_ENV_FILE ?? path.join(root, ".env.local"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const configFile = process.env.BRIDGE_CONFIG ?? path.join(root, "config", "bridge.local.json");
const config = await loadConfig(configFile);
const packageRegistryFile = process.env.CODEX_FEISHU_PACKAGES_PATH
  ?? path.join(root, "config", "taskboard-feishu-packages.json");
const packageCatalog = await loadPackageRegistry(packageRegistryFile);
const listenerEnabled = ["1", "true", "yes", "on"].includes(
  String(process.env.FEISHU_LISTENER_ENABLED ?? "").trim().toLowerCase(),
);
const feishuApi = await createFeishuApiContext({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  listenerEnabled,
});
const feishuMetadataReader = feishuApi.metadataReader;
const resolveRecordTitle = listenerEnabled
  ? createFeishuRecordTitleResolver({ client: feishuApi.client, logger: console })
  : null;
const workflowStore = createWorkflowConfigStore({
  filename: process.env.BRIDGE_WORKFLOW_CONFIG
    ?? path.join(root, ".runtime", "bridge", "workflow.json"),
  initial: { schemaVersion: 1, configVersion: 1, bases: [] },
  packageAliases: () => loadPackageRegistry(packageRegistryFile),
  metadataReader: feishuMetadataReader,
});
const workflowRuntime = createWorkflowRuntime({
  config,
  store: workflowStore,
  metadataReader: feishuMetadataReader,
});
const store = new JsonStateStore(config.stateFile);
const bridge = createBridge({
  config,
  packageCatalog,
  getPackageCatalog: () => loadPackageRegistry(packageRegistryFile),
  getConfig: workflowRuntime.getConfig,
  store,
  taskboard: new TaskboardClient(config.taskboardUrl, {
    bridgeSecret: process.env.CODEX_FEISHU_BRIDGE_SECRET,
  }),
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
    packages: Object.keys(packageCatalog),
  },
  handleEvent: (event) => bridge.handle(event),
  workflowStore: workflowRuntime,
  baseMetadataReader: feishuMetadataReader,
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

if (listenerEnabled) {
  try {
    feishuListener = createFeishuWsListener({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tables: config.tables,
      getTables: workflowRuntime.getTables,
      handleEvent: (event) => bridge.handle(event),
      sdk: feishuApi.sdk,
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
