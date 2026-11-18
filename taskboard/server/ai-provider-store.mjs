import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { createWindowsDpapi } from "./vm-credential-store.mjs";

/**
 * Local AI provider profiles for Codex. Names, addresses and models live in a plain JSON file;
 * API keys are kept only as Windows DPAPI ciphertext (current Windows user) and are never returned.
 * Activating a profile writes Taskboard's own `[model_providers.taskboard]` table into Codex's
 * config.toml, which Codex itself requires in plain text, and points `model_provider`/`model` at it.
 */
const FILE_VERSION = 1;
const MAX_PROFILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const PROVIDER_ID = "taskboard";
const ENTROPY = "codex-taskboard:ai-provider-keys:v1";
const NAME = /^[^\u0000-\u001f]{1,60}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const KEY = /^[\x21-\x7e]{8,4096}$/u;
const WIRE_APIS = new Set(["responses", "chat"]);
const TEST_TIMEOUT_MS = 15_000;

function invalid(message) { return new ApiError(400, "AI_PROVIDER_INVALID", message); }

function cleanBaseUrl(value) {
  if (typeof value !== "string") throw invalid("接口地址必须是文本");
  const text = value.trim().replace(/\/+$/u, "");
  let url;
  try { url = new URL(text); } catch { throw invalid("接口地址不是有效网址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw invalid("接口地址只能是不带账号和参数的 http(s) 网址");
  return text;
}

function cleanModel(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !MODEL.test(value.trim())) throw invalid(`${label}不是有效的模型名`);
  return value.trim();
}

function keyHint(key) { return `…${key.slice(-4)}`; }

/** TOML basic string; JSON escapes are valid TOML escapes. */
function tomlString(value) { return JSON.stringify(value); }

function tableHeader(line) {
  const match = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/u.exec(line);
  return match ? match[1].replace(/\s+/gu, "") : null;
}

/** Rewrites only Taskboard's provider table and the two top-level keys that select it. */
export function applyCodexProvider(source, { name, baseUrl, wireApi, apiKey, model }) {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const firstTable = lines.findIndex((line) => tableHeader(line) !== null);
  const top = firstTable === -1 ? lines : lines.slice(0, firstTable);
  let rest = firstTable === -1 ? [] : lines.slice(firstTable);
  const setTop = (key, value) => {
    const index = top.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`, "u").test(line));
    const line = `${key} = ${tomlString(value)}`;
    if (index === -1) {
      let insertAt = top.length;
      while (insertAt > 0 && top[insertAt - 1].trim() === "") insertAt -= 1;
      top.splice(insertAt, 0, line);
    } else top[index] = line;
  };
  setTop("model_provider", PROVIDER_ID);
  setTop("model", model);
  const kept = [];
  let skipping = false;
  for (const line of rest) {
    const header = tableHeader(line);
    if (header !== null) skipping = header === `model_providers.${PROVIDER_ID}`;
    if (!skipping) kept.push(line);
  }
  rest = kept;
  while (rest.length && rest.at(-1).trim() === "") rest.pop();
  const table = [`[model_providers.${PROVIDER_ID}]`, `name = ${tomlString(name)}`, `base_url = ${tomlString(baseUrl)}`,
    `wire_api = ${tomlString(wireApi)}`, "requires_openai_auth = false",
    `experimental_bearer_token = ${tomlString(apiKey)}`];
  const head = top.join("\n").replace(/\n+$/u, "");
  return `${head}\n\n${rest.length ? `${rest.join("\n")}\n\n` : ""}${table.join("\n")}\n`;
}

/** Non-secret summary of the provider Codex currently uses, for display only. */
export function readCodexProvider(source) {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const value = (line, key) => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(line);
    if (!match) return null;
    try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
  };
  let table = null;
  const top = {};
  const providers = {};
  for (const line of lines) {
    const header = tableHeader(line);
    if (header !== null) { table = header; continue; }
    if (table === null) {
      for (const key of ["model_provider", "model"]) { const found = value(line, key); if (found !== null) top[key] = found; }
    } else if (table.startsWith("model_providers.")) {
      const id = table.slice("model_providers.".length);
      providers[id] ??= {};
      for (const key of ["name", "base_url", "wire_api"]) { const found = value(line, key); if (found !== null) providers[id][key] = found; }
      if (/^\s*experimental_bearer_token\s*=/u.test(line)) providers[id].hasKey = true;
    }
  }
  const id = top.model_provider ?? null;
  const provider = id ? providers[id] ?? null : null;
  return { providerId: id, name: provider?.name ?? null, baseUrl: provider?.base_url ?? null,
    wireApi: provider?.wire_api ?? null, model: top.model ?? null, managedByTaskboard: id === PROVIDER_ID };
}

/** The raw bearer token of the provider Codex currently uses; only for importing it into a profile. */
function readCodexProviderKey(source) {
  const summary = readCodexProvider(source);
  if (!summary.providerId) return null;
  let inside = false;
  for (const line of source.replace(/\r\n/gu, "\n").split("\n")) {
    const header = tableHeader(line);
    if (header !== null) { inside = header === `model_providers.${summary.providerId}`; continue; }
    const match = inside && /^\s*experimental_bearer_token\s*=\s*"((?:[^"\\]|\\.)*)"/u.exec(line);
    if (match) { try { return JSON.parse(`"${match[1]}"`); } catch { return null; } }
  }
  return null;
}

async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readSmall(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new ApiError(500, "AI_PROVIDER_STORE_INVALID", "AI provider store is not a regular file");
    return await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Lists model ids from an OpenAI-compatible endpoint; used to check an address and key before saving. */
export async function probeAiProvider({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = TEST_TIMEOUT_MS }) {
  let lastStatus = null;
  for (const suffix of ["/models", "/v1/models"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${suffix}`, { headers: { authorization: `Bearer ${apiKey}`,
        accept: "application/json" }, signal: controller.signal, redirect: "error" });
      lastStatus = response.status;
      if (response.status === 401 || response.status === 403) {
        let detail = "";
        try { detail = JSON.stringify(await response.json()).slice(0, 300); } catch {}
        return { ok: false, errorCode: response.status === 401 ? "AI_PROVIDER_KEY_REJECTED" : "AI_PROVIDER_FORBIDDEN",
          status: response.status, detail };
      }
      if (!response.ok) continue;
      const body = await response.json().catch(() => null);
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
      if (!rows) continue;
      const models = [...new Set(rows.map((row) => typeof row === "string" ? row : row?.id)
        .filter((id) => typeof id === "string" && MODEL.test(id)))].sort().slice(0, 300);
      return { ok: true, models };
    } catch (error) {
      if (error?.name === "AbortError") return { ok: false, errorCode: "AI_PROVIDER_TIMEOUT" };
      lastStatus = lastStatus ?? "network";
    } finally { clearTimeout(timer); }
  }
  return { ok: false, errorCode: lastStatus === "network" ? "AI_PROVIDER_UNREACHABLE" : "AI_PROVIDER_MODELS_UNAVAILABLE",
    ...(Number.isInteger(lastStatus) ? { status: lastStatus } : {}) };
}

export function createAiProviderStore({ dataDirectory, codexHome, protection = createWindowsDpapi(ENTROPY),
  probe = probeAiProvider, now = () => new Date() } = {}) {
  const metaFile = path.join(dataDirectory, "ai-providers.json");
  const keyFile = path.join(dataDirectory, "ai-provider-keys.bin");
  const configFile = path.join(codexHome, "config.toml");
  let queue = Promise.resolve();
  const serial = (work) => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };

  async function loadMeta() {
    const bytes = await readSmall(metaFile);
    if (!bytes) return { version: 0, activeId: null, profiles: [] };
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError(500, "AI_PROVIDER_STORE_INVALID", "AI provider store is unreadable"); }
    if (value?.fileVersion !== FILE_VERSION || !Array.isArray(value.profiles) || !Number.isSafeInteger(value.version))
      throw new ApiError(500, "AI_PROVIDER_STORE_INVALID", "AI provider store has an unsupported format");
    return { version: value.version, activeId: value.activeId ?? null, profiles: value.profiles };
  }
  async function saveMeta(meta) {
    await atomicWrite(metaFile, `${JSON.stringify({ fileVersion: FILE_VERSION, ...meta }, null, 2)}\n`);
  }
  async function loadKeys() {
    const bytes = await readSmall(keyFile);
    if (!bytes) return {};
    let value;
    try { value = JSON.parse((await protection.unprotect(bytes)).toString("utf8")); }
    catch { throw new ApiError(500, "AI_PROVIDER_KEYS_UNREADABLE", "保存的 API key 无法解密（需要同一个 Windows 用户）"); }
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  async function saveKeys(keys) {
    await atomicWrite(keyFile, await protection.protect(Buffer.from(JSON.stringify(keys), "utf8")));
  }
  function assertAvailable() {
    if (!protection.available()) throw new ApiError(503, "AI_PROVIDER_UNAVAILABLE", "此平台无法加密保存 API key");
  }
  async function readConfig() {
    try { return (await readFile(configFile)).toString("utf8"); }
    catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
  }
  function publicProfile(profile) {
    const { id, name, baseUrl, wireApi, model, vmModel, keyHint: hint, updatedAt } = profile;
    return { id, name, baseUrl, wireApi, model, vmModel, keyHint: hint, updatedAt };
  }
  function assertVersion(meta, expectedVersion) {
    if (expectedVersion !== meta.version) throw new ApiError(409, "VERSION_CONFLICT", "AI 接口设置已在别处修改，请刷新后重试");
  }
  function profileInput(input, { requireKey }) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!NAME.test(name)) throw invalid("名称为 1–60 个字符");
    const wireApi = input.wireApi ?? "responses";
    if (!WIRE_APIS.has(wireApi)) throw invalid("接口类型只能是 responses 或 chat");
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if ((requireKey || apiKey) && !KEY.test(apiKey)) throw invalid("API key 应为 8 位以上、不含空格的字符");
    return { name, baseUrl: cleanBaseUrl(input.baseUrl), wireApi, apiKey: apiKey || null,
      model: cleanModel(input.model, "模型"), vmModel: cleanModel(input.vmModel, "AI 剪辑模型", true) };
  }
  async function writeActive(profile, keys) {
    const apiKey = keys[profile.id];
    if (!apiKey) throw new ApiError(409, "AI_PROVIDER_KEY_MISSING", "这套接口没有保存 key");
    const current = await readConfig();
    if (current) await atomicWrite(`${configFile}.taskboard-backup`, current);
    await atomicWrite(configFile, applyCodexProvider(current, { name: profile.name, baseUrl: profile.baseUrl,
      wireApi: profile.wireApi, apiKey, model: profile.model }));
  }

  async function list() {
    const meta = await loadMeta();
    return { available: protection.available(), version: meta.version, activeId: meta.activeId,
      profiles: meta.profiles.map(publicProfile), codex: readCodexProvider(await readConfig()) };
  }
  /** The VM AI planning model of the active profile, or null when none is set. */
  async function activeVmModel() {
    const meta = await loadMeta();
    const active = meta.profiles.find((profile) => profile.id === meta.activeId);
    return active ? active.vmModel ?? active.model : null;
  }
  const create = (input) => serial(async () => {
    assertAvailable();
    const meta = await loadMeta();
    assertVersion(meta, input.expectedVersion);
    if (meta.profiles.length >= MAX_PROFILES) throw invalid(`最多保存 ${MAX_PROFILES} 套接口`);
    const value = profileInput(input, { requireKey: true });
    const id = randomUUID();
    const keys = await loadKeys();
    keys[id] = value.apiKey;
    await saveKeys(keys);
    const { apiKey, ...rest } = value;
    meta.profiles.push({ id, ...rest, keyHint: keyHint(apiKey), updatedAt: now().toISOString() });
    meta.version += 1;
    await saveMeta(meta);
    return list();
  });
  const update = (id, input) => serial(async () => {
    assertAvailable();
    const meta = await loadMeta();
    assertVersion(meta, input.expectedVersion);
    const index = meta.profiles.findIndex((profile) => profile.id === id);
    if (index === -1) throw new ApiError(404, "AI_PROVIDER_NOT_FOUND", "接口不存在");
    const value = profileInput(input, { requireKey: false });
    const keys = await loadKeys();
    if (value.apiKey) { keys[id] = value.apiKey; await saveKeys(keys); }
    const { apiKey, ...rest } = value;
    meta.profiles[index] = { ...meta.profiles[index], ...rest,
      ...(apiKey ? { keyHint: keyHint(apiKey) } : {}), updatedAt: now().toISOString() };
    if (meta.activeId === id) await writeActive(meta.profiles[index], keys);
    meta.version += 1;
    await saveMeta(meta);
    return list();
  });
  const remove = (id, { expectedVersion } = {}) => serial(async () => {
    const meta = await loadMeta();
    assertVersion(meta, expectedVersion);
    if (!meta.profiles.some((profile) => profile.id === id)) throw new ApiError(404, "AI_PROVIDER_NOT_FOUND", "接口不存在");
    if (meta.activeId === id) throw new ApiError(409, "AI_PROVIDER_ACTIVE", "正在使用的接口不能删除，请先切换到其他接口");
    const keys = await loadKeys();
    delete keys[id];
    await saveKeys(keys);
    meta.profiles = meta.profiles.filter((profile) => profile.id !== id);
    meta.version += 1;
    await saveMeta(meta);
    return list();
  });
  const activate = (id, { expectedVersion } = {}) => serial(async () => {
    assertAvailable();
    const meta = await loadMeta();
    assertVersion(meta, expectedVersion);
    const profile = meta.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ApiError(404, "AI_PROVIDER_NOT_FOUND", "接口不存在");
    await writeActive(profile, await loadKeys());
    meta.activeId = id;
    meta.version += 1;
    await saveMeta(meta);
    return list();
  });
  /** Saves the provider Codex uses today as a profile, so switching away keeps a way back. */
  const importCurrent = ({ expectedVersion, name } = {}) => serial(async () => {
    assertAvailable();
    const source = await readConfig();
    const current = readCodexProvider(source);
    const apiKey = readCodexProviderKey(source);
    if (!current.baseUrl || !current.model || !apiKey) throw new ApiError(409, "AI_PROVIDER_IMPORT_UNAVAILABLE",
      "当前 Codex 配置里没有可导入的接口地址、模型和 key");
    const meta = await loadMeta();
    assertVersion(meta, expectedVersion);
    const value = profileInput({ name: name ?? current.name ?? "当前 Codex 配置", baseUrl: current.baseUrl,
      wireApi: current.wireApi ?? "responses", apiKey, model: current.model }, { requireKey: true });
    const id = randomUUID();
    const keys = await loadKeys();
    keys[id] = value.apiKey;
    await saveKeys(keys);
    const { apiKey: _key, ...rest } = value;
    meta.profiles.push({ id, ...rest, keyHint: keyHint(value.apiKey), updatedAt: now().toISOString() });
    meta.version += 1;
    await saveMeta(meta);
    return list();
  });
  /** Tests a saved profile (`id`) or unsaved values; a blank key on a saved profile uses the stored one. */
  async function test(input) {
    const baseUrl = cleanBaseUrl(input.baseUrl);
    let apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey && typeof input.id === "string") apiKey = (await loadKeys())[input.id] ?? "";
    if (!KEY.test(apiKey)) throw invalid("请先填写 API key");
    return probe({ baseUrl, apiKey });
  }
  return Object.freeze({ list, create, update, remove, activate, importCurrent, test, activeVmModel, configFile });
}
