import assert from "node:assert/strict";
import test from "node:test";

import { createFeishuBaseSubscriptionClient } from "../src/feishu-base-subscription.mjs";

function fixture({ subscribed = false } = {}) {
  const calls = [];
  const client = {
    drive: {
      v1: {
        file: {
          async getSubscribe(request) {
            calls.push({ operation: "get", request });
            return { code: 0, data: { is_subscribe: subscribed } };
          },
          async subscribe(request) {
            calls.push({ operation: "subscribe", request });
            subscribed = true;
            return { code: 0, data: {} };
          },
          async deleteSubscribe(request) {
            calls.push({ operation: "unsubscribe", request });
            subscribed = false;
            return { code: 0, data: {} };
          },
        },
      },
    },
  };
  return { client, calls };
}

const sdkRequest = {
  path: { file_token: "bas_demo" },
  params: { file_type: "bitable" },
};

test("reads and verifies a Base event subscription after each mutation", async () => {
  const data = fixture();
  const subscriptions = createFeishuBaseSubscriptionClient({ client: data.client });

  assert.deepEqual(await subscriptions.get("bas_demo"), { subscribed: false });
  assert.deepEqual(await subscriptions.subscribe("bas_demo"), { subscribed: true });
  assert.deepEqual(await subscriptions.unsubscribe("bas_demo"), { subscribed: false });

  assert.deepEqual(data.calls, [
    { operation: "get", request: sdkRequest },
    { operation: "subscribe", request: sdkRequest },
    { operation: "get", request: sdkRequest },
    { operation: "unsubscribe", request: sdkRequest },
    { operation: "get", request: sdkRequest },
  ]);
});

test("rejects invalid Base tokens and malformed SDK results without exposing remote details", async () => {
  const data = fixture();
  const subscriptions = createFeishuBaseSubscriptionClient({ client: data.client });
  await assert.rejects(subscriptions.get("invalid/token"), { code: "INVALID_BASE_TOKEN", status: 400 });

  data.client.drive.v1.file.getSubscribe = async () => ({ code: 999, msg: "private remote detail" });
  const failedRead = createFeishuBaseSubscriptionClient({ client: data.client });
  await assert.rejects(failedRead.get("bas_demo"), { code: "FEISHU_SUBSCRIPTION_READ_FAILED", status: 502 });
});
