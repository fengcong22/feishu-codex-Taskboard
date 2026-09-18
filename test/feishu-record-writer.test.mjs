import assert from "node:assert/strict";
import test from "node:test";

import { createFeishuRecordWriter } from "../src/feishu-record-writer.mjs";

function frozenIntent(operation) {
  return {
    target: {
      baseToken: "bas_delivery",
      tableId: "tbl_courses",
      recordId: "rec_001",
    },
    operation,
  };
}

function writerFixture({ fields, recordFields }) {
  const calls = [];
  const client = {
    bitable: { v1: {
      appTableField: {
        list: async (request) => {
          calls.push(["fields", request]);
          return { code: 0, data: { items: fields } };
        },
      },
      appTableRecord: {
        get: async (request) => {
          calls.push(["get", request]);
          return { code: 0, data: { record: { fields: recordFields } } };
        },
        update: async (request) => {
          calls.push(["update", request]);
          return { code: 0, data: { record: { fields: request.data.fields } } };
        },
      },
    } },
  };
  return { writer: createFeishuRecordWriter({ client }), calls };
}

test("writes a frozen single-select option by stable field and option IDs", async () => {
  const { writer, calls } = writerFixture({
    fields: [{
      field_id: "fld_status",
      field_name: "当前状态",
      type: 3,
      ui_type: "SingleSelect",
      property: { options: [{ id: "opt_auto_cutting", name: "自动剪辑中" }] },
    }],
    recordFields: { fld_status: "待剪辑" },
  });

  const result = await writer.apply(frozenIntent({
    type: "single_select",
    fieldId: "fld_status",
    optionId: "opt_auto_cutting",
  }));

  assert.deepEqual(result, { outcome: "updated" });
  assert.deepEqual(calls, [
    ["fields", { path: { app_token: "bas_delivery", table_id: "tbl_courses" } }],
    ["get", {
      path: { app_token: "bas_delivery", table_id: "tbl_courses", record_id: "rec_001" },
      params: { text_field_as_array: true },
    }],
    ["update", {
      path: { app_token: "bas_delivery", table_id: "tbl_courses", record_id: "rec_001" },
      data: { fields: { 当前状态: "自动剪辑中" } },
    }],
  ]);
});

test("does not update a single-select field that already has the frozen option", async () => {
  const { writer, calls } = writerFixture({
    fields: [{
      field_id: "fld_status",
      field_name: "当前状态",
      type: 3,
      ui_type: "SingleSelect",
      property: { options: [{ id: "opt_auto_cutting", name: "自动剪辑中" }] },
    }],
    recordFields: { fld_status: [{ option_id: "opt_auto_cutting" }] },
  });

  const result = await writer.apply(frozenIntent({
    type: "single_select",
    fieldId: "fld_status",
    optionId: "opt_auto_cutting",
  }));

  assert.deepEqual(result, { outcome: "already_applied" });
  assert.equal(calls.some(([name]) => name === "update"), false);
});

test("writes field and single-select display names exactly as returned by Feishu metadata", async () => {
  const { writer, calls } = writerFixture({
    fields: [{
      field_id: "fld_spaced_status",
      field_name: "  当前状态  ",
      type: 3,
      ui_type: "SingleSelect",
      property: { options: [{ id: "opt_spaced", name: "  自动剪辑中  " }] },
    }],
    recordFields: { "  当前状态  ": "待剪辑" },
  });

  await writer.apply(frozenIntent({
    type: "single_select",
    fieldId: "fld_spaced_status",
    optionId: "opt_spaced",
  }));

  assert.deepEqual(calls.at(-1), ["update", {
    path: { app_token: "bas_delivery", table_id: "tbl_courses", record_id: "rec_001" },
    data: { fields: { "  当前状态  ": "  自动剪辑中  " } },
  }]);
});

test("rejects a frozen select write when the existing option or field changed", async () => {
  const { writer, calls } = writerFixture({
    fields: [{
      field_id: "fld_status",
      field_name: "当前状态",
      type: 3,
      ui_type: "SingleSelect",
      property: { options: [{ id: "opt_complete", name: "已完成" }] },
    }],
    recordFields: { fld_status: "待剪辑" },
  });

  await assert.rejects(
    () => writer.apply(frozenIntent({
      type: "single_select",
      fieldId: "fld_status",
      optionId: "opt_auto_cutting",
    })),
    (error) => error.code === "FIELD_OPTION_CHANGED" && error.status === 409,
  );
  assert.equal(calls.some(([name]) => name === "get" || name === "update"), false);
});

test("writes and idempotently recognizes a frozen text value on a writable text field", async () => {
  const targetValue = "学科实拍素材临时传输\\【--剪映草稿--】\\课程001";
  const fields = [{
    field_id: "fld_course_path",
    field_name: "交付路径",
    type: 1,
    ui_type: "Text",
    property: { options: [] },
  }];
  const first = writerFixture({ fields, recordFields: { fld_course_path: [] } });
  assert.deepEqual(await first.writer.apply(frozenIntent({
    type: "text",
    fieldId: "fld_course_path",
    value: targetValue,
  })), { outcome: "updated" });
  assert.deepEqual(first.calls.at(-1), ["update", {
    path: { app_token: "bas_delivery", table_id: "tbl_courses", record_id: "rec_001" },
    data: { fields: { 交付路径: targetValue } },
  }]);

  const second = writerFixture({
    fields,
    recordFields: { fld_course_path: [{ type: "text", text: targetValue }] },
  });
  assert.deepEqual(await second.writer.apply(frozenIntent({
    type: "text",
    fieldId: "fld_course_path",
    value: targetValue,
  })), { outcome: "already_applied" });
  assert.equal(second.calls.some(([name]) => name === "update"), false);
});

test("rejects text writes to fields that are no longer writable text", async () => {
  const { writer } = writerFixture({
    fields: [{
      field_id: "fld_course_path",
      field_name: "交付路径",
      type: 20,
      ui_type: "Formula",
      property: { options: [] },
    }],
    recordFields: { fld_course_path: "旧值" },
  });

  await assert.rejects(
    () => writer.apply(frozenIntent({
      type: "text",
      fieldId: "fld_course_path",
      value: "课程001",
    })),
    (error) => error.code === "FIELD_NOT_WRITABLE" && error.status === 409,
  );
});
