import assert from "node:assert/strict";
import test from "node:test";

import {
  createFeishuControlledContextReader,
  normalizeCourseNameValue,
  selectRecordTitle,
} from "../src/feishu-record-reader.mjs";

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

test("normalizes a single text element as a course name", () => {
  assert.equal(
    normalizeCourseNameValue([{ type: "text", text: "课程001" }], { type: 1, uiType: "Text" }),
    "课程001",
  );
});

test("normalizes a direct text-field string as a course name", () => {
  assert.equal(
    normalizeCourseNameValue("课程001", { type: 1, uiType: "Text" }),
    "课程001",
  );
});

test("accepts direct or structured textual formula results as a course name", () => {
  assert.equal(
    normalizeCourseNameValue("课程公式001", { type: 20, uiType: "Formula" }),
    "课程公式001",
  );

  assert.equal(
    normalizeCourseNameValue([{ type: "text", text: "课程公式001" }], { type: 20, uiType: "Formula" }),
    "课程公式001",
  );

  for (const value of [
    123,
    { error: "#ERROR!" },
    [{ type: "text", text: "#ERROR!" }],
    [{ type: "text", text: " " }],
    [{ type: "text", text: "../课程公式001" }],
    [{ type: "text", text: "课程公式001" }, { type: "text", text: "课程公式002" }],
  ]) {
    assert.throws(
      () => normalizeCourseNameValue(value, { type: 20, uiType: "Formula" }),
      (error) => ["COURSE_NAME_NOT_TEXT", "COURSE_NAME_EMPTY", "COURSE_NAME_INVALID"].includes(error.code),
    );
  }
});

test("blocks empty and path-like course names", () => {
  assert.throws(
    () => normalizeCourseNameValue([{ type: "text", text: "  " }], { type: 1, uiType: "Text" }),
    (error) => error.code === "COURSE_NAME_EMPTY",
  );
  assert.throws(
    () => normalizeCourseNameValue([{ type: "text", text: "../课程001" }], { type: 1, uiType: "Text" }),
    (error) => error.code === "COURSE_NAME_INVALID",
  );
});

test("reads a configured formula course-name field by stable field ID", async () => {
  const calls = [];
  const reader = createFeishuControlledContextReader({
    client: {
      bitable: { v1: { appTableRecord: { get: async (request) => {
        calls.push(request);
        return {
          code: 0,
          data: {
            record: {
              fields: {
                fld_course_formula: "课程公式001",
                fld_legacy_name: [{ type: "text", text: "旧 ZIP 命名" }],
              },
            },
          },
        };
      } } } },
    },
  });

  const result = await reader.read({
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    namingField: { fieldId: "fld_legacy_name", fieldName: "旧命名", type: 1, uiType: "Text" },
    metadata: {
      fields: [{
        fieldId: "fld_course_formula",
        fieldName: "课程名称已改名",
        type: 20,
        uiType: "Formula",
        options: [],
      }],
    },
    delivery: { courseNaming: { mode: "field", fieldId: "fld_course_formula" } },
  }, {
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    recordId: "rec_demo",
  });

  assert.deepEqual(result, {
    documentLinks: [],
    namingDisplayValue: "旧 ZIP 命名",
    namingValueUnique: false,
    courseName: "课程公式001",
  });
  assert.deepEqual(calls, [{
    path: { app_token: "bas_demo", table_id: "tbl_demo", record_id: "rec_demo" },
    params: { text_field_as_array: true },
  }]);
});

test("reads a course-name field descriptor carried by the synchronized workflow", async () => {
  const reader = createFeishuControlledContextReader({
    client: {
      bitable: { v1: { appTableRecord: { get: async () => ({
        code: 0,
        data: { record: { fields: { fld_course_name: [{ type: "text", text: "课程同步001" }] } } },
      }) } } },
    },
  });

  const result = await reader.read({
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    courseNamingField: {
      fieldId: "fld_course_name",
      fieldName: "课程名称",
      type: 1,
      uiType: "Text",
    },
    delivery: { courseNaming: { mode: "field", fieldId: "fld_course_name" } },
  }, {
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    recordId: "rec_demo",
  });

  assert.equal(result.courseName, "课程同步001");
});

test("uses the matching configured name field for legacy synchronized course naming", async () => {
  const reader = createFeishuControlledContextReader({
    client: {
      bitable: { v1: { appTableRecord: { get: async () => ({
        code: 0,
        data: { record: { fields: { fld_course_name: "课程兼容001" } } },
      }) } } },
    },
  });

  const result = await reader.read({
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    namingField: {
      fieldId: "fld_course_name",
      fieldName: "课程名称",
      kind: "text",
    },
    delivery: { courseNaming: { mode: "field", fieldId: "fld_course_name" } },
  }, {
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    recordId: "rec_demo",
  });

  assert.equal(result.courseName, "课程兼容001");
});
