import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { withStateLock } from "./state-lock.mjs";

const SCHEMA_VERSION = 1;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function key(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("subjectKey must be a non-empty string");
  return value.trim();
}

function versionNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("configVersion must be a positive integer");
  return value;
}

function timestamp(value, fallback = Date.now()) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(number)) throw new Error("version timestamps must be finite numbers");
  return number;
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, subjects: Object.create(null) };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SUBJECT_HISTORY_INVALID: history must be an object");
  }
  const state = emptyState();
  if (value.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("SUBJECT_HISTORY_INVALID: unsupported schema version");
  }
  if (value.subjects !== undefined && (!value.subjects || typeof value.subjects !== "object" || Array.isArray(value.subjects))) {
    throw new Error("SUBJECT_HISTORY_INVALID: subjects must be an object map");
  }
  for (const [subjectKey, raw] of Object.entries(value.subjects ?? {})) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.versions)) {
      throw new Error("SUBJECT_HISTORY_INVALID: subject history is malformed");
    }
    state.subjects[subjectKey] = {
      currentVersion: Number.isSafeInteger(raw.currentVersion) ? raw.currentVersion : null,
      current: clone(raw.current ?? null),
      versions: raw.versions.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("SUBJECT_HISTORY_INVALID: version is malformed");
        }
        return clone(entry);
      }),
    };
  }
  return state;
}

async function atomicWrite(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filename);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function subjectEntry(state, subjectKey) {
  return state.subjects[subjectKey] ?? {
    currentVersion: null,
    current: null,
    versions: [],
  };
}

function isEnabled(entry) {
  return entry?.lifecycle === "enabled";
}

export class SubjectVersionHistory {
  #filename;
  #writeQueue = Promise.resolve();

  constructor(filename, { now = () => Date.now() } = {}) {
    if (typeof filename !== "string" || filename.trim() === "") throw new Error("history filename is required");
    this.#filename = path.resolve(filename);
    this.now = now;
  }

  get filename() {
    return this.#filename;
  }

  async #read() {
    return (await this.#capture()).state;
  }

  async #capture() {
    try {
      return {
        exists: true,
        state: normalizeState(JSON.parse(await readFile(this.#filename, "utf8"))),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, state: emptyState() };
      throw error;
    }
  }

  async captureState() {
    return withStateLock(this.#filename, async () => clone(await this.#capture()));
  }

  async restoreState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.exists !== "boolean") {
      throw new Error("SUBJECT_HISTORY_INVALID: state snapshot is malformed");
    }
    const state = normalizeState(value.state);
    return withStateLock(this.#filename, async () => {
      if (value.exists) {
        await atomicWrite(this.#filename, state);
      } else {
        await unlink(this.#filename).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      return clone({ exists: value.exists, state });
    });
  }

  async #mutate(operation) {
    let result;
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      result = await withStateLock(this.#filename, async () => {
        const state = await this.#read();
        result = await operation(state);
        await atomicWrite(this.#filename, state);
        return result;
      });
    });
    await this.#writeQueue;
    return clone(result);
  }

  async syncSubject(input) {
    const subject = clone(input);
    const subjectKey = key(subject?.subjectKey);
    const configVersion = versionNumber(subject?.configVersion);
    const lifecycle = subject?.lifecycle ?? "enabled";
    if (!["enabled", "disabled", "draft"].includes(lifecycle)) throw new Error("lifecycle is invalid");
    const enabledAt = timestamp(subject.enabledAt, this.now());
    const closedAt = subject.closedAt === null || subject.closedAt === undefined
      ? null : timestamp(subject.closedAt, enabledAt);
    const snapshot = {
      ...subject,
      subjectKey,
      configVersion,
      lifecycle,
      enabledAt,
      closedAt,
    };
    return this.#mutate((state) => {
      const entry = subjectEntry(state, subjectKey);
      const existing = entry.versions.find((candidate) => candidate.configVersion === configVersion);
      if (existing) {
        // A version is immutable.  A byte-different replay is a conflict.
        if (JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)) {
          const error = new Error("SUBJECT_VERSION_CONFLICT");
          error.code = "SUBJECT_VERSION_CONFLICT";
          throw error;
        }
        return existing.snapshot;
      }
      if (lifecycle === "enabled") {
        for (const candidate of entry.versions) {
          if (isEnabled(candidate) && (candidate.closedAt === null || candidate.closedAt > enabledAt)) {
            candidate.closedAt = enabledAt;
          }
        }
        entry.currentVersion = configVersion;
        entry.current = clone(snapshot);
      } else if (lifecycle === "disabled") {
        for (const candidate of entry.versions) {
          if (isEnabled(candidate) && (candidate.closedAt === null || candidate.closedAt > enabledAt)) {
            candidate.closedAt = enabledAt;
          }
        }
        entry.currentVersion = null;
        entry.current = null;
      }
      entry.versions.push({
        subjectKey,
        configVersion,
        enabledAt,
        closedAt,
        lifecycle,
        snapshot: clone(snapshot),
      });
      entry.versions.sort((left, right) => left.configVersion - right.configVersion);
      state.subjects[subjectKey] = entry;
      return snapshot;
    });
  }

  async saveDraft(subjectKeyValue, patch) {
    const subjectKey = key(subjectKeyValue);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("draft patch must be an object");
    return this.#mutate((state) => {
      const entry = subjectEntry(state, subjectKey);
      entry.current = { ...(entry.current ?? {}), ...clone(patch) };
      state.subjects[subjectKey] = entry;
      return entry.current;
    });
  }

  async getSubjectVersion(subjectKeyValue, configVersionValue) {
    const subjectKey = key(subjectKeyValue);
    const configVersion = versionNumber(configVersionValue);
    const state = await withStateLock(this.#filename, () => this.#read());
    const entry = state.subjects[subjectKey];
    const found = entry?.versions.find((candidate) => candidate.configVersion === configVersion);
    return found ? clone(found.snapshot) : null;
  }

  async resolveSubjectVersionAt(subjectKeyValue, occurredAt, { requireEnabled = true } = {}) {
    const subjectKey = key(subjectKeyValue);
    const state = await withStateLock(this.#filename, () => this.#read());
    const entry = state.subjects[subjectKey];
    if (!entry) return null;
    if (occurredAt === undefined || occurredAt === null) {
      if (!entry.currentVersion) return null;
      const current = entry.versions.find((candidate) => candidate.configVersion === entry.currentVersion);
      return current && (!requireEnabled || isEnabled(current)) ? clone(current.snapshot) : null;
    }
    const at = timestamp(occurredAt);
    const found = [...entry.versions].reverse().find((candidate) => (
      (!requireEnabled || isEnabled(candidate))
      && candidate.enabledAt <= at
      && (candidate.closedAt === null || candidate.closedAt > at)
    ));
    return found ? clone(found.snapshot) : null;
  }

  async listSubjectVersions(subjectKeyValue) {
    const subjectKey = key(subjectKeyValue);
    const state = await withStateLock(this.#filename, () => this.#read());
    return clone(state.subjects[subjectKey]?.versions.map((entry) => entry.snapshot) ?? []);
  }
}

export function createSubjectVersionHistory(filename, options) {
  return new SubjectVersionHistory(filename, options);
}
