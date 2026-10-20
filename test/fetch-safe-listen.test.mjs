import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { isFetchSafePort, listenOnFetchSafePort, listenTaskboardOnFetchSafePort } from "./fetch-safe-listen.mjs";

test("identifies Fetch-blocked dynamic ports before test fixtures publish a URL", () => {
  assert.equal(isFetchSafePort(2049), false);
  assert.equal(isFetchSafePort(5060), false);
  assert.equal(isFetchSafePort(6000), false);
  assert.equal(isFetchSafePort(6667), false);
  assert.equal(isFetchSafePort(10080), false);
  assert.equal(isFetchSafePort(47823), true);
});

test("retries a conflicting Taskboard port without selecting a Fetch-blocked port", async () => {
  const calls = [];
  const app = {
    async listen({ host, port }) {
      calls.push({ host, port });
      if (calls.length === 1) {
        const error = new Error("Address in use");
        error.code = "EADDRINUSE";
        throw error;
      }
      return { address: host, port };
    },
  };

  const address = await listenTaskboardOnFetchSafePort(app, {
    random: () => 0,
    maxAttempts: 2,
  });

  assert.deepEqual(address, { address: "127.0.0.1", port: 10081 });
  assert.deepEqual(calls, [
    { host: "127.0.0.1", port: 10081 },
    { host: "127.0.0.1", port: 10081 },
  ]);
});

test("keeps Taskboard test listeners below the Windows dynamic port range", async () => {
  let selectedPort = null;
  const app = {
    async listen({ host, port }) {
      selectedPort = port;
      return { address: host, port };
    },
  };

  await listenTaskboardOnFetchSafePort(app, { random: () => 0.999999 });

  assert.ok(selectedPort >= 10_081 && selectedPort <= 49_151);
});

test("retries a Taskboard test port denied by Windows", async () => {
  const calls = [];
  const randomValues = [0, 0.5];
  const app = {
    async listen({ host, port }) {
      calls.push({ host, port });
      if (calls.length === 1) {
        const error = new Error("Permission denied");
        error.code = "EACCES";
        throw error;
      }
      return { address: host, port };
    },
  };

  const address = await listenTaskboardOnFetchSafePort(app, {
    random: () => randomValues.shift() ?? 0,
    maxAttempts: 2,
  });

  assert.equal(address.port, calls[1].port);
  assert.notEqual(calls[0].port, calls[1].port);
});

test("binds raw HTTP fixtures outside the Windows dynamic port range", async () => {
  const server = createServer();
  try {
    const address = await listenOnFetchSafePort(server, { random: () => 0.999999 });

    assert.ok(address.port >= 10_081 && address.port <= 49_151);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
