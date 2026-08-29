import assert from "node:assert/strict";
import test from "node:test";

import { createFeishuApiContext } from "../src/feishu-api.mjs";

test("prepares a read-only Feishu API client when the listener is disabled", async () => {
  let loadCount = 0;
  let clientOptions;
  const metadataReader = { preview: async () => ({ baseToken: "bas_demo" }) };
  class Client {
    constructor(options) {
      clientOptions = options;
    }
  }
  const context = await createFeishuApiContext({
    appId: "cli_demo",
    appSecret: "secret_demo",
    listenerEnabled: false,
    loadSdk: async () => {
      loadCount += 1;
      return {
        Client,
        WSClient: class WSClient {
          constructor() {
            throw new Error("listener client must not be constructed for a preview");
          }
        },
      };
    },
    createMetadataReader: ({ client }) => {
      assert.ok(client instanceof Client);
      return metadataReader;
    },
  });

  assert.equal(loadCount, 1);
  assert.equal(clientOptions.appId, "cli_demo");
  assert.equal(clientOptions.appSecret, "secret_demo");
  assert.ok(clientOptions.logger);
  assert.equal(context.metadataReader, metadataReader);
});

test("installs a non-emitting SDK logger before metadata requests can expose credentials", async () => {
  const syntheticSecret = "synthetic-secret-for-sdk-logger-test";
  const syntheticWikiToken = "wik_synthetic_private";
  const logged = [];
  let clientOptions;
  class Client {
    constructor(options) {
      clientOptions = options;
      const logger = options.logger ?? {
        error: (...messages) => logged.push(messages),
      };
      logger.error({
        config: {
          data: { app_secret: syntheticSecret },
          params: { token: syntheticWikiToken },
        },
      });
    }
  }

  await createFeishuApiContext({
    appId: "cli_demo",
    appSecret: syntheticSecret,
    loadSdk: async () => ({ Client }),
    createMetadataReader: () => ({ preview: async () => null }),
  });

  assert.equal(logged.length, 0);
  assert.ok(clientOptions.logger);
  for (const level of ["error", "warn", "info", "debug", "trace"]) {
    clientOptions.logger[level]({ app_secret: syntheticSecret, token: syntheticWikiToken });
  }
  assert.equal(logged.length, 0);
});

test("does not load the SDK when preview credentials are incomplete and the listener is disabled", async () => {
  let loadCount = 0;
  const context = await createFeishuApiContext({
    appId: "cli_demo",
    appSecret: "",
    listenerEnabled: false,
    loadSdk: async () => {
      loadCount += 1;
      throw new Error("SDK should not be loaded");
    },
  });

  assert.equal(loadCount, 0);
  assert.equal(context.metadataReader, null);
  assert.equal(context.client, null);
});
