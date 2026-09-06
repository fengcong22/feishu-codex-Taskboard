import assert from "node:assert/strict";
import test from "node:test";

import { BITABLE_RECORD_CHANGED_EVENT, createFeishuWsListener } from "../src/feishu-ws.mjs";

const table = {
  baseToken: "bas_demo",
  tableId: "tbl_demo",
  triggerField: "视频整体进度",
  triggerFieldId: "fld_trigger",
  triggerValue: "待剪辑",
  packageField: null,
  packageFieldId: null,
  defaultPackageAlias: "Auto-cut-copyA",
};

function payload() {
  return {
    header: { event_id: "evt_ws" },
    event: {
      file_token: "bas_demo",
      table_id: "tbl_demo",
      action_list: [{
        record_id: "rec_ws",
        action: "record_edited",
        before_value: [{ field_id: "fld_trigger", field_value: JSON.stringify("PPT定稿") }],
        after_value: [{ field_id: "fld_trigger", field_value: JSON.stringify("待剪辑") }],
      }],
    },
  };
}

function fakeSdk() {
  class EventDispatcher {
    constructor(options) {
      this.options = options;
      this.handlers = {};
    }

    register(handlers) {
      this.handlers = handlers;
      return this;
    }
  }

  class WSClient {
    constructor(options) {
      this.options = options;
      this.startedWith = null;
      this.stopped = false;
    }

    start(options) {
      this.startedWith = options;
      return Promise.resolve();
    }

    stop() {
      this.stopped = true;
    }
  }

  return { EventDispatcher, WSClient };
}

test("starts one SDK-managed reconnecting client without claiming socket confirmation", async () => {
  const sdk = fakeSdk();
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk,
    handleEvent: async () => {},
  });

  await listener.start();
  assert.equal(listener.wsClient.options.autoReconnect, true);
  assert.equal(listener.health.state, "sdk_managed");
  assert.equal(listener.health.lastEventAt, null);
  assert.equal(listener.health.lastError, null);
  await listener.start();
  assert.equal(listener.health.state, "sdk_managed");
});

test("records activity when a normalized event is accepted", async () => {
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk: fakeSdk(),
    handleEvent: async () => {},
  });

  await listener.start();
  const before = Date.now();
  await listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT](payload());
  await listener.drain();
  const activityAt = listener.health.lastEventAt;
  assert.equal(typeof activityAt, "number");
  assert.ok(activityAt >= before);
  assert.ok(activityAt <= Date.now());
  assert.equal(listener.health.state, "sdk_managed");
});

test("records a safe callback failure summary without exposing the raw error", async () => {
  const expected = Object.assign(new Error("secret token should not be logged"), {
    code: "TASKBOARD_UNAVAILABLE",
  });
  const logs = [];
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk: fakeSdk(),
    logger: { error: (...args) => logs.push(args) },
    handleEvent: async () => { throw expected; },
  });

  await listener.start();
  const callback = listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT];
  await assert.rejects(callback(payload()), expected);
  assert.equal(listener.health.state, "sdk_managed");
  assert.equal(listener.health.lastError.code, "TASKBOARD_UNAVAILABLE");
  assert.equal(typeof listener.health.lastError.at, "number");
  assert.equal("message" in listener.health.lastError, false);
  assert.equal(JSON.stringify(logs).includes(expected.message), false);
});

test("maps unknown callback error codes to a listener-owned code", async () => {
  const expected = Object.assign(new Error("do not expose"), {
    code: "fake-app-secret-do-not-log",
  });
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk: fakeSdk(),
    logger: { error() {} },
    handleEvent: async () => { throw expected; },
  });
  await listener.start();
  await assert.rejects(
    listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT](payload()),
    expected,
  );
  assert.equal(listener.health.lastError.code, "FEISHU_EVENT_HANDLER_FAILED");
});

test("does not claim stopped when the SDK exposes no public stop method", async () => {
  const sdk = fakeSdk();
  delete sdk.WSClient.prototype.stop;
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk,
    handleEvent: async () => {},
  });

  await listener.start();
  await listener.stop();
  assert.equal(listener.health.state, "sdk_managed");
});

test("allows a pending start to finish when the SDK exposes no stop method", async () => {
  let resolveStart;
  const sdk = fakeSdk();
  delete sdk.WSClient.prototype.stop;
  sdk.WSClient.prototype.start = function start() {
    return new Promise((resolve) => { resolveStart = resolve; });
  };
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk,
    handleEvent: async () => {},
  });

  const starting = listener.start();
  await listener.stop();
  resolveStart();
  await starting;

  assert.equal(listener.health.state, "sdk_managed");
});

test("does not let a pending start overwrite stopped health", async () => {
  let resolveStart;
  const sdk = fakeSdk();
  sdk.WSClient.prototype.start = function start() {
    this.startedWith = arguments[0];
    return new Promise((resolve) => { resolveStart = resolve; });
  };
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk,
    handleEvent: async () => {},
  });
  const starting = listener.start();
  const stopping = listener.stop();
  await stopping;
  assert.equal(listener.health.state, "stopped");
  resolveStart();
  await starting;
  await stopping;
  assert.equal(listener.health.state, "stopped");
});

test("does not publish sdk_managed when start resolves during an in-progress stop", async () => {
  let resolveStart;
  let resolveStop;
  let markStopStarted;
  const stopStarted = new Promise((resolve) => { markStopStarted = resolve; });
  const statuses = [];
  const sdk = fakeSdk();
  sdk.WSClient.prototype.start = function start() {
    return new Promise((resolve) => { resolveStart = resolve; });
  };
  sdk.WSClient.prototype.stop = function stop() {
    markStopStarted();
    return new Promise((resolve) => { resolveStop = resolve; });
  };
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk,
    onStatus: (status) => statuses.push(status),
    handleEvent: async () => {},
  });

  const starting = listener.start();
  const stopping = listener.stop();
  await stopStarted;
  resolveStart();
  await starting;

  assert.notEqual(listener.health.state, "sdk_managed");
  assert.equal(statuses.includes("sdk_managed"), false);

  resolveStop();
  await stopping;
  assert.equal(listener.health.state, "stopped");
});

test("does not publish an error when start rejects after stop intent", async () => {
  let rejectStart;
  let resolveStop;
  let markStopStarted;
  const stopStarted = new Promise((resolve) => { markStopStarted = resolve; });
  const statuses = [];
  const expected = new Error("late start rejection");
  const sdk = fakeSdk();
  sdk.WSClient.prototype.start = function start() {
    return new Promise((_resolve, reject) => { rejectStart = reject; });
  };
  sdk.WSClient.prototype.stop = function stop() {
    markStopStarted();
    return new Promise((resolve) => { resolveStop = resolve; });
  };
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk,
    onStatus: (status) => statuses.push(status),
    handleEvent: async () => {},
  });

  const starting = listener.start();
  const rejected = assert.rejects(starting, expected);
  const stopping = listener.stop();
  await stopStarted;
  rejectStart(expected);
  await rejected;

  assert.notEqual(listener.health.state, "error");
  assert.equal(listener.health.lastError, null);
  assert.equal(statuses.includes("error"), false);

  resolveStop();
  await stopping;
  assert.equal(listener.health.state, "stopped");
});

test("registers the bitable event and forwards normalized records through a non-blocking queue", async () => {
  const received = [];
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk: fakeSdk(),
    handleEvent: async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      received.push(event);
    },
  });

  assert.ok(listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT]);
  await listener.start();
  await listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT](payload());
  await listener.drain();
  assert.equal(received.length, 1);
  assert.equal(received[0].recordId, "rec_ws");
  assert.equal(received[0].afterValue, "待剪辑");
  await listener.stop();
  assert.equal(listener.state, "stopped");
});

test("rejects missing application credentials before constructing a client", () => {
  assert.throws(() => createFeishuWsListener({
    appId: "",
    appSecret: "secret_test",
    tables: [table],
    sdk: fakeSdk(),
    handleEvent: async () => {},
  }), /FEISHU_APP_ID/);
});

test("loads tables from a dynamic workflow provider", async () => {
  const received = [];
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    getTables: async () => [table],
    sdk: fakeSdk(),
    handleEvent: async (event) => received.push(event),
  });
  await listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT](payload());
  await listener.drain();
  assert.equal(received.length, 1);
  assert.equal(received[0].recordId, "rec_ws");
});

test("matches a payload whose table id is attached to the action", async () => {
  const received = [];
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk: fakeSdk(),
    handleEvent: async (event) => received.push(event),
  });
  const value = payload();
  delete value.event.table_id;
  value.event.action_list[0].table_id = table.tableId;
  await listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT](value);
  await listener.drain();
  assert.equal(received.length, 1);
});

test("returns a callback promise that waits for queued work and propagates failures", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const expected = new Error("handler failed");
  const statuses = [];
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk: fakeSdk(),
    logger: { error() {} },
    onStatus: (status, error) => statuses.push([status, error]),
    handleEvent: async () => {
      await gate;
      throw expected;
    },
  });

  const callback = listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT];
  const pending = callback(payload());
  assert.equal(typeof pending?.then, "function");
  release();
  await assert.rejects(pending, expected);
  assert.equal(statuses.at(-1)?.[0], "error");
  assert.deepEqual(Object.keys(statuses.at(-1)?.[1] ?? {}).sort(), ["at", "code"]);
  assert.equal(statuses.at(-1)?.[1]?.code, "FEISHU_EVENT_HANDLER_FAILED");
});

test("drains queued work before stopping the WebSocket client", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sdk = fakeSdk();
  const listener = createFeishuWsListener({
    appId: "cli_test",
    appSecret: "secret_test",
    tables: [table],
    sdk,
    handleEvent: async () => gate,
  });

  const callback = listener.eventDispatcher.handlers[BITABLE_RECORD_CHANGED_EVENT];
  const callbackPromise = callback(payload());
  const stopPromise = listener.stop();
  await Promise.resolve();
  assert.equal(listener.wsClient.stopped, false);
  release();
  await callbackPromise;
  await stopPromise;
  assert.equal(listener.wsClient.stopped, true);
  assert.equal(listener.state, "stopped");
});
