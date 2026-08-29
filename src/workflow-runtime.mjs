import { configuredTables } from "./decide-event.mjs";

function metadataUnavailable() {
  const error = new Error("Feishu metadata validation is unavailable");
  error.code = "FEISHU_METADATA_UNAVAILABLE";
  error.status = 503;
  return error;
}

function subjectNotFound() {
  const error = new Error("workflow subject was not found");
  error.code = "WORKFLOW_SUBJECT_NOT_FOUND";
  error.status = 404;
  return error;
}

/**
 * Combine the legacy process configuration with the versioned local workflow
 * catalog.  An empty catalog is treated as "not configured yet" so existing
 * installations keep their legacy allow-list until the first Base is added.
 */
export function createWorkflowRuntime({ config, store, metadataReader = null } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("workflow runtime requires a config object");
  }
  if (!store || typeof store.read !== "function") {
    throw new Error("workflow runtime requires a workflow config store");
  }

  async function getConfig() {
    const workflow = await store.read();
    const hasPersistedConfig = typeof store.hasPersistedConfig === "function"
      ? await store.hasPersistedConfig()
      : Boolean(workflow && Array.isArray(workflow.bases) && workflow.bases.length > 0);
    if (!hasPersistedConfig && (!workflow || !Array.isArray(workflow.bases) || workflow.bases.length === 0)) {
      return config;
    }
    return { ...config, workflow };
  }

  async function getTables() {
    return configuredTables(await getConfig());
  }

  async function syncSubject(subject, options = {}) {
    if (options.lifecycle === "enabled") {
      if (typeof metadataReader?.validateSubject !== "function") {
        throw metadataUnavailable();
      }
      await metadataReader.validateSubject(subject);
    }
    return store.syncSubject(subject, options);
  }

  async function currentSubject(key) {
    const workflow = await store.read();
    for (const base of workflow?.bases ?? []) {
      const subject = base.subjects?.find((entry) => entry.subjectKey === key);
      if (subject) return subject;
    }
    throw subjectNotFound();
  }

  async function enable(key, options = {}) {
    if (typeof metadataReader?.validateSubject !== "function") {
      throw metadataUnavailable();
    }
    const subject = await currentSubject(key);
    await metadataReader.validateSubject(subject);
    const nextOptions = { ...options };
    // Bind the metadata check to the exact draft that was inspected.  A caller
    // may still provide an explicit expectedVersion for an intentional CAS.
    if (nextOptions.expectedVersion === undefined && Number.isInteger(subject.configVersion)) {
      nextOptions.expectedVersion = subject.configVersion;
    }
    return store.enable(key, nextOptions);
  }

  async function disable(key, options = {}) {
    // Disabling is an emergency/local lifecycle action.  It must remain
    // possible after a package is removed and without a live Feishu client.
    return store.disable(key, options);
  }

  return Object.freeze({ ...store, getConfig, getTables, syncSubject, enable, disable });
}
