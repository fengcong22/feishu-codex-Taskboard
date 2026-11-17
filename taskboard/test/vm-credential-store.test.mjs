import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createVmCredentialStore, windowsDpapi } from "../server/vm-credential-store.mjs";
import { openVmLoginPage } from "../server/vm-login-page.mjs";

const SESSION = { token: "header.payload.signature", userId: "user-1", authorizedAt: 1_800_000_000_000 };

// Reversible stand-in that still proves the file never holds the plain token.
const fakeProtection = { available: () => true,
  protect: async (bytes) => Buffer.from(bytes.toString("base64").split("").reverse().join("")),
  unprotect: async (bytes) => Buffer.from(bytes.toString().split("").reverse().join(""), "base64") };

async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), "vm-credential-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("the saved Shadow session is ciphertext on disk and round-trips for the same user", async (t) => {
  const file = path.join(await directory(t), "nested", "session.bin");
  const store = createVmCredentialStore({ file, protection: fakeProtection });
  assert.equal(await store.load(), null);
  assert.equal(await store.save(SESSION), true);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.includes(SESSION.token), false);
  assert.equal(raw.includes(SESSION.userId), false);
  assert.deepEqual(await store.load(), SESSION);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("unavailable protection never writes and damaged files are ignored", async (t) => {
  const folder = await directory(t);
  const file = path.join(folder, "session.bin");
  const unavailable = createVmCredentialStore({ file, protection: { ...fakeProtection, available: () => false } });
  assert.equal(await unavailable.save(SESSION), false);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  const store = createVmCredentialStore({ file, protection: fakeProtection });
  for (const content of ["not json", JSON.stringify({ version: 2, ciphertext: "x" }), JSON.stringify({ version: 1, ciphertext: "!!" })]) {
    await writeFile(file, content);
    assert.equal(await store.load(), null);
  }
  for (const value of [{ ...SESSION, token: "has space" }, { ...SESSION, userId: "../x" }, { ...SESSION, authorizedAt: 0 }]) {
    assert.equal(await store.save(value), false);
  }
  assert.throws(() => createVmCredentialStore({ file: "relative.bin", protection: fakeProtection }));
});

test("Windows DPAPI protects the session for the current user", { skip: process.platform !== "win32" }, async (t) => {
  const file = path.join(await directory(t), "session.bin");
  const store = createVmCredentialStore({ file, protection: windowsDpapi });
  assert.equal(await store.save(SESSION), true);
  assert.equal((await readFile(file, "utf8")).includes(SESSION.token), false);
  assert.deepEqual(await store.load(), SESSION);
});

test("only the fixed Shadow origin is opened in the default browser", async () => {
  const launched = [];
  const spawnProcess = (command, args) => {
    launched.push([command, ...args]);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const url = "https://shadow.yangcong345.com/#/?fromWebUrl=http%3A%2F%2F127.0.0.1%3A1%2Fvm-auth%2Fx";
  assert.equal(await openVmLoginPage(url, { platform: "win32", spawnProcess }), true);
  assert.deepEqual(launched, [["explorer.exe", url]]);
  for (const bad of ["https://evil.example/#/", "https://user:pass@shadow.yangcong345.com/", "file:///C:/x", "not a url"]) {
    assert.equal(await openVmLoginPage(bad, { platform: "win32", spawnProcess }), false);
  }
  assert.equal(launched.length, 1);
});

test("the file manager selects one stored file and never runs it", async () => {
  const { revealLocalFile } = await import("../server/local-file-reveal.mjs");
  const launched = [];
  const spawnProcess = (command, args, options) => {
    launched.push([command, args, options.windowsVerbatimArguments]);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const file = path.win32.join("E:\\", "VM 下载", "vm-x", "source.mp4");
  assert.equal(await revealLocalFile(file, { platform: "win32", spawnProcess }), true);
  assert.deepEqual(launched[0], ["explorer.exe", [`/select,"${file}"`], true]);
  for (const bad of ["relative.mp4", path.win32.join("E:\\", "a\"b.mp4"), path.win32.join("E:\\", "a\nb.mp4"), null]) {
    assert.equal(await revealLocalFile(bad, { platform: "win32", spawnProcess }), false);
  }
  assert.equal(launched.length, 1);
});
