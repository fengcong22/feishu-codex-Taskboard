import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBitableRecordChanged } from "../src/feishu-event.mjs";

const table = {
  baseToken: "IQWTbOrdwa8GLgsXF3OcLwoUnqe",
  tableId: "tbl0hb8d1LgVWShb",
  name: "高中历史",
  triggerField: "视频整体进度",
  triggerFieldId: "fld2QXgFUT",
  triggerValue: "待剪辑",
  packageField: null,
  packageFieldId: null,
  defaultPackageAlias: "Auto-cut-copyA",
};

function rawEvent(overrides = {}) {
  return {
    schema: "2.0",
    header: {
      event_id: "evt_real_1",
      event_type: "drive.file.bitable_record_changed_v1",
    },
    event: {
      file_token: table.baseToken,
      action_list: [{
        record_id: "rec_1",
        action: "record_edited",
        before_value: [
          { field_id: "fld2QXgFUT", field_value: JSON.stringify("PPT定稿") },
          { field_id: "fld_other", field_value: JSON.stringify("旧值") },
        ],
        after_value: [
          { field_id: "fld2QXgFUT", field_value: JSON.stringify("待剪辑") },
          { field_id: "fld_other", field_value: JSON.stringify("新值") },
        ],
      }],
    },
    ...overrides,
  };
}

test("normalizes a Feishu record-change payload by field id and preserves the table default package", () => {
  const [event] = normalizeBitableRecordChanged(rawEvent(), table);
  assert.deepEqual(event, {
    eventId: "evt_real_1",
    baseToken: table.baseToken,
    tableId: table.tableId,
    recordId: "rec_1",
    recordTitle: "",
    action: "record_edited",
    fieldId: "fld2QXgFUT",
    fieldName: "视频整体进度",
    beforeValue: "PPT定稿",
    afterValue: "待剪辑",
    fields: {},
    fieldValuesById: {
      fld2QXgFUT: "待剪辑",
      fld_other: "新值",
    },
  });
});

test("normalizes every record in a batched action with a stable per-record event id", () => {
  const payload = rawEvent();
  payload.event.action_list.push({
    record_id: "rec_2",
    action: "record_edited",
    before_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待审核") }],
    after_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待剪辑") }],
  });
  const events = normalizeBitableRecordChanged(payload, table);
  assert.equal(events.length, 2);
  assert.match(events[0].eventId, /^evt_real_1:tbl0hb8d1LgVWShb:rec_1:/);
  assert.match(events[1].eventId, /^evt_real_1:tbl0hb8d1LgVWShb:rec_2:/);
  assert.equal(events[1].recordId, "rec_2");
});

test("does not turn a deleted record into a work item", () => {
  const payload = rawEvent();
  payload.event.action_list[0].action = "record_deleted";
  assert.deepEqual(normalizeBitableRecordChanged(payload, table), []);
});

test("accepts a table id carried on an individual action", () => {
  const payload = rawEvent();
  delete payload.event.table_id;
  payload.event.action_list[0].table_id = table.tableId;
  const [event] = normalizeBitableRecordChanged(payload, table);
  assert.equal(event.tableId, table.tableId);
});

test("maps an option id-only trigger value to the configured label", () => {
  const optionTable = { ...table, triggerOptionId: "opt_ready" };
  const payload = rawEvent();
  payload.event.action_list[0].before_value[0].field_value = JSON.stringify("opt_previous");
  payload.event.action_list[0].after_value[0].field_value = JSON.stringify("opt_ready");
  const [event] = normalizeBitableRecordChanged(payload, optionTable);
  assert.equal(event.beforeValue, "opt_previous");
  assert.equal(event.afterValue, "待剪辑");
});

test("maps an array-encoded option id to the configured label", () => {
  const optionTable = { ...table, triggerOptionId: "opt_ready" };
  const payload = rawEvent();
  payload.event.action_list[0].before_value[0].field_value = JSON.stringify(["opt_previous"]);
  payload.event.action_list[0].after_value[0].field_value = JSON.stringify(["opt_ready"]);
  const [event] = normalizeBitableRecordChanged(payload, optionTable);
  assert.equal(event.beforeValue, "opt_previous");
  assert.equal(event.afterValue, "待剪辑");
});

test("keeps same-record actions distinct within one callback", () => {
  const payload = rawEvent();
  payload.event.action_list.push({
    record_id: "rec_1",
    action: "record_edited",
    before_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待审核") }],
    after_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待剪辑") }],
  });
  const events = normalizeBitableRecordChanged(payload, table);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].eventId, events[1].eventId);
});

test("uses the changed payload in fallback event ids", () => {
  const first = rawEvent();
  delete first.header.event_id;
  const second = rawEvent();
  delete second.header.event_id;
  second.event.action_list[0].before_value[0].field_value = JSON.stringify("已剪辑");
  const [firstEvent] = normalizeBitableRecordChanged(first, table);
  const [secondEvent] = normalizeBitableRecordChanged(second, table);
  assert.notEqual(firstEvent.eventId, secondEvent.eventId);
});

test("reuses the same fallback event id when a headerless payload is replayed", () => {
  const payload = rawEvent();
  delete payload.header.event_id;
  const [firstEvent] = normalizeBitableRecordChanged(payload, table);
  const [secondEvent] = normalizeBitableRecordChanged(payload, table);
  assert.equal(firstEvent.eventId, secondEvent.eventId);
});

test("keeps batched event ids stable when action order changes", () => {
  const first = rawEvent();
  first.event.action_list.push({
    record_id: "rec_2",
    action: "record_edited",
    before_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待审核") }],
    after_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待剪辑") }],
  });
  const second = rawEvent();
  second.event.action_list = [...first.event.action_list].reverse();
  const firstIds = new Map(normalizeBitableRecordChanged(first, table).map((event) => [event.recordId, event.eventId]));
  const secondIds = new Map(normalizeBitableRecordChanged(second, table).map((event) => [event.recordId, event.eventId]));
  assert.deepEqual(secondIds, firstIds);
});

test("filters actions from other tables in a mixed batch", () => {
  const payload = rawEvent();
  payload.event.action_list[0].table_id = "tbl_other";
  payload.event.action_list.push({
    table_id: table.tableId,
    record_id: "rec_2",
    action: "record_edited",
    before_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待审核") }],
    after_value: [{ field_id: "fld2QXgFUT", field_value: JSON.stringify("待剪辑") }],
  });
  const events = normalizeBitableRecordChanged(payload, table);
  assert.deepEqual(events.map((event) => event.recordId), ["rec_2"]);
});
