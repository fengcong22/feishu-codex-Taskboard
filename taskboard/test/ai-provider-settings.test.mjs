import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyCodexProvider, createAiProviderStore, probeAiProvider, readCodexProvider }
  from "../server/ai-provider-store.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { listenTaskboardOnFetchSafePort } from "../../test/fetch-safe-listen.mjs";

// Reversible stand-in for DPAPI so the tests run on every platform.
const fakeProtection = Object.freeze({
  available: () => true,
  protect: async (bytes) => Buffer.from(`enc:${bytes.toString("base64")}`),
  unprotect: async (bytes) => Buffer.from(bytes.toString().replace(/^enc:/u, ""), "base64"),
});
const CONFIG = [
  'model_provider = "custom"',
  'model = "gpt-old"',
  'model_reasoning_effort = "high"',
  "",
  "[model_providers.custom]",
  'name = "OldRelay"',
  'base_url = "https://old.example"',
  'wire_api = "responses"',
  "requires_openai_auth = false",
  'experimental_bearer_token = "sk-old-key-9876"',
  "",
  "[mcp_servers.demo]",
  'command = "demo"',
  "",
].join("\n");

async function storeFixture(t, { probe } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-providers-"));
  const cleanup = [];
  // Servers close before their data directory is removed (Windows keeps the SQLite file locked).
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const dataDirectory = path.join(root, "data"), codexHome = path.join(root, "codex");
  await Promise.all([mkdir(dataDirectory), mkdir(codexHome)]);
  await writeFile(path.join(codexHome, "config.toml"), CONFIG);
  const store = createAiProviderStore({ dataDirectory, codexHome, protection: fakeProtection,
    ...(probe ? { probe } : {}) });
  return { root, dataDirectory, codexHome, store, cleanup, config: () => readFile(path.join(codexHome, "config.toml"), "utf8") };
}

test("switching providers rewrites only Taskboard's table and the selected model", () => {
  const out = applyCodexProvider(CONFIG, { name: "新接口", baseUrl: "https://new.example/v1", wireApi: "chat",
    apiKey: "sk-new", model: "gpt-new" });
  assert.deepEqual(readCodexProvider(out), { providerId: "taskboard", name: "新接口", baseUrl: "https://new.example/v1",
    wireApi: "chat", model: "gpt-new", managedByTaskboard: true });
  assert.ok(out.includes('model_reasoning_effort = "high"'));
  assert.ok(out.includes("[model_providers.custom]") && out.includes('experimental_bearer_token = "sk-old-key-9876"'));
  assert.ok(out.includes("[mcp_servers.demo]"));
  const again = applyCodexProvider(out, { name: "B", baseUrl: "https://b.example", wireApi: "responses", apiKey: "sk-b", model: "m" });
  assert.equal(again.match(/\[model_providers\.taskboard\]/gu).length, 1);
  assert.equal(again.match(/^model = /gmu).length, 1);
});

test("profiles keep keys encrypted, never return them, and activate into Codex's config", async (t) => {
  const x = await storeFixture(t);
  let state = await x.store.list();
  assert.equal(state.codex.name, "OldRelay");
  state = await x.store.importCurrent({ expectedVersion: state.version });
  assert.equal(state.profiles[0].keyHint, "…9876");
  state = await x.store.create({ expectedVersion: state.version, name: "主用", baseUrl: "https://new.example/v1/",
    wireApi: "responses", apiKey: "sk-new-secret-1234", model: "gpt-new", vmModel: "gpt-edit" });
  const created = state.profiles.find((profile) => profile.name === "主用");
  assert.equal(created.baseUrl, "https://new.example/v1");
  assert.ok(!JSON.stringify(state).includes("sk-new-secret-1234"));
  assert.ok(!(await readFile(path.join(x.dataDirectory, "ai-providers.json"), "utf8")).includes("sk-new"));
  assert.ok(!(await readFile(path.join(x.dataDirectory, "ai-provider-keys.bin"), "utf8")).includes("sk-new"));

  state = await x.store.activate(created.id, { expectedVersion: state.version });
  assert.equal(state.activeId, created.id);
  const config = await x.config();
  assert.deepEqual(readCodexProvider(config).model, "gpt-new");
  assert.ok(config.includes('experimental_bearer_token = "sk-new-secret-1234"'));
  assert.equal(await readFile(path.join(x.codexHome, "config.toml.taskboard-backup"), "utf8"), CONFIG);
  assert.equal(await x.store.activeVmModel(), "gpt-edit");

  // A blank key on update keeps the saved one; editing the active profile rewrites Codex's config.
  state = await x.store.update(created.id, { expectedVersion: state.version, name: "主用", baseUrl: "https://new.example/v1",
    wireApi: "responses", apiKey: "", model: "gpt-newer", vmModel: null });
  assert.equal(readCodexProvider(await x.config()).model, "gpt-newer");
  assert.ok((await x.config()).includes('experimental_bearer_token = "sk-new-secret-1234"'));
  assert.equal(await x.store.activeVmModel(), "gpt-newer");

  await assert.rejects(x.store.remove(created.id, { expectedVersion: state.version }), { code: "AI_PROVIDER_ACTIVE" });
  await assert.rejects(x.store.activate(created.id, { expectedVersion: state.version - 1 }), { code: "VERSION_CONFLICT" });
  const old = state.profiles.find((profile) => profile.id !== created.id);
  state = await x.store.activate(old.id, { expectedVersion: state.version });
  assert.ok((await x.config()).includes('experimental_bearer_token = "sk-old-key-9876"'));
  state = await x.store.remove(created.id, { expectedVersion: state.version });
  assert.equal(state.profiles.length, 1);
});

test("profile input rejects unsafe addresses, models and keys", async (t) => {
  const x = await storeFixture(t);
  const base = { expectedVersion: 0, name: "x", baseUrl: "https://a.example", wireApi: "responses", apiKey: "sk-12345678", model: "m" };
  for (const change of [{ baseUrl: "file:///etc" }, { baseUrl: "https://user:pw@a.example" }, { baseUrl: "https://a.example?k=1" },
    { model: "bad model" }, { apiKey: "short" }, { apiKey: "sk with space" }, { wireApi: "grpc" }, { name: "" }]) {
    await assert.rejects(x.store.create({ ...base, ...change }), { code: "AI_PROVIDER_INVALID" }, JSON.stringify(change));
  }
});

test("connection test reports rejected keys and lists models from either models path", async () => {
  const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
  const rejected = await probeAiProvider({ baseUrl: "https://a.example", apiKey: "sk-12345678",
    fetchImpl: async () => reply(403, { code: "INSUFFICIENT_BALANCE" }) });
  assert.equal(rejected.errorCode, "AI_PROVIDER_FORBIDDEN");
  assert.match(rejected.detail, /INSUFFICIENT_BALANCE/u);
  const seen = [];
  const listed = await probeAiProvider({ baseUrl: "https://a.example", apiKey: "sk-12345678", fetchImpl: async (url, init) => {
    seen.push([url, init.headers.authorization]);
    return url.endsWith("/v1/models") ? reply(200, { data: [{ id: "gpt-b" }, { id: "gpt-a" }, { id: "bad id" }] }) : reply(404, {});
  } });
  assert.deepEqual(listed, { ok: true, models: ["gpt-a", "gpt-b"] });
  assert.deepEqual(seen.map(([url]) => url), ["https://a.example/models", "https://a.example/v1/models"]);
  assert.equal(seen[0][1], "Bearer sk-12345678");
});

function send(baseUrl, method, route, body, headers = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(baseUrl + route, { method, headers: { "content-type": "application/json",
      ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }), ...headers } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("AI provider endpoints are loopback, web-client only and never echo a key", async (t) => {
  const x = await storeFixture(t, { probe: async ({ apiKey }) => ({ ok: true, models: [apiKey.length > 8 ? "gpt-a" : "none"] }) });
  const app = createTaskboardServer({ dataDirectory: x.dataDirectory, codexHome: x.codexHome, aiProviderStore: x.store,
    codexExecutable: process.execPath });
  const address = await listenTaskboardOnFetchSafePort(app);
  x.cleanup.push(() => app.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const route = "/api/local/settings/ai-providers";
  const web = { "x-taskboard-client": "web" };
  assert.equal((await send(baseUrl, "GET", route)).body.codex.name, "OldRelay");
  const profile = { expectedVersion: 0, name: "主用", baseUrl: "https://new.example", wireApi: "responses",
    apiKey: "sk-http-secret-5555", model: "gpt-a", vmModel: null };
  assert.equal((await send(baseUrl, "POST", route, profile)).status, 403);
  assert.equal((await send(baseUrl, "POST", route, profile, { ...web, host: "example.com" })).status, 403);
  assert.equal((await send(baseUrl, "POST", route, { ...profile, extra: 1 }, web)).status, 400);
  const created = await send(baseUrl, "POST", route, profile, web);
  assert.equal(created.status, 201);
  assert.ok(!created.text.includes("sk-http-secret-5555"));
  const id = created.body.profiles[0].id;
  const tested = await send(baseUrl, "POST", `${route}/test`, { id, baseUrl: "https://new.example", apiKey: "" }, web);
  assert.deepEqual(tested.body, { ok: true, models: ["gpt-a"] });
  const activated = await send(baseUrl, "POST", `${route}/${id}/activate`, { expectedVersion: 1 }, web);
  assert.equal(activated.status, 200);
  assert.equal(activated.body.codex.model, "gpt-a");
  assert.ok(!activated.text.includes("sk-http-secret-5555"));
  const removal = await send(baseUrl, "DELETE", `${route}/${id}`, { expectedVersion: 2 }, web);
  assert.equal(removal.body?.error?.code, "AI_PROVIDER_ACTIVE", `${removal.status} ${removal.text}`);
});
