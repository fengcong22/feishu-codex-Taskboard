import { configuredTables } from "./decide-event.mjs";

function unavailable() {
  const error = new Error("Feishu metadata validation is unavailable");
  error.code = "FEISHU_METADATA_UNAVAILABLE";
  error.status = 503;
  return error;
}

export function createWorkflowRuntime({ config, store, metadataReader = null } = {}) {
  if (!config || typeof config !== "object") throw new Error("workflow runtime requires a config object");
  if (!store || typeof store.read !== "function") throw new Error("workflow runtime requires a workflow config store");
  async function getConfig() {
    const workflow = await store.read();
    const has = typeof store.hasPersistedConfig === "function"
      ? await store.hasPersistedConfig()
      : Boolean(workflow?.bases?.length);
    return !has && !workflow?.bases?.length ? config : { ...config, workflow };
  }
  async function getTables() { return configuredTables(await getConfig()); }
  async function syncSubject(subject, options = {}) {
    if (options.lifecycle === "enabled") {
      if (typeof metadataReader?.validateSubject !== "function") throw unavailable();
      await metadataReader.validateSubject(subject);
    }
    return store.syncSubject(subject, options);
  }
  return Object.freeze({
    ...store,
    getConfig,
    getTables,
    syncSubject,
    getSubjectVersion: store.getSubjectVersion?.bind(store),
    resolveSubjectVersionAt: store.resolveSubjectVersionAt?.bind(store),
  });
}
