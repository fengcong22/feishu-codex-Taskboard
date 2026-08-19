import assert from "node:assert/strict";
import test from "node:test";

import { selectRecordTitle } from "../src/feishu-record-reader.mjs";

const table = {
  titleField: "视频名称",
  titleFieldId: "fld_title",
  fallbackTitleField: "集合文档",
  fallbackTitleFieldId: "fld_collection",
};

test("prefers 视频名称 over 集合文档", () => {
  assert.equal(selectRecordTitle({
    table,
    fieldValuesById: { fld_title: JSON.stringify("视频标题") },
    fieldsByName: { 集合文档: "集合标题" },
  }), "视频标题");
});

test("uses 集合文档 when 视频名称 is empty", () => {
  assert.equal(selectRecordTitle({
    table,
    fieldValuesById: { fld_title: "   " },
    fieldsByName: { 集合文档: { text: "集合标题" } },
  }), "集合标题");
});

test("uses 集合文档 when 视频名称 has an unsupported object shape", () => {
  assert.equal(selectRecordTitle({
    table,
    fieldValuesById: { fld_title: {} },
    fieldsByName: { 集合文档: "集合标题" },
  }), "集合标题");
});

test("ignores arrays containing only unsupported objects", () => {
  assert.equal(selectRecordTitle({
    table,
    fieldValuesById: { fld_title: [{ unknown: "不能作为标题" }] },
    fieldsByName: {},
  }), "");
});

test("returns an empty title when both configured fields are empty", () => {
  assert.equal(selectRecordTitle({
    table,
    fieldValuesById: { fld_title: "", fld_collection: JSON.stringify("") },
    fieldsByName: { 视频名称: null, 集合文档: "  " },
  }), "");
});

test("reads the current record through the official SDK client", async () => {
  const calls = [];
  const resolver = (await import("../src/feishu-record-reader.mjs")).createFeishuRecordTitleResolver({
    client: {
      bitable: { v1: { appTableRecord: { get: async (request) => {
        calls.push(request);
        return { code: 0, data: { record: { fields: { 视频名称: "当前视频" } } } };
      } } } },
    },
  });
  const title = await resolver({
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    recordId: "rec_demo",
    fieldValuesById: {},
  }, table);
  assert.equal(title, "当前视频");
  assert.deepEqual(calls, [{
    path: { app_token: "bas_demo", table_id: "tbl_demo", record_id: "rec_demo" },
  }]);
});

test("rejects a failed Feishu record response for the Bridge to handle", async () => {
  const resolver = (await import("../src/feishu-record-reader.mjs")).createFeishuRecordTitleResolver({
    client: {
      bitable: { v1: { appTableRecord: { get: async () => ({
        code: 1254043,
        msg: "RecordIdNotFound",
      }) } } },
    },
  });
  await assert.rejects(
    () => resolver({ baseToken: "bas", tableId: "tbl", recordId: "rec", fieldValuesById: {} }, table),
    /RecordIdNotFound/,
  );
});
