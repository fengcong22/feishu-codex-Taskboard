import assert from "node:assert/strict";
import { test } from "node:test";

import { isFetchSafePort, listenTaskboardOnFetchSafePort } from "./fetch-safe-listen.mjs";

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
