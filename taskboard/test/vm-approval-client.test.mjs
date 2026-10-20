import assert from "node:assert/strict";
import test from "node:test";

import { createVmApprovalClient, VM_APPROVAL_ORIGIN } from "../server/vm-approval-client.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

const TOKEN = "test-token-never-log";
const VMID = "0123456789abcdef01234567";

function response(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json", ...options.headers }, ...options,
  });
}

function fixture(results, options = {}) {
  const calls = [];
  const client = createVmApprovalClient({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, parsedBody: init.body ? JSON.parse(init.body) : undefined });
      const result = results.shift();
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result(url, init) : result;
    },
    ...options,
  });
  return { client, calls };
}

test("calls only fixed Shadow endpoints with normalized authentication and no redirects", async () => {
  const identity = { raw: { feishu: { user_id: "user-1" } } };
  const videos = { videos: [{ id: VMID }], total: 1 };
  const departments = { data: { department_infos: [{ id: "dep-1", name: "Animation" }] } };
  const application = { id: "application-1", applyStatus: "PENDING" };
  const { client, calls } = fixture([response(identity), response(videos), response(departments), response(application), response({})], {
    token: `  Bearer ${TOKEN}  `,
  });
  assert.deepEqual(await client.getIdentity(), identity);
  assert.deepEqual(await client.getVideos(VMID), videos);
  assert.deepEqual(await client.getDepartments(["dep-1"]), departments);
  assert.deepEqual(await client.getApplication("application-1"), application);
  assert.deepEqual(await client.submitApplication({ videoIds: [VMID], applyReason: "fixture" }), {});
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/api/auth/me", "/api/video-manager/video/getVideoList",
    "/api/feishu-open-apis/contact/v1/department/detail/batch_get",
    "/api/video-manager/videoApply/getVideoApply", "/api/video-manager/video/applyVideo",
  ]);
  assert.deepEqual(calls[1].parsedBody, { pageIndex: 1, pageSize: 100, videoIds: [VMID] });
  assert.deepEqual(calls[2].parsedBody, { department_ids: ["dep-1"] });
  assert.equal(new URL(calls[3].url).searchParams.get("id"), "application-1");
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, VM_APPROVAL_ORIGIN);
    assert.equal(call.headers.authorization, TOKEN);
    assert.equal(call.headers.shadowauthorization, TOKEN);
    assert.equal(call.redirect, "error");
    assert.equal(call.credentials, "omit");
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.headers.cookie, undefined);
  }
  assert.equal(Object.isFrozen(client), true);
});

test("updates rotated authentication only in memory for subsequent requests", async () => {
  const rotated = "rotated-token-never-log";
  const renewed = [];
  const { client, calls } = fixture([
    response({ identity: true }, { headers: { shadowauthorization: `Bearer ${rotated}` } }), response({}),
  ], { onToken: (token) => renewed.push(token) });
  assert.deepEqual(await client.getIdentity(), { identity: true });
  await client.getIdentity();
  assert.equal(calls[0].headers.authorization, TOKEN);
  assert.equal(calls[1].headers.authorization, rotated);
  assert.equal(calls[1].headers.shadowauthorization, rotated);
  assert.deepEqual(renewed, [rotated]);
  assert.doesNotMatch(JSON.stringify(client), /test-token|rotated-token/u);
});

test("rotation observers cannot turn a successful submission into an apparent failure", async () => {
  for (const onToken of [() => { throw new Error(TOKEN); }, async () => { throw new Error(TOKEN); }]) {
    const { client, calls } = fixture([
      response({ id: "application-1" }, { headers: { shadowauthorization: "rotated-token" } }), response({}),
    ], { onToken });
    assert.deepEqual(await client.submitApplication({ videoIds: [VMID] }), { id: "application-1" });
    await client.getIdentity();
    assert.equal(calls[1].headers.authorization, "rotated-token");
  }
});

test("rejected responses never publish a rotated credential", async () => {
  for (const result of [
    response({}, { status: 401, headers: { shadowauthorization: "rotated-token" } }),
    new Response("{", { headers: { shadowauthorization: "rotated-token" } }),
    response({}, { headers: { shadowauthorization: "Bearer" } }),
  ]) {
    const renewed = [];
    const { client } = fixture([result], { onToken: (token) => renewed.push(token) });
    await assert.rejects(client.getIdentity());
    assert.deepEqual(renewed, []);
  }
});

test("lists every application using empty dates and stable page counts", async () => {
  const first = Array.from({ length: 100 }, (_, index) => ({ id: `application-${index}` }));
  const last = [{ id: "application-100" }, { id: "application-101" }];
  const { client, calls } = fixture([response({ list: first, count: 102 }), response({ list: last, count: 102 })]);
  assert.deepEqual(await client.listApplications(), { list: [...first, ...last], count: 102 });
  assert.deepEqual(calls.map((call) => call.parsedBody), [1, 2].map((page) => ({
    page, size: 100, beginTime: "", endTime: "", applyType: "VIDEO_DOWNLOAD",
  })));
});

test("accepts an empty complete application list", async () => {
  const { client, calls } = fixture([response({ list: [], count: 0 })]);
  assert.deepEqual(await client.listApplications(), { list: [], count: 0 });
  assert.equal(calls.length, 1);
});

test("rejects malformed, duplicated, changing or silently truncated application pages", async () => {
  const cases = [
    [{ data: { list: [], count: 0 } }], [{ list: {}, count: 0 }], [{ list: [], count: "0" }],
    [{ list: [], count: -1 }], [{ list: [{ id: "one" }] }], [{ list: [null], count: 1 }],
    [{ list: [{ id: 1 }], count: 1 }], [{ list: [{ id: "one" }, { id: "one" }], count: 2 }],
    [{ list: [{ id: "one" }], count: 0 }], [{ list: [], count: 1 }],
    [{ list: [{ id: "one" }], count: 2 }, { list: [{ id: "one" }], count: 2 }],
    [{ list: [{ id: "one" }], count: 2 }, { list: [{ id: "two" }], count: 3 }],
    [{ list: [{ id: "one" }], count: 2 }, { list: [], count: 2 }],
    [{ list: Array.from({ length: 101 }, (_, index) => ({ id: `id-${index}` })), count: 101 }],
  ];
  for (const pages of cases) {
    const { client } = fixture(pages.map((page) => response(page)));
    await assert.rejects(client.listApplications(), { code: "VM_API_PAGINATION_INVALID" });
  }
});

test("fails visibly at application and pagination limits instead of returning incomplete results", async () => {
  const oversized = fixture([response({ list: [], count: 10_001 })]);
  await assert.rejects(oversized.client.listApplications(), { code: "VM_API_LIMIT_EXCEEDED" });
  const capped = fixture(Array.from({ length: 100 }, (_, index) => response({ list: [{ id: `id-${index}` }], count: 101 })));
  await assert.rejects(capped.client.listApplications(), { code: "VM_API_LIMIT_EXCEEDED" });
  assert.equal(capped.calls.length, 100);
});

test("rejects invalid configuration and endpoint inputs before network requests", async () => {
  for (const token of [undefined, null, "", "  ", "Bearer", "Bearer ", " bearer\t "]) {
    assert.throws(() => createVmApprovalClient({ token }), { code: "VM_AUTH_REQUIRED" });
  }
  for (const config of [
    { token: "bad\nsecret" }, { token: "x".repeat(16_385) }, { token: TOKEN, fetchImpl: null },
    { token: TOKEN, timeoutMs: 0 }, { token: TOKEN, timeoutMs: 1.1 }, { token: TOKEN, timeoutMs: 2_147_483_648 },
    { token: TOKEN, onToken: false },
  ]) assert.throws(() => createVmApprovalClient(config), { code: "VM_API_INPUT_INVALID" });
  const { client, calls } = fixture([]);
  for (const vmid of [null, VMID.toUpperCase(), "https://evil.example", [VMID]]) {
    assert.throws(() => client.getVideos(vmid), { code: "VM_API_INPUT_INVALID" });
  }
  for (const id of [null, "", "https://evil.example", "x\nsecret", "x".repeat(129)]) {
    assert.throws(() => client.getApplication(id), { code: "VM_API_INPUT_INVALID" });
  }
  for (const ids of [null, [], ["dep-1", "dep-1"], [1], Array(101).fill("dep-1")]) {
    assert.throws(() => client.getDepartments(ids), { code: "VM_API_INPUT_INVALID" });
  }
  for (const body of [undefined, null, [], "raw", { toJSON() { throw new Error(TOKEN); } }]) {
    await assert.rejects(client.submitApplication(body), { code: "VM_API_INPUT_INVALID" });
  }
  assert.equal(calls.length, 0);
});

test("returns only safe errors for authentication, HTTP and transport failures", async () => {
  const sensitive = `${TOKEN} https://evil.example/download?signature=private`;
  for (const [result, code] of [
    [response({ secret: sensitive }, { status: 401 }), "VM_AUTH_REQUIRED"],
    [response({ secret: sensitive }, { status: 403 }), "VM_AUTH_REQUIRED"],
    [response({ secret: sensitive }, { status: 500 }), "VM_API_HTTP_FAILED"],
    [response(null, { status: 302, headers: { location: sensitive } }), "VM_API_HTTP_FAILED"],
    [new Error(sensitive), "VM_API_TRANSPORT_FAILED"],
  ]) {
    const { client } = fixture([result]);
    await assert.rejects(client.getIdentity(), (error) => {
      assert.ok(error instanceof VmSourceError);
      assert.equal(error.code, code);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /test-token|https:|signature|private/u);
      return true;
    });
  }
});

test("rejects invalid JSON, invalid UTF-8 and invalid renewed authentication", async () => {
  for (const result of [
    new Response("<html>secret</html>"), new Response("{"), new Response(new Uint8Array([0xff])),
    response({}, { headers: { shadowauthorization: "" } }),
    response({}, { headers: { shadowauthorization: "Bearer" } }),
    response({}, { headers: { "content-length": "not-a-length" } }),
    { status: 200, redirected: true, body: null },
  ]) {
    const { client } = fixture([result]);
    await assert.rejects(client.getIdentity(), { code: "VM_API_RESPONSE_INVALID" });
  }
});

test("bounds declared and streamed response bodies to two MiB", async () => {
  for (const result of [
    response({}, { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    new Response(`"${"x".repeat(2 * 1024 * 1024)}"`),
  ]) {
    const { client } = fixture([result]);
    await assert.rejects(client.getIdentity(), { code: "VM_API_RESPONSE_TOO_LARGE" });
  }
});

test("total timeout covers a stalled fetch and a stalled response stream", async () => {
  let signal;
  const stalledFetch = createVmApprovalClient({ token: TOKEN, timeoutMs: 15, fetchImpl: async (_, init) => {
    signal = init.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(stalledFetch.getIdentity(), { code: "VM_API_TIMEOUT" });
  assert.equal(signal.aborted, true);
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    cancel() { canceled = true; },
  });
  const { client } = fixture([new Response(stream)], { timeoutMs: 15 });
  await assert.rejects(client.getIdentity(), { code: "VM_API_TIMEOUT" });
  assert.equal(canceled, true);
  assert.equal(stream.locked, false);
});
