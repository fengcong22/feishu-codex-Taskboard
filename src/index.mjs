import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { loadPackageRegistry } from "./package-config.mjs";
import { createBridge } from "./bridge.mjs";
import { createBridgeServer } from "./server.mjs";
import { createCompensationWorker } from "./compensation-worker.mjs";
import { JsonStateStore } from "./state-store.mjs";
import { TaskboardClient } from "./taskboard-client.mjs";
import { createFeishuWsListener, loadFeishuSdk } from "./feishu-ws.mjs";
import { createFeishuBaseMetadataReader } from "./feishu-base-metadata.mjs";
import {
  createFeishuControlledContextReader,
  createFeishuNamingSearch,
  createFeishuRecordTitleResolver,
} from "./feishu-record-reader.mjs";
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
function envEnabled(name) {
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name] ?? "").trim().toLowerCase(),
  );
}
const listenerEnabled = envEnabled("FEISHU_LISTENER_ENABLED");
const apiEnabled = listenerEnabled || envEnabled("FEISHU_READ_ENABLED");
const sdk = apiEnabled ? await loadFeishuSdk() : null;
const feishuApi = apiEnabled
  ? await createFeishuApiContext({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    listenerEnabled,
    loadSdk: async () => sdk,
    createMetadataReader: createFeishuBaseMetadataReader,
  })
  : Object.freeze({ sdk: null, client: null, metadataReader: null });
const apiClient = feishuApi.client;
const metadataReader = feishuApi.metadataReader;
const resolveRecordTitle = apiClient
  ? createFeishuRecordTitleResolver({ client: apiClient, logger: console })
  : null;
const controlledContextReader = apiClient
  ? createFeishuControlledContextReader({
    client: apiClient,
    searchNaming: createFeishuNamingSearch({ client: apiClient }),
    logger: console,
  })
  : null;
const workflowStore = createWorkflowConfigStore({
  filename: process.env.BRIDGE_WORKFLOW_CONFIG
    ?? path.join(root, ".runtime", "bridge", "workflow.json"),
  initial: { schemaVersion: 1, configVersion: 1, bases: [] },
  packageAliases: () => loadPackageRegistry(packageRegistryFile),
  metadataReader,
});
const workflowRuntime = createWorkflowRuntime({
  config,
  store: workflowStore,
  metadataReader,
});
const store = new JsonStateStore(config.stateFile);
const taskboard = new TaskboardClient(config.taskboardUrl, {
  bridgeSecret: process.env.CODEX_FEISHU_BRIDGE_SECRET,
});
const bridge = createBridge({
  config,
  packageCatalog,
  getPackageCatalog: () => loadPackageRegistry(packageRegistryFile),
  getConfig: workflowRuntime.getConfig,
  workflowStore,
  workflowRuntime,
  bridgeSecret: process.env.CODEX_FEISHU_BRIDGE_SECRET ?? null,
  readControlledContext: async (subject, identity) => {
    if (!controlledContextReader) {
      const error = new Error("Feishu controlled context reader is unavailable");
      error.code = "CONTROLLED_CONTEXT_UNAVAILABLE";
      error.status = 503;
      throw error;
    }
    return controlledContextReader.read(subject, identity);
  },
  store,
  taskboard,
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
  bridgeSecret: process.env.CODEX_FEISHU_BRIDGE_SECRET ?? null,
  metadataReader,
  workflowStore,
  getSubjectVersion: (subjectKey, configVersion) => (
    workflowRuntime.getSubjectVersion(subjectKey, configVersion)
  ),
  readControlledContext: async (subject, identity) => {
    if (!controlledContextReader) {
      const error = new Error("Feishu controlled context reader is unavailable");
      error.code = "CONTROLLED_CONTEXT_UNAVAILABLE";
      error.status = 503;
      throw error;
    }
    return controlledContextReader.read(subject, identity);
  },
  syncSubject: (subject, options) => workflowRuntime.syncSubject(subject, options),
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
  simulationEnabled: async () => listenerEnabled === false
    && (await taskboard.getAutomaticExecutionEnabled()) === false,
  workflowStore: workflowRuntime,
  baseMetadataReader: metadataReader,
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
