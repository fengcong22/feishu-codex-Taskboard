import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { copyApprovedVideo, downloadApprovedVideo, VmSourceError } from "../server/vm-source-transfer.mjs";

const ORIGIN = "https://media.example.test";
const SIGNED_URL = `${ORIGIN}/movie.mp4?signature=never-log-this-secret`;
const PUBLIC_IP = "93.184.216.34";
const PAYLOAD = Buffer.from("example media bytes");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-transfer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, destination: path.join(root, "source.mp4.part"), file: path.join(root, "approved.mp4") };
}

function network(responses = [{}], answers = [{ address: PUBLIC_IP, family: 4 }]) {
  const calls = [];
  const lookups = [];
  return {
    calls, lookups,
    async lookup(host, options) {
      lookups.push({ host, options });
      if (answers instanceof Error) throw answers;
      return answers;
    },
    request(url, options, callback) {
      const spec = responses[calls.length] ?? {};
      const req = new EventEmitter();
      let response;
      let destroyed = false;
      calls.push({ url, options });
      req.destroy = (error) => {
        if (destroyed) return;
        destroyed = true;
        if (error) req.emit("error", error);
        response?.destroy(error);
      };
      req.end = () => {
        queueMicrotask(() => {
          if (destroyed) return;
          if (spec.requestError) {
            const error = new Error(spec.requestError);
            if (spec.requestErrorCode) error.code = spec.requestErrorCode;
            req.emit("error", error);
            return;
          }
          if (spec.noResponse) return;
          response = new PassThrough();
          response.statusCode = spec.status ?? 200;
          response.headers = { "content-type": "video/mp4", ...spec.headers };
          response.complete = spec.complete ?? true;
          callback(response);
          if (spec.hang) return;
          if (spec.streamError) {
            response.write(spec.body ?? PAYLOAD);
            setImmediate(() => {
              const error = new Error(spec.streamError);
              if (spec.streamErrorCode) error.code = spec.streamErrorCode;
              response.destroy(error);
            });
          } else response.end(spec.body ?? PAYLOAD);
        });
      };
      return req;
    },
  };
}

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function download(destination, dependencies, overrides = {}) {
  return downloadApprovedVideo({ url: SIGNED_URL, allowedOrigins: [ORIGIN], destination, ...overrides }, dependencies);
}

test("downloads an approved file, hashes bytes and pins the fully checked DNS address", async (t) => {
  const { destination } = await fixture(t);
  const dependencies = network([{ headers: { "content-length": String(PAYLOAD.length) } }]);
  const result = await download(destination, dependencies);
  assert.deepEqual(result, { bytes: PAYLOAD.length, sha256: digest(PAYLOAD) });
  assert.deepEqual(await readFile(destination), PAYLOAD);
  assert.deepEqual(dependencies.lookups, [{ host: "media.example.test", options: { all: true, verbatim: true } }]);
  const options = dependencies.calls[0].options;
  assert.equal(options.agent, false);
  assert.equal(options.family, 4);
  assert.deepEqual(options.headers, { accept: "video/*, application/octet-stream" });
  const address = await new Promise((resolve, reject) => options.lookup("media.example.test", {}, (error, host, family) => {
    if (error) reject(error); else resolve({ host, family });
  }));
  assert.deepEqual(address, { host: PUBLIC_IP, family: 4 });
  const all = await new Promise((resolve, reject) => options.lookup("media.example.test", { all: true }, (error, entries) => {
    if (error) reject(error); else resolve(entries);
  }));
  assert.deepEqual(all, [{ address: PUBLIC_IP, family: 4 }]);
  assert.equal(dependencies.lookups.length, 1);
});

test("follows only allowlisted redirect origins and validates DNS again", async (t) => {
  const { destination } = await fixture(t);
  const dependencies = network([
    { status: 302, headers: { location: "https://cdn.example.test/approved.mp4?signature=private" } },
    {},
  ]);
  await download(destination, dependencies, { allowedOrigins: [ORIGIN, "https://cdn.example.test"] });
  assert.deepEqual(dependencies.lookups.map((item) => item.host), ["media.example.test", "cdn.example.test"]);
  assert.deepEqual(await readFile(destination), PAYLOAD);
});

test("rejects a redirect to an unlisted origin before resolving or requesting it", async (t) => {
  const { destination } = await fixture(t);
  const dependencies = network([{ status: 302, headers: { location: "https://other.example.test/file?signature=private" } }]);
  await assert.rejects(download(destination, dependencies), { code: "VM_SOURCE_URL_NOT_ALLOWED" });
  assert.equal(dependencies.calls.length, 1);
  assert.equal(dependencies.lookups.length, 1);
  assert.equal(await exists(destination), false);
});

test("allows three redirects but stops a fourth", async (t) => {
  const { root, destination } = await fixture(t);
  const redirect = { status: 307, headers: { location: "/next.mp4" } };
  const success = network([redirect, redirect, redirect, {}]);
  await download(destination, success);
  assert.equal(success.calls.length, 4);
  const refused = network([redirect, redirect, redirect, redirect]);
  const second = path.join(root, "second.part");
  await assert.rejects(download(second, refused), { code: "VM_SOURCE_REDIRECT_LIMIT" });
  assert.equal(refused.calls.length, 4);
  assert.equal(await exists(second), false);
});

for (const address of ["0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.2", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1"]) {
  test(`rejects nonpublic DNS address ${address} even alongside a public answer`, async (t) => {
    const { destination } = await fixture(t);
    const dependencies = network([], [{ address: PUBLIC_IP, family: 4 }, { address, family: address.includes(":") ? 6 : 4 }]);
    await assert.rejects(download(destination, dependencies), { code: "VM_SOURCE_ADDRESS_NOT_ALLOWED" });
    assert.equal(dependencies.calls.length, 0);
    assert.equal(await exists(destination), false);
  });
}

test("rejects literal private addresses without DNS and checks redirect addresses", async (t) => {
  const { destination } = await fixture(t);
  const dependencies = network();
  await assert.rejects(download(destination, dependencies, { url: "https://127.0.0.1/video", allowedOrigins: ["https://127.0.0.1"] }), { code: "VM_SOURCE_ADDRESS_NOT_ALLOWED" });
  assert.equal(dependencies.lookups.length, 0);
  const redirected = network([{ status: 301, headers: { location: "https://169.254.169.254/video" } }]);
  await assert.rejects(download(destination, redirected, { allowedOrigins: [ORIGIN, "https://169.254.169.254"] }), { code: "VM_SOURCE_ADDRESS_NOT_ALLOWED" });
  assert.equal(redirected.calls.length, 1);
});

test("permits a trusted local exact origin and RFC1918 address exception", async (t) => {
  const { destination } = await fixture(t);
  const origin = "https://vm-resource.yangcong345.com";
  const dependencies = network([{}], [{ address: "10.8.8.11", family: 4 }]);
  const result = await download(destination, dependencies, {
    url: `${origin}/approved.mp4?signature=private`,
    allowedOrigins: [origin],
    privateEndpoints: [{ origin, addresses: ["10.8.8.11"] }],
  });
  assert.deepEqual(result, { bytes: PAYLOAD.length, sha256: digest(PAYLOAD) });
  const pinned = await new Promise((resolve, reject) => dependencies.calls[0].options.lookup(
    "vm-resource.yangcong345.com", {}, (error, address) => error ? reject(error) : resolve(address),
  ));
  assert.equal(pinned, "10.8.8.11");
});

test("private endpoint exception requires the exact origin and every DNS address", async (t) => {
  const { destination } = await fixture(t);
  const origin = "https://vm-resource.yangcong345.com";
  const privateEndpoints = [{ origin, addresses: ["10.8.8.11"] }];
  for (const [url, answers] of [
    [`${ORIGIN}/video.mp4`, [{ address: "10.8.8.11", family: 4 }]],
    [`${origin}/video.mp4`, [{ address: "10.8.8.12", family: 4 }]],
    [`${origin}/video.mp4`, [{ address: "10.8.8.11", family: 4 }, { address: "10.8.8.12", family: 4 }]],
    [`${origin}:8443/video.mp4`, [{ address: "10.8.8.11", family: 4 }]],
  ]) {
    const dependencies = network([], answers);
    await assert.rejects(download(destination, dependencies, {
      url, allowedOrigins: [ORIGIN, origin, `${origin}:8443`], privateEndpoints,
    }), { code: "VM_SOURCE_ADDRESS_NOT_ALLOWED" });
    assert.equal(dependencies.calls.length, 0);
    assert.equal(await exists(destination), false);
  }
});

test("never permits private endpoint configuration to allow loopback or other reserved addresses", async (t) => {
  const { destination } = await fixture(t);
  for (const address of ["127.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "0.0.0.0", "::1"]) {
    const dependencies = network([], [{ address, family: address.includes(":") ? 6 : 4 }]);
    await assert.rejects(download(destination, dependencies, {
      privateEndpoints: [{ origin: ORIGIN, addresses: [address] }],
    }), { code: "VM_SOURCE_INPUT_INVALID" });
    assert.equal(dependencies.calls.length, 0);
  }
  await assert.rejects(download(destination, network(), {
    privateEndpoints: [{ origin: "https://not-allowlisted.example.test", addresses: ["10.8.8.11"] }],
  }), { code: "VM_SOURCE_INPUT_INVALID" });
});

test("rechecks private origin exceptions when following redirects", async (t) => {
  const { root, destination } = await fixture(t);
  const internal = "https://vm-resource.yangcong345.com";
  const dependencies = network([
    { status: 302, headers: { location: `${internal}/approved.mp4` } }, {},
  ]);
  dependencies.lookup = async (host) => [{ address: host === "vm-resource.yangcong345.com" ? "10.8.8.11" : PUBLIC_IP, family: 4 }];
  await download(destination, dependencies, {
    allowedOrigins: [ORIGIN, internal], privateEndpoints: [{ origin: internal, addresses: ["10.8.8.11"] }],
  });
  assert.equal(dependencies.calls.length, 2);
  const denied = network([{ status: 302, headers: { location: "https://different.example.test/approved.mp4" } }]);
  denied.lookup = async (host) => [{ address: host === "media.example.test" ? PUBLIC_IP : "10.8.8.11", family: 4 }];
  await assert.rejects(download(path.join(root, "denied.part"), denied, {
    allowedOrigins: [ORIGIN, internal, "https://different.example.test"],
    privateEndpoints: [{ origin: internal, addresses: ["10.8.8.11"] }],
  }), { code: "VM_SOURCE_ADDRESS_NOT_ALLOWED" });
  assert.equal(denied.calls.length, 1);
});

test("rejects HTTP, userinfo, URL fragments and an origin with a path", async (t) => {
  const { destination } = await fixture(t);
  for (const url of ["http://media.example.test/v", "https://user:secret@media.example.test/v", `${SIGNED_URL}#private`]) {
    await assert.rejects(download(destination, network(), { url }), { code: "VM_SOURCE_URL_NOT_ALLOWED" });
  }
  await assert.rejects(download(destination, network(), { allowedOrigins: [`${ORIGIN}/path`] }), { code: "VM_SOURCE_INPUT_INVALID" });
});

test("rejects non-200, HTML and JSON without creating files", async (t) => {
  const { destination } = await fixture(t);
  for (const [spec, code] of [
    [{ status: 403 }, "VM_SOURCE_HTTP_DENIED"],
    [{ status: 404 }, "VM_SOURCE_HTTP_NOT_FOUND"],
    [{ status: 503 }, "VM_SOURCE_HTTP_SERVER_FAILED"],
    [{ status: 206 }, "VM_SOURCE_HTTP_FAILED"],
    [{ headers: { "content-type": "text/html; charset=utf-8" } }, "VM_SOURCE_CONTENT_TYPE_INVALID"],
    [{ headers: { "content-type": "application/problem+json" } }, "VM_SOURCE_CONTENT_TYPE_INVALID"],
  ]) {
    await assert.rejects(download(destination, network([spec])), { code });
    assert.equal(await exists(destination), false);
  }
});

test("enforces declared and streaming size limits and removes partial files", async (t) => {
  const { destination } = await fixture(t);
  await assert.rejects(download(destination, network([{ headers: { "content-length": "1000" } }]), { maxBytes: 8 }), { code: "VM_SOURCE_TOO_LARGE" });
  assert.equal(await exists(destination), false);
  await assert.rejects(download(destination, network(), { maxBytes: 8 }), { code: "VM_SOURCE_TOO_LARGE" });
  assert.equal(await exists(destination), false);
});

test("rejects wrong content lengths, empty files and an incomplete stream", async (t) => {
  const { destination } = await fixture(t);
  for (const [spec, code] of [
    [{ headers: { "content-length": "999" } }, "VM_SOURCE_LENGTH_MISMATCH"],
    [{ headers: { "content-length": "1" } }, "VM_SOURCE_LENGTH_MISMATCH"],
    [{ headers: { "content-length": "NaN" } }, "VM_SOURCE_LENGTH_MISMATCH"],
    [{ body: Buffer.alloc(0) }, "VM_SOURCE_EMPTY"],
    [{ complete: false }, "VM_SOURCE_TRANSFER_FAILED"],
  ]) {
    await assert.rejects(download(destination, network([spec])), { code });
    assert.equal(await exists(destination), false);
  }
});

test("does not leak URLs, credentials or raw transport errors after a broken stream", async (t) => {
  const { destination } = await fixture(t);
  for (const dependencies of [
    network([{ streamError: `raw socket error for ${SIGNED_URL}` }]),
    network([{ requestError: `raw request error for ${SIGNED_URL}` }]),
    network([], new Error(`raw resolver error ${SIGNED_URL}`)),
  ]) {
    await assert.rejects(download(destination, dependencies), (error) => {
      assert.ok(error instanceof VmSourceError);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /signature|never-log|https:|raw socket|raw request|raw resolver/u);
      return true;
    });
    assert.equal(await exists(destination), false);
  }
});

test("classifies common network failures without exposing their raw messages", async (t) => {
  const { destination } = await fixture(t);
  for (const [dependencies, code] of [
    [network([{ requestError: `reset while fetching ${SIGNED_URL}`, requestErrorCode: "ECONNRESET" }]), "VM_SOURCE_CONNECTION_RESET"],
    [network([{ streamError: `reset while streaming ${SIGNED_URL}`, streamErrorCode: "ECONNRESET" }]), "VM_SOURCE_CONNECTION_RESET"],
    [network([{ requestError: `TLS failed for ${SIGNED_URL}`, requestErrorCode: "EPROTO" }]), "VM_SOURCE_TLS_FAILED"],
  ]) {
    await assert.rejects(download(destination, dependencies), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /signature|never-log|https:|reset while|TLS failed/u);
      return true;
    });
    assert.equal(await exists(destination), false);
  }
});

test("total timeout covers DNS, response headers and a stalled body", async (t) => {
  const { destination } = await fixture(t);
  const neverResolves = { ...network(), lookup: () => new Promise(() => {}) };
  for (const dependencies of [neverResolves, network([{ noResponse: true }]), network([{ hang: true }])]) {
    await assert.rejects(download(destination, dependencies, { timeoutMs: 25 }), { code: "VM_SOURCE_TIMEOUT" });
    assert.equal(await exists(destination), false);
  }
});

test("never overwrites or deletes an existing destination", async (t) => {
  const { destination, file } = await fixture(t);
  await writeFile(destination, "existing bytes");
  await writeFile(file, PAYLOAD);
  await assert.rejects(download(destination, network()), { code: "VM_SOURCE_DESTINATION_EXISTS" });
  await assert.rejects(copyApprovedVideo({ file, destination }), { code: "VM_SOURCE_DESTINATION_EXISTS" });
  assert.equal(await readFile(destination, "utf8"), "existing bytes");
  assert.deepEqual(await readFile(file), PAYLOAD);
});

test("failure cleanup preserves a different file moved into the temporary path", async (t) => {
  const { root, destination } = await fixture(t);
  const dependencies = network([{ hang: true }]);
  const originalRequest = dependencies.request;
  let incoming;
  dependencies.request = (url, options, callback) => originalRequest(url, options, (response) => {
    incoming = response;
    callback(response);
  });
  let replacement;
  const watcher = watch(root, (_event, filename) => {
    if (filename !== path.basename(destination) || replacement) return;
    replacement = (async () => {
      await rename(destination, path.join(root, "original.part"));
      await writeFile(destination, "different owner's file");
      incoming.destroy(new Error("disconnect after destination replacement"));
    })();
  });
  t.after(() => watcher.close());
  await assert.rejects(download(destination, dependencies, { timeoutMs: 3000 }), { code: "VM_SOURCE_TRANSFER_FAILED" });
  await replacement;
  assert.equal(await readFile(destination, "utf8"), "different owner's file");
});

test("copies an approved regular file without changing its content or metadata", async (t) => {
  const { destination, file } = await fixture(t);
  await writeFile(file, PAYLOAD);
  const before = await lstat(file, { bigint: true });
  const result = await copyApprovedVideo({ file, destination });
  assert.deepEqual(result, { bytes: PAYLOAD.length, sha256: digest(PAYLOAD) });
  assert.deepEqual(await readFile(destination), PAYLOAD);
  assert.deepEqual(await readFile(file), PAYLOAD);
  const after = await lstat(file, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
});

test("local copy rejects directories, empty sources and oversize sources", async (t) => {
  const { root, destination, file } = await fixture(t);
  await assert.rejects(copyApprovedVideo({ file: root, destination }), { code: "VM_SOURCE_FILE_INVALID" });
  await writeFile(file, Buffer.alloc(0));
  await assert.rejects(copyApprovedVideo({ file, destination }), { code: "VM_SOURCE_EMPTY" });
  assert.equal(await exists(destination), false);
  await writeFile(file, PAYLOAD);
  await assert.rejects(copyApprovedVideo({ file, destination, maxBytes: 1 }), { code: "VM_SOURCE_TOO_LARGE" });
  assert.equal(await exists(destination), false);
});

test("local copy rejects a source symlink", async (t) => {
  const { root, file, destination } = await fixture(t);
  await writeFile(file, PAYLOAD);
  const linked = path.join(root, "linked.mp4");
  try { await symlink(file, linked); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Creating file symlinks requires OS permission"); return; } throw error; }
  await assert.rejects(copyApprovedVideo({ file: linked, destination }), { code: "VM_SOURCE_FILE_INVALID" });
  assert.equal(await exists(destination), false);
});

test("local copy detects replacement of its source path while reading", async (t) => {
  const { root, file, destination } = await fixture(t);
  const sourceBytes = Buffer.alloc(8 * 1024 * 1024, 7);
  await writeFile(file, sourceBytes);
  let replacement;
  const watcher = watch(root, (_event, filename) => {
    if (filename !== path.basename(destination) || replacement) return;
    replacement = (async () => {
      await rename(file, path.join(root, "original.mp4"));
      await writeFile(file, "replacement");
    })();
  });
  t.after(() => watcher.close());
  await assert.rejects(copyApprovedVideo({ file, destination }), { code: "VM_SOURCE_FILE_CHANGED" });
  await replacement;
  assert.equal(await exists(destination), false);
  assert.equal(await readFile(file, "utf8"), "replacement");
  assert.deepEqual(await readFile(path.join(root, "original.mp4")), sourceBytes);
});
