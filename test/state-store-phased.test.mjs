import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonStateStore } from "../src/state-store.mjs";

test("persists the immutable phased decision and controlled context before registration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-state-"));
  const store = new JsonStateStore(path.join(dir, "state.json"));
  const event = {
    eventId: "evt-phased",
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
    fieldName: "制作进度",
    statusFieldId: "fld_status",
    beforePresent: true,
    afterPresent: true,
    beforeOptionId: "opt_other",
    afterOptionId: "opt_initial",
    beforeValue: "待准备",
    afterValue: "待初稿",
    fields: {},
  };
  const claim = await store.claimEvent(event, { ownerId: "bridge", now: 1, leaseMs: 1000 });
  const saved = await store.saveDecisionSnapshot("evt-phased", {
    ownerId: "bridge",
    token: claim.record.lease.token,
    snapshot: {
      version: 1,
      action: "register",
      kind: "register",
      subjectKey: "bas_demo:tbl_math",
      configVersion: 7,
      stageId: "initial",
      eventOccurredAt: 1,
      beforeOptionId: "opt_other",
      afterOptionId: "opt_initial",
      controlledContext: { documentLinks: [], namingDisplayValue: "", namingValueUnique: false },
    },
    now: 1,
  });
  assert.equal(saved.decisionSnapshot.stageId, "initial");
  const reloaded = new JsonStateStore(path.join(dir, "state.json"));
  assert.equal((await reloaded.get("evt-phased")).decisionSnapshot.configVersion, 7);
});
