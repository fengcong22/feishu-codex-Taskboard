import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { withStateLock } from "./state-lock.mjs";
import {
  activeTables as getActiveTables,
  portableSubject,
  subjectKey,
  validateWorkflowConfig,
} from "./workflow-config.mjs";
import {
  comparePhasedSubjectMetadata,
  compareSubjectMetadata,
} from "./feishu-base-metadata.mjs";
import { SubjectVersionHistory } from "./subject-version-history.mjs";

function clone(value) {
  return structuredClone(value);
}

function nowValue(now) {
  const value = typeof now === "function" ? now() : now;
  if (!Number.isFinite(value)) throw new Error("workflow config clock must return a finite timestamp");
  return value;
}

function pathFor(filename) {
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new Error("workflow config filename must be a non-empty string");
  }
  return path.resolve(filename);
}

function findSubject(config, key) {
  if (typeof key !== "string" || key.trim() === "") throw new Error("subjectKey must be a non-empty string");
  for (const base of config.bases) {
    const subject = base.subjects.find((entry) => entry.subjectKey === key);
    if (subject) return { base, subject };
  }
  const error = new Error(`unknown subjectKey: ${key}`);
  error.code = "WORKFLOW_SUBJECT_NOT_FOUND";
  throw error;
}

function assertExpectedVersion(subject, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) return;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || expectedVersion !== subject.configVersion) {
    throw versionMismatch(expectedVersion, subject.configVersion);
  }
}

function versionMismatch(expectedVersion, actualVersion) {
  const error = new Error("workflow subject version mismatch");
  error.code = "WORKFLOW_CONFIG_VERSION_MISMATCH";
  error.status = 409;
  Object.defineProperties(error, {
    expectedVersion: { value: expectedVersion, enumerable: false },
    actualVersion: { value: actualVersion, enumerable: false },
  });
  return error;
}

function assertSyncVersion(input, expectedVersion, currentSubject) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw versionMismatch(expectedVersion, currentSubject?.configVersion ?? null);
  }
  const incomingVersion = input?.configVersion;
  if (!Number.isSafeInteger(incomingVersion) || incomingVersion !== expectedVersion + 1) {
    throw versionMismatch(expectedVersion, currentSubject?.configVersion ?? null);
  }
  // Draft edits stay local to Taskboard until its next enable/disable
  // transition. Bridge can therefore legitimately be behind the
  // Taskboard's expected version. An exact incoming-version match is checked
  // separately as a possible idempotent replay.
  if (currentSubject && currentSubject.configVersion > incomingVersion) {
    throw versionMismatch(expectedVersion, currentSubject.configVersion);
  }
  return incomingVersion;
}

function sameSyncedSubject(currentSubject, candidate) {
  const comparable = clone(candidate);
  // updatedAt is assigned by Bridge and is not part of Taskboard's sync
  // payload. Preserve the persisted value when comparing a replay.
  comparable.updatedAt = currentSubject.updatedAt;
  return isDeepStrictEqual(comparable, currentSubject);
}

function versionConflict() {
  const error = new Error("SUBJECT_VERSION_CONFLICT");
  error.code = "SUBJECT_VERSION_CONFLICT";
  return error;
}

function withoutHistoryInterval(subject) {
  const result = clone(subject);
  delete result.enabledAt;
  delete result.closedAt;
  return result;
}

function mergePatch(current, patch, fieldName = "patch") {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const result = clone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)
      && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = mergePatch(result[key], value, `${fieldName}.${key}`);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function subjectWithoutRuntime(subject, { forceDraft = false } = {}) {
  const result = clone(subject);
  delete result.activeSnapshot;
  delete result.courseNamingField;
  if (forceDraft) result.lifecycle = "draft";
  result.upload.artifactSourcePath = null;
  result.upload.targetPath = null;
  if (result.delivery) result.delivery.rootPath = null;
  return result;
}

function shareableConfig(config) {
  const result = clone(config);
  result.bases = result.bases.map((base) => ({
    ...base,
    // A pasted URL can contain user info or query credentials.  The stable
    // Base token is sufficient to reconnect a shared configuration.
    sourceUrlLabel: null,
    subjects: base.subjects.map((subject) => subjectWithoutRuntime(subject)),
  }));
  return result;
}

function forceDrafts(config) {
  const result = clone(config);
  result.bases = result.bases.map((base) => ({
    ...base,
    sourceUrlLabel: null,
    subjects: base.subjects.map((subject) => {
      const draft = subjectWithoutRuntime(subject, { forceDraft: true });
      draft.configVersion = 1;
      draft.createdAt = null;
      draft.updatedAt = null;
      return draft;
    }),
  }));
  return result;
}

function mergeImported(current, imported) {
  const result = clone(current);
  const baseByToken = new Map(result.bases.map((base, index) => [base.baseToken, index]));
  for (const importedBase of imported.bases) {
    const existingIndex = baseByToken.get(importedBase.baseToken);
    if (existingIndex === undefined) {
      result.bases.push(clone(importedBase));
      baseByToken.set(importedBase.baseToken, result.bases.length - 1);
      continue;
    }
    const existingBase = result.bases[existingIndex];
    const byKey = new Map(existingBase.subjects.map((subject, index) => [subject.subjectKey, index]));
    for (const importedSubject of importedBase.subjects) {
      const subjectIndex = byKey.get(importedSubject.subjectKey);
      if (subjectIndex === undefined) {
        existingBase.subjects.push(clone(importedSubject));
        byKey.set(importedSubject.subjectKey, existingBase.subjects.length - 1);
      } else {
        const currentSubject = existingBase.subjects[subjectIndex];
        const nextSubject = clone(importedSubject);
        // Import is draft-only.  Never make an already-enabled local subject
        // stop listening just because a shared file was imported over it.
        const active = currentSubject.lifecycle === "enabled"
          ? currentSubject
          : currentSubject.activeSnapshot;
        if (active) nextSubject.activeSnapshot = clone(active);
        // Paths are machine-local bindings.  A share file intentionally has
        // nulls here; retain an existing local binding when importing into the
        // same machine instead of silently unbinding it.
        if (nextSubject.upload.artifactSourcePath === null) {
          nextSubject.upload.artifactSourcePath = currentSubject.upload.artifactSourcePath ?? null;
        }
        if (nextSubject.upload.targetPath === null) {
          nextSubject.upload.targetPath = currentSubject.upload.targetPath ?? null;
        }
        if (nextSubject.delivery?.rootPath === null && currentSubject.delivery?.rootPath) {
          nextSubject.delivery.rootPath = currentSubject.delivery.rootPath;
        }
        nextSubject.configVersion = currentSubject.configVersion + 1;
        nextSubject.updatedAt = null;
        existingBase.subjects[subjectIndex] = nextSubject;
      }
    }
    existingBase.baseName = importedBase.baseName;
    existingBase.sourceUrlLabel = importedBase.sourceUrlLabel;
    existingBase.metadataRefreshedAt = importedBase.metadataRefreshedAt;
  }
  return result;
}

function packageCatalog(value) {
  if (value === undefined || value === null) {
    return { aliases: null, bindings: null };
  }
  if (value instanceof Set || Array.isArray(value)) {
    return { aliases: new Set(value), bindings: null };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return { aliases: new Set(entries.map(([alias]) => alias)), bindings: new Map(entries) };
  }
  return { aliases: new Set([value]), bindings: null };
}

function hasAbsoluteWorkspaceBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const value = binding.workspacePath;
  if (typeof value !== "string" || value.trim() === "") return false;
  const normalized = value.trim();
  return path.isAbsolute(normalized)
    || /^[A-Za-z]:[\\/]/u.test(normalized)
    || /^\\\\/u.test(normalized);
}

function baseDiagnosticPath(base) {
  return `bases.${base.baseToken}`;
}

function subjectDiagnosticPath(subject) {
  return `${baseDiagnosticPath(subject)}.subjects.${subject.tableId}`;
}

function diagnostic(code, severity, pathValue, message, extra = {}) {
  return { code, severity, path: pathValue, ...extra, message };
}

function missingBaseError(error) {
  return ["BASE_NOT_FOUND", "FEISHU_BASE_NOT_FOUND"].includes(error?.code);
}

async function remoteMetadataDiagnostics(configuration, metadataReader) {
  const diagnostics = [];
  for (const base of configuration.bases) {
    const basePath = baseDiagnosticPath(base);
    if (!metadataReader || typeof metadataReader.preview !== "function") {
      diagnostics.push(diagnostic(
        "FEISHU_METADATA_UNAVAILABLE",
        "error",
        basePath,
        "Configure Feishu credentials and retry metadata validation before enabling this Base",
      ));
      continue;
    }
    let preview;
    try {
      preview = await metadataReader.preview({ baseToken: base.baseToken });
    } catch (error) {
      diagnostics.push(missingBaseError(error)
        ? diagnostic(
          "BASE_NOT_FOUND",
          "error",
          basePath,
          "The configured Base is not available in Feishu",
        )
        : diagnostic(
          "FEISHU_METADATA_UNAVAILABLE",
          "error",
          basePath,
          "Unable to verify this Base; check Feishu credentials and access, then retry",
        ));
      continue;
    }
    if (!preview || typeof preview !== "object" || Array.isArray(preview)
      || preview.baseToken !== base.baseToken || !Array.isArray(preview.tables)) {
      diagnostics.push(diagnostic(
        "FEISHU_METADATA_UNAVAILABLE",
        "error",
        basePath,
        "Feishu returned unusable metadata for this Base; refresh it before enabling",
      ));
      continue;
    }
    if (preview.baseName !== base.baseName) {
      diagnostics.push(diagnostic(
        "BASE_NAME_MISMATCH",
        "error",
        basePath,
        "The configured Base name no longer matches Feishu metadata",
      ));
    }
    const seen = new Set();
    for (const subject of base.subjects) {
      const issues = subject?.statusField && subject?.stages
        ? comparePhasedSubjectMetadata(subject, preview)
        : compareSubjectMetadata(subject, preview);
      for (const issue of issues) {
        if (issue.code === "BASE_NAME_MISMATCH") continue;
        const key = `${issue.code}:${issue.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push(diagnostic(
          issue.code,
          "error",
          issue.path,
          issue.message,
        ));
      }
    }
  }
  return diagnostics;
}

function localBindingDiagnostics(configuration, current, packages) {
  const diagnostics = [];
  const currentSubjects = new Map(current.bases
    .flatMap((base) => base.subjects)
    .map((subject) => [subject.subjectKey, subject]));
  for (const base of configuration.bases) {
    for (const subject of base.subjects) {
      const subjectPath = subjectDiagnosticPath(subject);
      const aliases = new Set([
        subject.packageRoute.packageAlias,
        ...Object.values(subject.packageRoute.branchMap ?? {}),
      ]);
      if (packages.aliases) {
        for (const alias of aliases) {
          if (!packages.aliases.has(alias)) {
            diagnostics.push(diagnostic(
              "PACKAGE_ALIAS_UNAVAILABLE",
              "error",
              `${subjectPath}.packageRoute`,
              "The Auto-Cut package alias is not configured on this machine",
              { alias },
            ));
          } else if (packages.bindings && !hasAbsoluteWorkspaceBinding(packages.bindings.get(alias))) {
            diagnostics.push(diagnostic(
              "PACKAGE_WORKSPACE_PATH_UNBOUND",
              "error",
              `${subjectPath}.packageRoute`,
              "Bind this Auto-Cut package alias to an absolute local workspace before enabling",
              { alias },
            ));
          }
        }
      }
      const local = currentSubjects.get(subject.subjectKey);
      const sourcePath = local?.upload?.artifactSourcePath ?? null;
      const targetPath = local?.upload?.targetPath ?? null;
      if (["watch_directory", "driver_report"].includes(subject.upload.artifactSourceMode) && !sourcePath) {
        diagnostics.push(diagnostic(
          "ARTIFACT_SOURCE_PATH_UNBOUND",
          "warning",
          `${subjectPath}.upload.artifactSourcePath`,
          "Bind a ZIP artifact source path on this machine before artifact discovery can run",
        ));
      }
      if (subject.upload.targetId && !targetPath) {
        diagnostics.push(diagnostic(
          "UPLOAD_TARGET_PATH_UNBOUND",
          "warning",
          `${subjectPath}.upload.targetPath`,
          "Bind an upload target path on this machine before upload can run",
        ));
      }
    }
  }
  return diagnostics;
}

async function shareImportDiagnostics(configuration, current, { metadataReader, packages }) {
  return [
    ...await remoteMetadataDiagnostics(configuration, metadataReader),
    ...localBindingDiagnostics(configuration, current, packages),
  ];
}

function shareImportResult(configuration, diagnostics) {
  const shared = shareableConfig(configuration);
  return {
    ...shared,
    configuration: shared,
    diagnostics,
    diagnosticsOk: diagnostics.every((entry) => entry.severity !== "error"),
  };
}

async function readDocument(filename, initial) {
  try {
    return validateWorkflowConfig(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return validateWorkflowConfig(initial ?? { schemaVersion: 1, configVersion: 1, bases: [] });
  }
}

async function writeAtomic(filename, document) {
  await mkdir(path.dirname(filename), { recursive: true });
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  let temporary = null;
  let handle = null;
  for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
    temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      handle = await open(temporary, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 2) throw error;
    }
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw new Error("WORKFLOW_TEMP_UNSUPPORTED: temporary file is not single-link regular file");
    await handle.writeFile(serialized, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) throw new Error("WORKFLOW_TEMP_UNSUPPORTED: temporary file changed while writing");
    await handle.close();
    handle = null;
    const target = await lstat(temporary);
    if (!target.isFile() || target.nlink !== 1) throw new Error("WORKFLOW_TEMP_UNSUPPORTED: temporary path is not a regular file");
    await rename(temporary, filename);
    temporary = null;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function restoreDocument(filename, document, existed) {
  if (existed) {
    await writeAtomic(filename, document);
    return;
  }
  await unlink(filename).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function readMutationJournal(filename) {
  let details;
  try {
    details = await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.nlink !== 1) {
    throw new Error("WORKFLOW_TRANSACTION_UNSUPPORTED: recovery journal must be a single-link regular file");
  }
  const value = JSON.parse(await readFile(filename, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== 1
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)
    || typeof value.config.exists !== "boolean"
    || !value.history || typeof value.history !== "object" || Array.isArray(value.history)) {
    throw new Error("WORKFLOW_TRANSACTION_INVALID: recovery journal is malformed");
  }
  return {
    schemaVersion: 1,
    config: {
      exists: value.config.exists,
      document: validateWorkflowConfig(value.config.document),
    },
    history: value.history,
  };
}

/**
 * Local, versioned catalog store.  All mutations are serialized in-process and
 * guarded by the same loopback state lock used by the Bridge state store.
 */
export function createWorkflowConfigStore({
  filename,
  initial,
  now = () => Date.now(),
  packageAliases = null,
  metadataReader = null,
} = {}) {
  const target = pathFor(filename);
  const history = new SubjectVersionHistory(`${target}.versions.json`, { now });
  const transactionTarget = `${target}.transaction.json`;
  const validatedInitial = validateWorkflowConfig(initial ?? { schemaVersion: 1, configVersion: 1, bases: [] });
  const packageAliasesLoader = typeof packageAliases === "function" ? packageAliases : null;
  const packages = packageCatalog(packageAliasesLoader ? null : packageAliases);
  let writeQueue = Promise.resolve();

  async function currentPackageCatalog() {
    if (!packageAliasesLoader) return packages;
    return packageCatalog(await packageAliasesLoader());
  }

  async function recoverMutation() {
    const journal = await readMutationJournal(transactionTarget);
    if (!journal) return;
    const restored = await Promise.allSettled([
      restoreDocument(target, journal.config.document, journal.config.exists),
      history.restoreState(journal.history),
    ]);
    const failures = restored
      .filter((entry) => entry.status === "rejected")
      .map((entry) => entry.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "workflow config recovery could not restore the previous pair");
    }
    await unlink(transactionTarget);
  }

  async function withDocument(operation) {
    let result;
    writeQueue = writeQueue.catch(() => {}).then(async () => withStateLock(target, async () => {
      await recoverMutation();
      const current = await readDocument(target, validatedInitial);
      result = await operation(current);
      return result;
    }));
    await writeQueue;
    return clone(result);
  }

  async function mutate(operation) {
    return withDocument(async (current) => {
      const before = clone(current);
      const result = await operation(current);
      if (result?.persist === false) {
        if (typeof result.afterMutation === "function") await result.afterMutation();
        return result.value;
      }
      const changed = result?.config ?? current;
      const timestamp = nowValue(now);
      changed.updatedAt = timestamp;
      // configVersion is local monotonic revision, not a value imported from
      // another machine's share file.
      changed.configVersion = before.configVersion + 1;
      const persistedBefore = await store.hasPersistedConfig();
      const previousHistory = typeof result?.afterMutation === "function"
        ? await history.captureState()
        : null;
      if (previousHistory !== null) {
        await writeAtomic(transactionTarget, {
          schemaVersion: 1,
          config: { exists: persistedBefore, document: before },
          history: previousHistory,
        });
      }
      try {
        await writeAtomic(target, changed);
        if (typeof result?.afterMutation === "function") await result.afterMutation();
        if (previousHistory !== null) await unlink(transactionTarget);
      } catch (error) {
        if (previousHistory === null) throw error;
        try {
          await recoverMutation();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "workflow config mutation failed and rollback could not restore the previous pair",
          );
        }
        throw error;
      }
      return result?.value ?? changed;
    });
  }

  async function syncHistorySubject(subject, { transitionAt } = {}) {
    const portable = portableSubject(subject);
    const existing = await history.getSubjectVersion(portable.subjectKey, portable.configVersion);
    if (existing) {
      if (!isDeepStrictEqual(withoutHistoryInterval(existing), withoutHistoryInterval(portable))) {
        throw versionConflict();
      }
      return existing;
    }
    return history.syncSubject({
      ...portable,
      // A pre-existing workflow.json without a sidecar cannot prove when its
      // current version became active.  An idempotent replay therefore starts
      // the interval now instead of backdating delayed events into it.
      enabledAt: transitionAt ?? nowValue(now),
      closedAt: null,
    });
  }

  async function assertPackageAlias(alias) {
    const current = await currentPackageCatalog();
    if (!current.aliases) return;
    if (!current.aliases.has(alias)) {
      const error = new Error(`package alias is not configured locally: ${alias}`);
      error.code = "WORKFLOW_PACKAGE_ALIAS_UNBOUND";
      throw error;
    }
  }

  function normalizedSyncedSubject(input, lifecycle, currentSubject = null, configVersion) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("workflow subject must be an object");
    }
    if (!["enabled", "disabled"].includes(lifecycle)) {
      throw new Error("workflow subject lifecycle must be enabled or disabled");
    }
    const baseToken = input.baseToken ?? currentSubject?.baseToken;
    const tableId = input.tableId ?? currentSubject?.tableId;
    const key = subjectKey(baseToken, tableId);
    if (input.subjectKey !== undefined && input.subjectKey !== key) {
      throw new Error("workflow subject identity does not match subjectKey");
    }
    const current = currentSubject ? clone(currentSubject) : {};
    const next = {
      ...current,
      subjectKey: key,
      baseToken: key.slice(0, key.indexOf(":")),
      tableId: key.slice(key.indexOf(":") + 1),
      baseName: input.baseName ?? current.baseName,
      tableName: input.tableName ?? current.tableName,
      displayEnabled: input.displayEnabled ?? current.displayEnabled ?? true,
      lifecycle,
      configVersion,
      createdAt: input.createdAt ?? current.createdAt ?? nowValue(now),
      updatedAt: nowValue(now),
      trigger: input.trigger ?? current.trigger,
      title: input.title ?? current.title ?? { fieldId: null, fieldName: null },
      execution: input.execution ?? current.execution,
      packageRoute: input.packageRoute ?? current.packageRoute,
      statusField: input.statusField ?? current.statusField,
      documentField: input.documentField ?? current.documentField,
      namingField: input.namingField ?? current.namingField,
      stages: input.stages ?? current.stages,
      upload: {
        ...(current.upload ?? {}),
        ...(input.upload ?? {}),
        artifactSourcePath: null,
        targetPath: null,
      },
    };
    if (input.delivery !== undefined || current.delivery !== undefined) {
      next.delivery = clone(input.delivery ?? current.delivery);
    }
    for (const field of ["statusField", "documentField", "namingField", "stages"]) {
      if (next[field] === undefined) delete next[field];
    }
    delete next.activeSnapshot;
    return next;
  }

  const store = {
    async hasPersistedConfig() {
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.nlink !== 1) {
          const error = new Error("workflow config file must be a single-link regular file");
          error.code = "WORKFLOW_CONFIG_FILE_UNSUPPORTED";
          throw error;
        }
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },

    async read() {
      return withDocument(async (current) => current);
    },

    async preview(value) {
      if (value === undefined) return store.read();
      return validateWorkflowConfig(value);
    },

    async activeTables() {
      return getActiveTables(await store.read());
    },

    async saveDraft(key, patch, options = {}) {
      return mutate(async (current) => {
      const { base, subject } = findSubject(current, key);
      assertExpectedVersion(subject, options.expectedVersion);
      const draftPatch = mergePatch(subject, patch, "patch");
        if (draftPatch.baseToken !== subject.baseToken || draftPatch.tableId !== subject.tableId) {
          const error = new Error("subject identity cannot be changed in a draft patch");
          error.code = "WORKFLOW_SUBJECT_IDENTITY_IMMUTABLE";
          throw error;
        }
        // If a live version exists, retain it as an immutable snapshot while
        // editing a new draft.  A draft with no live version has no snapshot.
        const active = subject.lifecycle === "enabled"
          ? clone(subject)
          : subject.activeSnapshot ? clone(subject.activeSnapshot) : null;
        draftPatch.lifecycle = "draft";
        draftPatch.configVersion = subject.configVersion + 1;
        draftPatch.updatedAt = nowValue(now);
        if (active) draftPatch.activeSnapshot = active;
        const normalized = validateWorkflowConfig({
          ...current,
          bases: current.bases.map((entry) => entry === base
            ? { ...entry, subjects: entry.subjects.map((entrySubject) => entrySubject === subject ? draftPatch : entrySubject) }
            : entry),
        });
        return { config: normalized, value: findSubject(normalized, key).subject };
      });
    },

    async enable(key, options = {}) {
      return mutate(async (current) => {
        const { base, subject } = findSubject(current, key);
        assertExpectedVersion(subject, options.expectedVersion);
        await assertPackageAlias(subject.packageRoute.packageAlias);
        const next = clone(subject.activeSnapshot ?? subject);
        // Enabling always uses the current draft fields, not the old snapshot.
        Object.assign(next, clone(subject), { lifecycle: "enabled", activeSnapshot: undefined });
        delete next.activeSnapshot;
        next.configVersion = subject.configVersion + 1;
        next.updatedAt = nowValue(now);
        const normalized = validateWorkflowConfig({
          ...current,
          bases: current.bases.map((entry) => entry === base
            ? { ...entry, subjects: entry.subjects.map((entrySubject) => entrySubject === subject ? next : entrySubject) }
            : entry),
        });
        const value = findSubject(normalized, key).subject;
        return {
          config: normalized,
          value,
          afterMutation: () => syncHistorySubject(value, { transitionAt: next.updatedAt }),
        };
      });
    },

    async disable(key, options = {}) {
      return mutate(async (current) => {
        const { base, subject } = findSubject(current, key);
        assertExpectedVersion(subject, options.expectedVersion);
        const next = clone(subject);
        next.lifecycle = "disabled";
        delete next.activeSnapshot;
        next.configVersion = subject.configVersion + 1;
        next.updatedAt = nowValue(now);
        const normalized = validateWorkflowConfig({
          ...current,
          bases: current.bases.map((entry) => entry === base
            ? { ...entry, subjects: entry.subjects.map((entrySubject) => entrySubject === subject ? next : entrySubject) }
            : entry),
        });
        const value = findSubject(normalized, key).subject;
        return {
          config: normalized,
          value,
          afterMutation: () => syncHistorySubject(value, { transitionAt: next.updatedAt }),
        };
      });
    },

    async syncSubject(input, { lifecycle, expectedVersion } = {}) {
      return mutate(async (current) => {
        const baseToken = input?.baseToken;
        const tableId = input?.tableId;
        const key = subjectKey(baseToken, tableId);
        let existingBase = current.bases.find((base) => base.baseToken === baseToken);
        let existingSubject = existingBase?.subjects.find((subject) => subject.subjectKey === key) ?? null;
        const configVersion = assertSyncVersion(input, expectedVersion, existingSubject);
        const nextSubject = normalizedSyncedSubject(input, lifecycle, existingSubject, configVersion);
        if (existingSubject?.configVersion === configVersion) {
          if (sameSyncedSubject(existingSubject, nextSubject)) {
            return {
              persist: false,
              value: existingSubject,
              afterMutation: () => syncHistorySubject(existingSubject),
            };
          }
          throw versionMismatch(expectedVersion, existingSubject.configVersion);
        }
        if (lifecycle === "enabled") await assertPackageAlias(nextSubject.packageRoute?.packageAlias);
        const nextBase = existingBase
          ? {
            ...existingBase,
            baseName: nextSubject.baseName,
            subjects: existingBase.subjects.map((subject) => subject.subjectKey === key ? nextSubject : subject),
          }
          : {
            baseToken: nextSubject.baseToken,
            baseName: nextSubject.baseName,
            sourceUrlLabel: null,
            metadataRefreshedAt: null,
            subjects: [nextSubject],
          };
        if (!existingBase) {
          current.bases.push(nextBase);
        } else if (!existingSubject) {
          existingBase.subjects.push(nextSubject);
        } else {
          current.bases = current.bases.map((base) => base.baseToken === baseToken ? nextBase : base);
        }
        const normalized = validateWorkflowConfig(current);
        const value = findSubject(normalized, key).subject;
        return {
          config: normalized,
          value,
          afterMutation: () => syncHistorySubject(value, { transitionAt: nextSubject.updatedAt }),
        };
      });
    },

    async getSubjectVersion(key, configVersion) {
      return history.getSubjectVersion(key, configVersion);
    },

    async resolveSubjectVersionAt(key, occurredAt, options = {}) {
      return history.resolveSubjectVersionAt(key, occurredAt, options);
    },

    async exportShareable() {
      const current = await store.read();
      return shareableConfig(current);
    },

    async importShareable(value, options = {}) {
      const imported = forceDrafts(validateWorkflowConfig(value));
      const current = await store.read();
      const diagnostics = await shareImportDiagnostics(imported, current, {
        metadataReader,
        packages: await currentPackageCatalog(),
      });
      if (options.dryRun) return shareImportResult(imported, diagnostics);
      const merged = await mutate(async (currentDocument) => {
        const next = validateWorkflowConfig(mergeImported(currentDocument, imported));
        return { config: next, value: next };
      });
      return shareImportResult(merged, diagnostics);
    },

    history,
  };
  return store;
}

export const __internal = Object.freeze({
  shareableConfig,
  forceDrafts,
  mergeImported,
  remoteMetadataDiagnostics,
  localBindingDiagnostics,
  shareImportDiagnostics,
});
