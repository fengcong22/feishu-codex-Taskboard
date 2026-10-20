import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPhasedSubjectMetadata,
  comparePhasedSubjectMetadata,
  createFeishuBaseMetadataReader,
  parseBaseLink,
} from "../src/feishu-base-metadata.mjs";

function vmMetadataFixture() {
  const options = [
    { id: "opt_idle", name: "未开始" },
    { id: "opt_initial", name: "初稿" },
    { id: "opt_processing", name: "处理中" },
    { id: "opt_completed", name: "初稿完成" },
  ];
  const subject = {
    subjectKey: "bas_demo:tbl_math", baseToken: "bas_demo", baseName: "课程库",
    tableId: "tbl_math", tableName: "小学数学", lifecycle: "enabled", configVersion: 2,
    workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
    title: { fieldId: "fld_name", fieldName: "视频名称" },
    statusField: { fieldId: "fld_status", fieldName: "制作进度", type: "single_select",
      options: options.map(({ id, name }) => ({ optionId: id, value: name })) },
    packageRoute: { routeMode: "fixed", packageAlias: "slicing", subjectCodeFieldId: null, branchMap: null },
    execution: { mode: "automatic", concurrencyGroup: "slicing", maxConcurrent: 1, resourceGroups: [] },
    vmWorkflow: {
      fields: { vmidFieldId: "fld_vmid", namingFieldId: "fld_name", outputAttachmentFieldId: "fld_output" },
      approval: { department: "课程制作", reason: "初稿剪辑" },
      stages: {
        initial: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_initial", instructionFieldId: "fld_instruction",
          writeback: { processing: { fieldId: "fld_status", optionId: "opt_processing" }, completed: { fieldId: "fld_status", optionId: "opt_completed" } } },
        review: { enabled: false, statusFieldId: null, triggerOptionId: null, instructionFieldId: null, instructionAttachmentsFieldId: null,
          writeback: { processing: { fieldId: null, optionId: null }, completed: { fieldId: null, optionId: null } } },
      },
      finalArchive: { enabled: false, statusFieldId: null, triggerOptionId: null, pathSource: "manual", directoryPath: null, pathFieldId: null },
    },
  };
  const fields = [
    { field_id: "fld_status", field_name: "制作进度", type: 3, ui_type: "SingleSelect", property: { options } },
    { field_id: "fld_vmid", field_name: "VMID", type: 1, ui_type: "Text" },
    { field_id: "fld_name", field_name: "视频名称", type: 20, ui_type: "Formula" },
    { field_id: "fld_instruction", field_name: "剪辑意见", type: 1, ui_type: "Text" },
    { field_id: "fld_output", field_name: "成片附件", type: 17, ui_type: "Attachment" },
  ];
  return { subject, fields };
}

function vmMetadataReader(fields, overrides = {}) {
  return createFeishuBaseMetadataReader({ client: fakeClient({
    tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
    fields: { tbl_math: { code: 0, data: { items: fields } } },
    ...overrides,
  }) });
}

function fakeClient({ app, tables, fields, wikiNode, calls = [] } = {}) {
  return {
    bitable: {
      v1: {
        app: {
          get: async (request) => {
            calls.push(["app.get", request]);
            return app ?? { code: 0, data: { app: { app_token: "bas_demo", name: "课程库" } } };
          },
        },
        appTable: {
          list: async (request) => {
            calls.push(["appTable.list", request]);
            return tables ?? { code: 0, data: { items: [] } };
          },
        },
        appTableField: {
          list: async (request) => {
            calls.push(["appTableField.list", request]);
            return fields?.[request.path.table_id] ?? { code: 0, data: { items: [] } };
          },
        },
      },
    },
    wiki: {
      v2: {
        space: {
          getNode: async (request) => {
            calls.push(["wiki.space.getNode", request]);
            return wikiNode ?? {
              code: 0,
              data: {
                node: {
                  node_token: "wik_demo",
                  obj_type: "bitable",
                  obj_token: "bas_demo",
                },
              },
            };
          },
        },
      },
    },
  };
}

function phasedSubject(overrides = {}) {
  const stage = (optionId, value, stageOverrides = {}) => ({
    enabled: true,
    trigger: { fieldId: "fld_status", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    ...stageOverrides,
  });
  return {
    baseToken: "bas_demo",
    baseName: "课程库",
    tableId: "tbl_math",
    tableName: "小学数学",
    statusField: { fieldId: "fld_status", fieldName: "制作进度" },
    documentField: { fieldId: "fld_document", fieldName: "素材文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
    stages: {
      initial: stage("opt_initial", "初稿"),
      first_review: stage("opt_review", "初审修改"),
      final_review: stage("opt_final", "终审修改"),
    },
    ...overrides,
  };
}

function phasedMetadata(fields = []) {
  return {
    baseToken: "bas_demo",
    baseName: "课程库",
    tables: [{ tableId: "tbl_math", tableName: "小学数学", fields }],
  };
}

function twoFieldMetadataFixture() {
  const subject = phasedSubject({ reviewStatusField: { fieldId: "fld_review", fieldName: "Review" } });
  subject.stages.first_review.trigger = { fieldId: "fld_review", fieldName: "Review", optionId: "opt_initial", value: "First" };
  subject.stages.final_review.trigger = { fieldId: "fld_review", fieldName: "Review", optionId: "opt_final", value: "Final" };
  return {
    subject,
    metadata: phasedMetadata([
      { fieldId: "fld_status", fieldName: "制作进度", type: 3, uiType: "SingleSelect", options: [{ id: "opt_initial", name: "初稿" }] },
      { fieldId: "fld_review", fieldName: "Review", type: 3, uiType: "SingleSelect", options: [{ id: "opt_initial", name: "First" }, { id: "opt_final", name: "Final" }] },
      { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
    ]),
  };
}

test("VM metadata validates the actual initial profile without a legacy trigger", async (t) => {
  for (const [name, type, uiType] of [["formula", 20, "Formula"], ["text", 1, "Text"], ["numeric string without uiType", "20", undefined]]) {
    await t.test(name, async () => {
      const { subject, fields } = vmMetadataFixture();
      fields[2].type = type;
      fields[2].ui_type = uiType;
      assert.equal(Object.hasOwn(subject, "trigger"), false);
      await vmMetadataReader(fields).validateSubject(subject);
    });
  }
});

test("VM metadata validates the configured review fields and options", async () => {
  const { subject, fields } = vmMetadataFixture();
  const status = fields[0].property.options;
  status.push({ id: "opt_review", name: "待修改" });
  subject.statusField.options.push({ optionId: "opt_review", value: "待修改" });
  fields.push({ field_id: "fld_review_instruction", field_name: "审核意见", type: 1, ui_type: "Text" });
  subject.vmWorkflow.stages.review = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_review",
    instructionFieldId: "fld_review_instruction", instructionAttachmentsFieldId: null,
    writeback: structuredClone(subject.vmWorkflow.stages.initial.writeback) };
  await vmMetadataReader(fields).validateSubject(subject);
});

test("VM metadata validates processing and completed options in their own fields", async () => {
  const { subject, fields } = vmMetadataFixture();
  subject.vmWorkflow.stages.initial.writeback.completed = { fieldId: "fld_delivery", optionId: "opt_delivered" };
  fields.push({ field_id: "fld_delivery", field_name: "交付状态", type: 3, ui_type: "SingleSelect",
    property: { options: [{ id: "opt_delivered", name: "已交付" }] } });
  await vmMetadataReader(fields).validateSubject(subject);
});

test("VM metadata checks every active field type instead of accepting a valid legacy trigger", async (t) => {
  const scenarios = [
    ["VMID formula", 1, 20, "Formula"],
    ["VMID number", 1, 2, "Number"],
    ["instruction formula", 3, 20, "Formula"],
    ["naming number", 2, 2, "Number"],
    ["output text", 4, 1, "Text"],
    ["multi-select trigger", 0, 4, "MultiSelect"],
    ["text trigger", 0, 1, "Text"],
    ["VMID conflicting uiType", 1, 1, "Formula"],
    ["instruction conflicting uiType", 3, 1, "Attachment"],
    ["naming conflicting uiType", 2, 20, "Text"],
    ["output conflicting uiType", 4, 17, "Text"],
    ["malformed output type", 4, [17], "Attachment"],
    ["missing VMID type", 1, undefined, "Text"],
  ];
  for (const [name, index, type, uiType] of scenarios) {
    await t.test(name, async () => {
      const { subject, fields } = vmMetadataFixture();
      subject.trigger = { fieldId: "fld_status", fieldName: "制作进度", optionId: "opt_initial", startValue: "初稿" };
      fields[index].type = type;
      fields[index].ui_type = uiType;
      await assert.rejects(vmMetadataReader(fields).validateSubject(subject), { code: "FIELD_TYPE_INVALID", status: 409 });
    });
  }
});

test("VM metadata refuses missing or mismatched initial and writeback bindings", async (t) => {
  const mutations = [
    ["VMID field removed", ({ fields }) => { fields.splice(1, 1); }],
    ["instruction field removed", ({ fields }) => { fields.splice(3, 1); }],
    ["naming field removed", ({ fields }) => { fields.splice(2, 1); }],
    ["attachment field removed", ({ fields }) => { fields.splice(4, 1); }],
    ["trigger option removed", ({ fields }) => { fields[0].property.options.splice(1, 1); }],
    ["processing option removed", ({ fields }) => { fields[0].property.options.splice(2, 1); }],
    ["completed option removed", ({ fields }) => { fields[0].property.options.splice(3, 1); }],
    ["trigger option renamed", ({ fields }) => { fields[0].property.options[1].name = "已改名"; }],
    ["trigger belongs to another field", ({ subject }) => { subject.vmWorkflow.stages.initial.statusFieldId = "fld_output"; }],
    ["title differs from naming binding", ({ subject }) => { subject.vmWorkflow.fields.namingFieldId = "fld_vmid"; }],
    ["processing field missing", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.processing.fieldId = "fld_missing"; }],
    ["completed field missing", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.completed.fieldId = "fld_missing"; }],
    ["processing option missing", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.processing.optionId = "opt_missing"; }],
    ["completed option missing", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.completed.optionId = "opt_missing"; }],
    ["processing unbound", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.processing = { fieldId: null, optionId: null }; }],
    ["completed unbound", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.completed = { fieldId: null, optionId: null }; }],
    ["processing incomplete", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.processing.optionId = null; }],
    ["completed incomplete", ({ subject }) => { subject.vmWorkflow.stages.initial.writeback.completed.fieldId = null; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const fixture = vmMetadataFixture();
      fixture.subject.trigger = { fieldId: "fld_status", fieldName: "制作进度", optionId: "opt_initial", startValue: "初稿" };
      mutate(fixture);
      await assert.rejects(vmMetadataReader(fixture.fields).validateSubject(fixture.subject), { code: "INVALID_FIELD", status: 409 });
    });
  }
});

test("VM metadata rejects writeback fields with an incompatible live type", async (t) => {
  for (const moment of ["processing", "completed"]) {
    await t.test(moment, async () => {
      const { subject, fields } = vmMetadataFixture();
      subject.trigger = { fieldId: "fld_status", fieldName: "制作进度", optionId: "opt_initial", startValue: "初稿" };
      subject.vmWorkflow.stages.initial.writeback[moment] = { fieldId: "fld_delivery", optionId: "opt_delivered" };
      fields.push({ field_id: "fld_delivery", field_name: "交付状态", type: 4, ui_type: "MultiSelect",
        property: { options: [{ id: "opt_delivered", name: "已交付" }] } });
      await assert.rejects(vmMetadataReader(fields).validateSubject(subject), { code: "FIELD_TYPE_INVALID", status: 409 });
    });
  }
});

test("VM metadata fails closed on duplicate live fields, tables and options", async (t) => {
  const mutations = [
    ["duplicate VMID field", ({ fields }) => { fields.push(structuredClone(fields[1])); }],
    ["duplicate unrelated field", ({ fields }) => { fields.push({ field_id: "fld_other", field_name: "其他", type: 1 }, { field_id: "fld_other", field_name: "另一其他", type: 1 }); }],
    ["duplicate initial option", ({ fields }) => { fields[0].property.options.push({ id: "opt_initial", name: "另一个初稿" }); }],
    ["duplicate processing option", ({ fields }) => { fields[0].property.options.push({ id: "opt_processing", name: "另一个处理中" }); }],
    ["duplicate completed option", ({ fields }) => { fields[0].property.options.push({ id: "opt_completed", name: "另一个完成" }); }],
    ["malformed option list", ({ fields }) => { fields[0].property.options = {}; }],
    ["malformed option", ({ fields }) => { fields[0].property.options.push({ id: "opt_bad", name: 1 }); }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const fixture = vmMetadataFixture();
      fixture.subject.trigger = { fieldId: "fld_status", fieldName: "制作进度", optionId: "opt_initial", startValue: "初稿" };
      mutate(fixture);
      await assert.rejects(vmMetadataReader(fixture.fields).validateSubject(fixture.subject), { code: "FEISHU_METADATA_INVALID_RESPONSE" });
    });
  }
  await t.test("duplicate table", async () => {
    const { subject, fields } = vmMetadataFixture();
    const reader = vmMetadataReader(fields, { tables: { code: 0, data: { items: [
      { table_id: "tbl_math", name: "小学数学" }, { table_id: "tbl_math", name: "小学数学副本" },
    ] } } });
    await assert.rejects(reader.validateSubject(subject), { code: "FEISHU_METADATA_INVALID_RESPONSE" });
  });
});

test("VM metadata cannot fall back to legacy validation for incomplete or unsupported VM declarations", async (t) => {
  const mutations = [
    ["missing template", (subject) => { delete subject.workflowTemplate; }],
    ["unknown template", (subject) => { subject.workflowTemplate.id = "other"; }],
    ["unsupported version", (subject) => { subject.workflowTemplate.version = 2; }],
    ["missing VM workflow", (subject) => { delete subject.vmWorkflow; }],
    ["initial disabled", (subject) => { subject.vmWorkflow.stages.initial.enabled = false; }],
    ["review enabled", (subject) => { subject.vmWorkflow.stages.review.enabled = true; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const { subject, fields } = vmMetadataFixture();
      subject.trigger = { fieldId: "fld_status", fieldName: "制作进度", optionId: "opt_initial", startValue: "初稿" };
      mutate(subject);
      await assert.rejects(vmMetadataReader(fields).validateSubject(subject), { code: "INVALID_FIELD", status: 409 });
    });
  }
});

test("VM metadata validates an enabled archive trigger and its exact path field", async () => {
  const { subject, fields } = vmMetadataFixture();
  fields[0].property.options.push({ id: "opt_archive", name: "待归档" });
  fields.push({ field_id: "fld_archive_path", field_name: "归档目录", type: 1, ui_type: "Text" });
  subject.metadata = { fields: fields.map((field) => ({ fieldId: field.field_id, fieldName: field.field_name,
    type: field.type, uiType: field.ui_type, options: field.property?.options?.map(({ id, name }) => ({ optionId: id, value: name })) ?? [] })) };
  subject.vmWorkflow.finalArchive = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "pmo_field", directoryPath: null, pathFieldId: "fld_archive_path" };
  await vmMetadataReader(fields).validateSubject(subject);
});

test("Bridge ZIP phased and legacy subjects keep their existing metadata validation paths", async () => {
  const phased = phasedSubject({ stages: {
    initial: phasedSubject().stages.initial,
    first_review: { ...phasedSubject().stages.first_review, enabled: false },
    final_review: { ...phasedSubject().stages.final_review, enabled: false },
  } });
  const reader = vmMetadataReader([
    { field_id: "fld_status", field_name: "制作进度", type: 3, ui_type: "SingleSelect",
      property: { options: [{ id: "opt_initial", name: "初稿" }] } },
    { field_id: "fld_document", field_name: "素材文档", type: 1, ui_type: "Text" },
    { field_id: "fld_name", field_name: "命名", type: 1, ui_type: "Text" },
  ]);
  assert.equal(Object.hasOwn(phased, "workflowTemplate"), false);
  await reader.validateSubject(phased);
  await reader.validateSubject({
    baseToken: "bas_demo", baseName: "课程库", tableId: "tbl_math", tableName: "小学数学",
    trigger: { fieldId: "fld_status", fieldName: "制作进度", optionId: "opt_initial", startValue: "初稿" },
    title: { fieldId: "fld_name", fieldName: "命名" },
  });
});

test("two trigger fields validate options independently when IDs overlap", () => {
  const { subject, metadata } = twoFieldMetadataFixture();
  assert.equal(assertPhasedSubjectMetadata(subject, metadata), true);
  assert.deepEqual(comparePhasedSubjectMetadata(subject, metadata), []);
  subject.stages.final_review.trigger = { ...subject.stages.first_review.trigger };
  assert.throws(() => assertPhasedSubjectMetadata(subject, metadata), /unique/u);
});

test("two trigger fields reject renamed, missing and invalid review metadata", () => {
  for (const mutation of [
    (field) => { field.fieldName = "Renamed"; },
    (field) => { field.fieldId = "fld_other"; },
    (field) => { field.type = 1; field.uiType = "Text"; },
    (field) => { field.options = null; },
    (field) => { field.options.push({ ...field.options[0] }); },
  ]) {
    const { subject, metadata } = twoFieldMetadataFixture();
    mutation(metadata.tables[0].fields[1]);
    assert.throws(() => assertPhasedSubjectMetadata(subject, metadata));
    assert.ok(comparePhasedSubjectMetadata(subject, metadata).some((issue) => issue.path.includes("reviewStatusField")));
  }
  const { subject, metadata } = twoFieldMetadataFixture();
  metadata.tables[0].fields[1].options[0].name = "Renamed";
  const issues = comparePhasedSubjectMetadata(subject, metadata);
  assert.ok(issues.some((issue) => issue.path.endsWith("stages.first_review.trigger.optionId")));
  assert.ok(issues.every((issue) => !issue.path.includes("stages.initial")));
});

test("parses direct Base and Wiki links with their optional table query", () => {
  assert.deepEqual(parseBaseLink("https://example.feishu.cn/base/bas_demo?table=tbl_chinese"), {
    baseToken: "bas_demo",
    tableId: "tbl_chinese",
  });
  assert.deepEqual(parseBaseLink("https://example.feishu.cn/base/bas_demo"), {
    baseToken: "bas_demo",
  });
  assert.deepEqual(parseBaseLink("https://example.feishu.cn/wiki/wik_demo?table=tbl_math"), {
    wikiToken: "wik_demo",
    tableId: "tbl_math",
  });
});

test("rejects malformed or unrelated links without echoing the input", () => {
  for (const value of [
    "",
    "not a URL",
    "https://example.feishu.cn/docx/docx_demo",
    "https://example.feishu.cn/base/workspace/bas_demo",
    "https://example.feishu.cn/wiki/wik_demo/child",
    "https://example.feishu.cn/base/",
    "https://example.feishu.cn/base/bas_demo?table=../../secret",
    "https://example.feishu.cn/wiki/wik_demo?table=tbl_a&table=tbl_b",
    "javascript:alert(1)",
  ]) {
    assert.throws(
      () => parseBaseLink(value),
      (error) => error.code === "INVALID_BASE_LINK"
        && (value === "" || !error.message.includes(value)),
    );
  }
});

test("rejects non-Feishu HTTPS origins, HTTP and embedded credentials", () => {
  for (const value of [
    "http://example.feishu.cn/wiki/wik_demo",
    "https://evil.example/wiki/wik_demo",
    "https://example.larksuite.com/wiki/wik_demo",
    "https://example.larkoffice.com/base/bas_demo",
    "https://example.larksuite.cn/wiki/wik_demo",
    "https://user:password@example.feishu.cn/wiki/wik_demo",
    "https://127.0.0.1/wiki/wik_demo",
    "https://localhost/wiki/wik_demo",
    "https://example.feishu.cn//wiki/wik_demo",
  ]) {
    assert.throws(
      () => parseBaseLink(value),
      (error) => error.code === "INVALID_BASE_LINK" && !error.message.includes(value),
    );
  }
});

test("resolves a Wiki Base node before reading the selected table metadata", async () => {
  const calls = [];
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      calls,
      tables: {
        code: 0,
        data: {
          items: [
            { table_id: "tbl_chinese", name: "小学语文" },
            { table_id: "tbl_math", name: "小学数学" },
          ],
        },
      },
      fields: {
        tbl_math: {
          code: 0,
          data: {
            items: [{ field_id: "fld_status", field_name: "制作进度", type: 1 }],
          },
        },
      },
    }),
  });

  const result = await reader.preview(
    "https://example.feishu.cn/wiki/wik_demo?table=tbl_math",
  );

  assert.equal(result.baseToken, "bas_demo");
  assert.deepEqual(result.tables.map((table) => table.tableId), ["tbl_math"]);
  assert.deepEqual(calls, [
    ["wiki.space.getNode", { params: { token: "wik_demo", obj_type: "wiki" } }],
    ["app.get", { path: { app_token: "bas_demo" } }],
    ["appTable.list", { path: { app_token: "bas_demo" } }],
    ["appTableField.list", { path: { app_token: "bas_demo", table_id: "tbl_math" } }],
  ]);
});

test("rejects a Wiki node that does not point to a Base without reading Base metadata", async () => {
  const calls = [];
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      calls,
      wikiNode: {
        code: 0,
        data: {
          node: {
            node_token: "wik_doc",
            obj_type: "docx",
            obj_token: "docx_demo",
          },
        },
      },
    }),
  });

  await assert.rejects(
    () => reader.preview("https://example.feishu.cn/wiki/wik_doc"),
    (error) => error.code === "FEISHU_WIKI_NOT_BASE"
      && error.status === 400
      && !error.message.includes("wik_doc"),
  );
  assert.deepEqual(calls, [
    ["wiki.space.getNode", { params: { token: "wik_doc", obj_type: "wiki" } }],
  ]);
});

test("reads and normalizes Base, tables, fields and select options using read-only SDK calls", async () => {
  const calls = [];
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      calls,
      app: { code: 0, data: { app: { app_token: "bas_demo", name: "课程库" } } },
      tables: {
        code: 0,
        data: {
          items: [
            { table_id: "tbl_chinese", name: "小学语文" },
            { table_id: "tbl_math", name: "小学数学" },
          ],
        },
      },
      fields: {
        tbl_chinese: {
          code: 0,
          data: {
            items: [
              {
                field_id: "fld_status",
                field_name: "制作进度",
                type: 3,
                ui_type: "SingleSelect",
                property: {
                  options: [
                    { id: "opt_waiting", name: "待制作", color: 1 },
                    { id: "opt_done", name: "已完成", color: 2 },
                  ],
                },
              },
            ],
          },
        },
        tbl_math: {
          code: 0,
          data: {
            items: [{ field_id: "fld_title", field_name: "题目", type: 1 }],
          },
        },
      },
    }),
  });

  const result = await reader.preview("https://example.feishu.cn/base/bas_demo");
  assert.deepEqual(result, {
    baseToken: "bas_demo",
    baseName: "课程库",
    tables: [
      {
        tableId: "tbl_chinese",
        tableName: "小学语文",
        fields: [{
          fieldId: "fld_status",
          fieldName: "制作进度",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_waiting", name: "待制作", color: 1 },
            { id: "opt_done", name: "已完成", color: 2 },
          ],
        }],
      },
      {
        tableId: "tbl_math",
        tableName: "小学数学",
        fields: [{
          fieldId: "fld_title",
          fieldName: "题目",
          type: 1,
          uiType: null,
          options: [],
        }],
      },
    ],
  });
  assert.deepEqual(calls, [
    ["app.get", { path: { app_token: "bas_demo" } }],
    ["appTable.list", { path: { app_token: "bas_demo" } }],
    ["appTableField.list", { path: { app_token: "bas_demo", table_id: "tbl_chinese" } }],
    ["appTableField.list", { path: { app_token: "bas_demo", table_id: "tbl_math" } }],
  ]);
});

test("rejects a successful metadata response that omits its table items", async () => {
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      tables: { code: 0, data: {} },
    }),
  });

  await assert.rejects(
    () => reader.preview("https://example.feishu.cn/base/bas_demo"),
    (error) => error.code === "FEISHU_METADATA_INVALID_RESPONSE",
  );
});

test("skips select options whose SDK name is blank while preserving valid options", async () => {
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      fields: {
        tbl_chinese: {
          code: 0,
          data: {
            items: [{
              field_id: "fld_status",
              field_name: "制作进度",
              type: 3,
              ui_type: "SingleSelect",
              property: {
                options: [
                  { id: "opt_waiting", name: "待制作", color: 1 },
                  { id: "opt_blank", name: "" },
                  { id: "opt_done", name: "已完成", color: 2 },
                ],
              },
            }],
          },
        },
      },
    }),
  });

  const fields = await reader.listFields("bas_demo", "tbl_chinese");

  assert.deepEqual(fields[0].options, [
    { id: "opt_waiting", name: "待制作", color: 1 },
    { id: "opt_done", name: "已完成", color: 2 },
  ]);
});

test("still rejects malformed, unidentified and unsafe select options", async (t) => {
  for (const scenario of [
    { name: "malformed option", option: null },
    { name: "invalid ID with a blank name", option: { id: "../invalid", name: "" } },
    { name: "missing name", option: { id: "opt_missing_name" } },
    { name: "control character name", option: { id: "opt_control", name: "\u0000" } },
    { name: "line break name", option: { id: "opt_line_break", name: "\n" } },
    { name: "leading line break", option: { id: "opt_leading_break", name: "\n待制作" } },
    { name: "C1 control character", option: { id: "opt_c1_control", name: "待\u0085制作" } },
  ]) {
    await t.test(scenario.name, async () => {
      const reader = createFeishuBaseMetadataReader({
        client: fakeClient({
          fields: {
            tbl_chinese: {
              code: 0,
              data: {
                items: [{
                  field_id: "fld_status",
                  field_name: "制作进度",
                  type: 3,
                  property: { options: [scenario.option] },
                }],
              },
            },
          },
        }),
      });

      await assert.rejects(
        () => reader.listFields("bas_demo", "tbl_chinese"),
        (error) => error.code === "FEISHU_METADATA_INVALID_RESPONSE",
      );
    });
  }
});

test("previews only the table selected by the Base link query", async () => {
  const calls = [];
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      calls,
      tables: { code: 0, data: { items: [
        { table_id: "tbl_a", name: "A" },
        { table_id: "tbl_b", name: "B" },
      ] } },
      fields: {
        tbl_b: { code: 0, data: { items: [{ field_id: "fld_b", field_name: "字段B", type: 1 }] } },
      },
    }),
  });
  const result = await reader.preview("https://example.feishu.cn/base/bas_demo?table=tbl_b");
  assert.deepEqual(result.tables.map((table) => table.tableId), ["tbl_b"]);
  assert.equal(calls.some(([method, request]) => method === "appTableField.list"
    && request.path.table_id === "tbl_a"), false);
});

test("validates an enabled subject against current Base, table, field and option metadata", async () => {
  const calls = [];
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      calls,
      app: { code: 0, data: { app: { app_token: "bas_demo", name: "课程库" } } },
      tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
      fields: {
        tbl_math: { code: 0, data: { items: [{
          field_id: "fld_status",
          field_name: "制作进度",
          type: 3,
          ui_type: "SingleSelect",
          property: { options: [{ id: "opt_ready", name: "待制作" }] },
        }] } },
      },
    }),
  });

  await reader.validateSubject({
    baseToken: "bas_demo",
    baseName: "课程库",
    tableId: "tbl_math",
    tableName: "小学数学",
    trigger: {
      fieldId: "fld_status",
      fieldName: "制作进度",
      startValue: "待制作",
      optionId: "opt_ready",
    },
  });

  assert.deepEqual(calls, [
    ["app.get", { path: { app_token: "bas_demo" } }],
    ["appTable.list", { path: { app_token: "bas_demo" } }],
    ["appTableField.list", { path: { app_token: "bas_demo", table_id: "tbl_math" } }],
  ]);
});

test("validates phased video and replacement audio attachment bindings against live metadata", () => {
  const fields = [
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_video", fieldName: "视频附件", type: 17, uiType: "Attachment", options: [] },
    { fieldId: "fld_audio", fieldName: "音频附件", type: 17, uiType: "Attachment", options: [] },
    { fieldId: "fld_text", fieldName: "普通文本", type: 1, uiType: "Text", options: [] },
  ];
  const metadata = phasedMetadata(fields);

  const valid = phasedSubject({
    stages: {
      initial: {
        ...phasedSubject().stages.initial,
        videoSource: { kind: "base_attachment", fieldId: "fld_video" },
        audio: { mode: "replace_original", source: { kind: "base_attachment", fieldId: "fld_audio" } },
      },
      first_review: phasedSubject().stages.first_review,
      final_review: phasedSubject().stages.final_review,
    },
  });
  assert.equal(assertPhasedSubjectMetadata(valid, metadata), true);

  const missingVideo = structuredClone(valid);
  missingVideo.stages.initial.videoSource = { kind: "base_attachment", fieldId: "fld_missing" };
  assert.throws(
    () => assertPhasedSubjectMetadata(missingVideo, metadata),
    (error) => error.code === "FIELD_NOT_FOUND"
      && error.path === "stages.initial.videoSource.fieldId",
  );

  const wrongVideoType = structuredClone(valid);
  wrongVideoType.stages.initial.videoSource = { kind: "base_attachment", fieldId: "fld_text" };
  assert.throws(
    () => assertPhasedSubjectMetadata(wrongVideoType, metadata),
    (error) => error.code === "FIELD_TYPE_INVALID"
      && error.path === "stages.initial.videoSource.fieldId",
  );

  const missingAudio = structuredClone(valid);
  missingAudio.stages.initial.audio.source = { kind: "base_attachment", fieldId: "fld_missing" };
  assert.throws(
    () => assertPhasedSubjectMetadata(missingAudio, metadata),
    (error) => error.code === "FIELD_NOT_FOUND"
      && error.path === "stages.initial.audio.source.fieldId",
  );

  const wrongAudioType = structuredClone(valid);
  wrongAudioType.stages.initial.audio.source = { kind: "base_attachment", fieldId: "fld_text" };
  assert.throws(
    () => assertPhasedSubjectMetadata(wrongAudioType, metadata),
    (error) => error.code === "FIELD_TYPE_INVALID"
      && error.path === "stages.initial.audio.source.fieldId",
  );

  const docxAndOriginal = structuredClone(valid);
  docxAndOriginal.stages.initial.videoSource = { kind: "docx_section", anchorText: "视频" };
  docxAndOriginal.stages.initial.audio = {
    mode: "video_original",
    source: { kind: "base_attachment", fieldId: "fld_missing" },
  };
  assert.equal(assertPhasedSubjectMetadata(docxAndOriginal, metadata), true);
});

test("phased metadata comparison reports unavailable metadata before staged attachment diagnostics", () => {
  const subject = phasedSubject({
    stages: {
      initial: {
        ...phasedSubject().stages.initial,
        videoSource: { kind: "base_attachment", fieldId: "fld_missing_video" },
      },
      first_review: phasedSubject().stages.first_review,
      final_review: phasedSubject().stages.final_review,
    },
  });

  assert.deepEqual(comparePhasedSubjectMetadata(subject, {
    baseToken: "bas_demo",
    baseName: "课程库",
    tables: [],
  }), [{
    code: "TABLE_NOT_FOUND",
    path: "bases.bas_demo.subjects.tbl_math",
    message: "Feishu subject table was not found",
    errorCode: "FEISHU_TABLE_NOT_FOUND",
  }]);

  assert.deepEqual(comparePhasedSubjectMetadata(subject, {
    baseToken: "bas_demo",
    baseName: "课程库",
    tables: {},
  }), [{
    code: "FEISHU_METADATA_UNAVAILABLE",
    path: "bases.bas_demo",
    message: "Feishu returned unusable metadata for this Base",
    errorCode: "FEISHU_METADATA_INVALID_RESPONSE",
  }]);
});

test("phased metadata comparison and assertion fail closed for null metadata entries", () => {
  const subject = phasedSubject();
  const fields = () => [
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
  ];
  const table = (fieldValues = fields()) => ({
    tableId: "tbl_math",
    tableName: "小学数学",
    fields: fieldValues,
  });
  const nullOptionFields = fields();
  nullOptionFields[0].options.unshift(null);
  const scenarios = [
    { name: "tables", metadata: { ...phasedMetadata(), tables: [null, table()] } },
    { name: "fields", metadata: phasedMetadata([null, ...fields()]) },
    { name: "status options", metadata: phasedMetadata(nullOptionFields) },
  ];

  for (const { name, metadata } of scenarios) {
    let diagnostics;
    assert.doesNotThrow(() => {
      diagnostics = comparePhasedSubjectMetadata(subject, metadata);
    }, name);
    assert.doesNotMatch(JSON.stringify(diagnostics), /Cannot read properties/u, name);
    assert.throws(
      () => assertPhasedSubjectMetadata(subject, metadata),
      (error) => error?.code === "FEISHU_METADATA_INVALID_RESPONSE"
        && error.status === 409
        && !/Cannot read properties/u.test(error.message),
      name,
    );
  }
});

test("phased metadata requires one unambiguous single-select status field", () => {
  const fields = [
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
  ];
  const scenarios = [
    {
      name: "multi-select",
      metadata: phasedMetadata(fields.map((field) => (
        field.fieldId === "fld_status" ? { ...field, type: 4, uiType: "MultiSelect" } : field
      ))),
    },
    {
      name: "conflicting single-select type",
      metadata: phasedMetadata(fields.map((field) => (
        field.fieldId === "fld_status" ? { ...field, type: 4, uiType: "SingleSelect" } : field
      ))),
    },
    {
      name: "duplicate status field id",
      metadata: phasedMetadata([...fields, { ...fields[0] }]),
    },
    {
      name: "duplicate trigger option id",
      metadata: phasedMetadata(fields.map((field) => (
        field.fieldId === "fld_status"
          ? { ...field, options: [...field.options, { id: "opt_initial", name: "其他初稿" }] }
          : field
      ))),
    },
  ];

  for (const { name, metadata } of scenarios) {
    const diagnostics = comparePhasedSubjectMetadata(phasedSubject(), metadata);
    assert.ok(diagnostics.some((entry) => entry.errorCode === "FEISHU_METADATA_INVALID_RESPONSE"
      || entry.code === "FIELD_TYPE_INVALID"), name);
    assert.throws(() => assertPhasedSubjectMetadata(phasedSubject(), metadata), undefined, name);
  }
});

test("phased metadata requires a text or formula course naming field", () => {
  const metadata = phasedMetadata([
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "课程名称", type: 17, uiType: "Attachment", options: [] },
  ]);

  const subject = phasedSubject({ namingField: { fieldId: "fld_name", fieldName: "课程名称" } });
  assert.throws(
    () => assertPhasedSubjectMetadata(subject, metadata),
    (error) => error.code === "FIELD_TYPE_INVALID" && error.path === "namingField.fieldId",
  );
  assert.ok(comparePhasedSubjectMetadata(subject, metadata).some((entry) => (
    entry.code === "FIELD_TYPE_INVALID"
      && entry.path === "bases.bas_demo.subjects.tbl_math.namingField.fieldId"
  )));
});

test("phased metadata keeps a renamed course naming field valid when its ID is stable", () => {
  const metadata = phasedMetadata([
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "已改名课程字段", type: 20, uiType: "Formula", options: [] },
  ]);
  const subject = phasedSubject({ namingField: { fieldId: "fld_name", fieldName: null } });

  assert.equal(assertPhasedSubjectMetadata(subject, metadata), true);
});

test("phased metadata reports a stale stage trigger field name", () => {
  const subject = phasedSubject({
    stages: {
      ...phasedSubject().stages,
      initial: {
        ...phasedSubject().stages.initial,
        trigger: {
          ...phasedSubject().stages.initial.trigger,
          fieldName: "旧制作进度",
        },
      },
    },
  });
  const metadata = phasedMetadata([
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
  ]);
  const expectedPath = "bases.bas_demo.subjects.tbl_math.stages.initial.trigger.fieldName";

  assert.ok(comparePhasedSubjectMetadata(subject, metadata).some((entry) => (
    entry.code === "INVALID_FIELD" && entry.path === expectedPath
  )));
  assert.throws(
    () => assertPhasedSubjectMetadata(subject, metadata),
    (error) => error.code === "INVALID_FIELD"
      && error.path === "stages.initial.trigger.fieldName",
  );
});

test("phased metadata rejects renamed identities and malformed attachment types", () => {
  const baseFields = [
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
  ];
  const attachmentSubject = phasedSubject({
    stages: {
      ...phasedSubject().stages,
      initial: {
        ...phasedSubject().stages.initial,
        videoSource: { kind: "base_attachment", fieldId: "fld_video" },
      },
    },
  });
  const scenarios = [
    {
      name: "renamed Base",
      subject: phasedSubject(),
      metadata: { ...phasedMetadata(baseFields), baseName: "已改名课程库" },
      expectedCode: "BASE_NAME_MISMATCH",
    },
    {
      name: "renamed table",
      subject: phasedSubject(),
      metadata: {
        ...phasedMetadata(baseFields),
        tables: [{ ...phasedMetadata(baseFields).tables[0], tableName: "已改名数学" }],
      },
      expectedCode: "TABLE_NAME_MISMATCH",
    },
    {
      name: "duplicate attachment field id",
      subject: attachmentSubject,
      metadata: phasedMetadata([
        ...baseFields,
        { fieldId: "fld_video", fieldName: "视频附件", type: 17, uiType: "Attachment", options: [] },
        { fieldId: "fld_video", fieldName: "重复视频附件", type: 17, uiType: "Attachment", options: [] },
      ]),
      expectedCode: "FEISHU_METADATA_UNAVAILABLE",
    },
    {
      name: "array attachment type",
      subject: attachmentSubject,
      metadata: phasedMetadata([
        ...baseFields,
        { fieldId: "fld_video", fieldName: "视频附件", type: ["17"], uiType: "Attachment", options: [] },
      ]),
      expectedCode: "FIELD_TYPE_INVALID",
    },
    {
      name: "conflicting attachment type",
      subject: attachmentSubject,
      metadata: phasedMetadata([
        ...baseFields,
        { fieldId: "fld_video", fieldName: "视频附件", type: 1, uiType: "Attachment", options: [] },
      ]),
      expectedCode: "FIELD_TYPE_INVALID",
    },
  ];

  for (const { name, subject, metadata, expectedCode } of scenarios) {
    const diagnostics = comparePhasedSubjectMetadata(subject, metadata);
    assert.ok(diagnostics.some((entry) => entry.code === expectedCode), name);
    assert.throws(() => assertPhasedSubjectMetadata(subject, metadata), undefined, name);
  }
});

test("phased metadata comparison aggregates safe core and attachment diagnostics", () => {
  const subject = phasedSubject({
    statusField: { fieldId: "fld_status", fieldName: "已改名进度" },
    stages: {
      initial: {
        ...phasedSubject().stages.initial,
        videoSource: { kind: "base_attachment", fieldId: "fld_missing_video" },
      },
      first_review: {
        ...phasedSubject().stages.first_review,
        audio: {
          mode: "replace_original",
          source: { kind: "base_attachment", fieldId: "fld_text_audio" },
          durationToleranceSeconds: 3,
        },
      },
      final_review: phasedSubject().stages.final_review,
    },
  });
  const metadata = phasedMetadata([
    {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      uiType: "SingleSelect",
      options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ],
    },
    { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
    { fieldId: "fld_text_audio", fieldName: "音频文本", type: 1, uiType: "Text", options: [] },
  ]);

  assert.deepEqual(
    comparePhasedSubjectMetadata(subject, metadata).map((entry) => [entry.code, entry.path]),
    [
      ["INVALID_FIELD", "bases.bas_demo.subjects.tbl_math.statusField.fieldName"],
      ["FIELD_NOT_FOUND", "bases.bas_demo.subjects.tbl_math.stages.initial.videoSource.fieldId"],
      ["FIELD_TYPE_INVALID", "bases.bas_demo.subjects.tbl_math.stages.first_review.audio.source.fieldId"],
    ],
  );
});

test("validates every configured field name and subject-code binding during enable", async (t) => {
  const subject = {
    baseToken: "bas_demo",
    baseName: "课程库",
    tableId: "tbl_math",
    tableName: "小学数学",
    trigger: {
      fieldId: "fld_status",
      fieldName: "制作进度",
      startValue: "待制作",
      optionId: "opt_ready",
    },
    title: { fieldId: "fld_title", fieldName: "脚本名称" },
    packageRoute: {
      routeMode: "fixed",
      packageAlias: "Auto-cut-copyA",
      subjectCodeFieldId: "fld_code",
      subjectCodeFieldName: "学科代码",
      branchMap: null,
    },
  };
  const fields = [
    {
      field_id: "fld_status",
      field_name: "制作进度",
      type: 3,
      property: { options: [{ id: "opt_ready", name: "待制作" }] },
    },
    { field_id: "fld_title", field_name: "脚本名称", type: 1 },
    { field_id: "fld_code", field_name: "学科代码", type: 1 },
  ];

  for (const scenario of [
    { name: "title name", mutate: (copy) => { copy[1].field_name = "标题"; } },
    { name: "subject-code name", mutate: (copy) => { copy[2].field_name = "课程代码"; } },
    { name: "trigger option name", mutate: (copy) => { copy[0].property.options[0].name = "待剪辑"; } },
  ]) {
    await t.test(scenario.name, async () => {
      const currentFields = structuredClone(fields);
      scenario.mutate(currentFields);
      const reader = createFeishuBaseMetadataReader({
        client: fakeClient({
          tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
          fields: { tbl_math: { code: 0, data: { items: currentFields } } },
        }),
      });
      await assert.rejects(
        () => reader.validateSubject(subject),
        (error) => error.code === "INVALID_FIELD" && error.status === 409,
      );
    });
  }
});

test("rejects enabled subjects when saved Base, table, field or option names changed", async (t) => {
  const subject = {
    baseToken: "bas_demo",
    baseName: "课程库",
    tableId: "tbl_math",
    tableName: "小学数学",
    trigger: {
      fieldId: "fld_status",
      fieldName: "制作进度",
      startValue: "待制作",
      optionId: "opt_ready",
    },
  };
  const scenarios = [
    { name: "Base", appName: "课程总库", tableName: "小学数学", fieldName: "制作进度", optionName: "待制作" },
    { name: "table", appName: "课程库", tableName: "数学", fieldName: "制作进度", optionName: "待制作" },
    { name: "field", appName: "课程库", tableName: "小学数学", fieldName: "处理进度", optionName: "待制作" },
    { name: "option", appName: "课程库", tableName: "小学数学", fieldName: "制作进度", optionName: "可制作" },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const reader = createFeishuBaseMetadataReader({
        client: fakeClient({
          app: { code: 0, data: { app: { app_token: "bas_demo", name: scenario.appName } } },
          tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: scenario.tableName }] } },
          fields: {
            tbl_math: { code: 0, data: { items: [{
              field_id: "fld_status",
              field_name: scenario.fieldName,
              type: 3,
              property: { options: [{ id: "opt_ready", name: scenario.optionName }] },
            }] } },
          },
        }),
      });

      await assert.rejects(
        () => reader.validateSubject(subject),
        (error) => error.code === "INVALID_FIELD"
          && error.status === 409
          && !error.message.includes(scenario.appName),
      );
    });
  }
});

test("rejects enabled subjects when the configured trigger field or option is missing", async (t) => {
  const subject = {
    baseToken: "bas_demo",
    baseName: "课程库",
    tableId: "tbl_math",
    tableName: "小学数学",
    trigger: {
      fieldId: "fld_status",
      fieldName: "制作进度",
      startValue: "待制作",
      optionId: "opt_ready",
    },
  };

  for (const scenario of [
    { name: "field", fields: [{ field_id: "fld_other", field_name: "其他", type: 1 }] },
    { name: "option", fields: [{ field_id: "fld_status", field_name: "制作进度", type: 3, property: { options: [] } }] },
  ]) {
    await t.test(scenario.name, async () => {
      const reader = createFeishuBaseMetadataReader({
        client: fakeClient({
          tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
          fields: { tbl_math: { code: 0, data: { items: scenario.fields } } },
        }),
      });
      await assert.rejects(
        () => reader.validateSubject(subject),
        (error) => error.code === "INVALID_FIELD" && error.status === 409,
      );
    });
  }
});

test("validates a unique option by name when optionId is absent and allows plain text fields", async () => {
  const common = {
    baseToken: "bas_demo",
    baseName: "课程库",
    tableId: "tbl_math",
    tableName: "小学数学",
  };
  const optionReader = createFeishuBaseMetadataReader({
    client: fakeClient({
      tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
      fields: { tbl_math: { code: 0, data: { items: [{
        field_id: "fld_status",
        field_name: "制作进度",
        type: 3,
        property: { options: [{ id: "opt_ready", name: "待制作" }] },
      }] } } },
    }),
  });
  await optionReader.validateSubject({
    ...common,
    trigger: { fieldId: "fld_status", fieldName: "制作进度", startValue: "待制作", optionId: null },
  });

  const textReader = createFeishuBaseMetadataReader({
    client: fakeClient({
      tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
      fields: { tbl_math: { code: 0, data: { items: [{
        field_id: "fld_status",
        field_name: "制作进度",
        type: 1,
      }] } } },
    }),
  });
  await textReader.validateSubject({
    ...common,
    trigger: { fieldId: "fld_status", fieldName: "制作进度", startValue: "待制作", optionId: null },
  });
});

test("rejects an ambiguous name-only start option", async () => {
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
      fields: { tbl_math: { code: 0, data: { items: [{
        field_id: "fld_status",
        field_name: "制作进度",
        type: 3,
        property: { options: [
          { id: "opt_ready_a", name: "待制作" },
          { id: "opt_ready_b", name: "待制作" },
        ] },
      }] } } },
    }),
  });
  await assert.rejects(
    () => reader.validateSubject({
      baseToken: "bas_demo",
      baseName: "课程库",
      tableId: "tbl_math",
      tableName: "小学数学",
      trigger: { fieldId: "fld_status", fieldName: "制作进度", startValue: "待制作", optionId: null },
    }),
    (error) => error.code === "INVALID_FIELD" && error.status === 409,
  );
});

test("rejects a select trigger field whose current option list is empty", async () => {
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      tables: { code: 0, data: { items: [{ table_id: "tbl_math", name: "小学数学" }] } },
      fields: { tbl_math: { code: 0, data: { items: [{
        field_id: "fld_status",
        field_name: "制作进度",
        type: 3,
        ui_type: "SingleSelect",
        property: { options: [] },
      }] } } },
    }),
  });

  await assert.rejects(
    () => reader.validateSubject({
      baseToken: "bas_demo",
      baseName: "课程库",
      tableId: "tbl_math",
      tableName: "小学数学",
      trigger: { fieldId: "fld_status", fieldName: "制作进度", startValue: "待制作", optionId: null },
    }),
    (error) => error.code === "INVALID_FIELD" && error.status === 409,
  );
});

test("turns SDK-thrown metadata failures into a safe coded error", async () => {
  const sdkFailure = Object.assign(
    new Error("permission response with secret tenant details"),
    { code: "FEISHU_METADATA_READ_FAILED", status: 502 },
  );
  const thrownClient = createFeishuBaseMetadataReader({
    client: {
      bitable: { v1: {
        app: { get: async () => { throw sdkFailure; } },
        appTable: { list: async () => ({ code: 0, data: { items: [] } }) },
        appTableField: { list: async () => ({ code: 0, data: { items: [] } }) },
      } },
    },
  });

  await assert.rejects(
    () => thrownClient.validateSubject({
      baseToken: "bas_demo",
      baseName: "课程库",
      tableId: "tbl_math",
      tableName: "小学数学",
      trigger: { fieldId: "fld_status", fieldName: "制作进度", startValue: "待制作", optionId: null },
    }),
    (error) => error.code === "FEISHU_METADATA_READ_FAILED"
      && error.status === 502
      && !error.message.includes("secret"),
  );
});

test("turns non-zero SDK responses into safe, coded failures", async () => {
  const reader = createFeishuBaseMetadataReader({
    client: fakeClient({
      app: { code: 999001, msg: "secret app token should not leak" },
    }),
  });
  await assert.rejects(
    () => reader.preview("https://example.feishu.cn/base/bas_demo"),
    (error) => error.code === "FEISHU_METADATA_READ_FAILED"
      && error.message === "Feishu Base metadata request failed"
      && !error.message.includes("secret"),
  );
});

test("follows table and field metadata pages without repeating the original page token", async () => {
  const calls = [];
  let tablePage = 0;
  let fieldPage = 0;
  const reader = createFeishuBaseMetadataReader({
    client: {
      bitable: { v1: {
        app: { get: async () => ({ code: 0, data: { app: { app_token: "bas_demo", name: "演示库" } } }) },
        appTable: { list: async (request) => {
          calls.push(["tables", request]);
          tablePage += 1;
          return tablePage === 1
            ? { code: 0, data: { items: [{ table_id: "tbl_demo", name: "演示" }], has_more: true, page_token: "tables-next" } }
            : { code: 0, data: { items: [{ table_id: "tbl_extra", name: "附加" }], has_more: false } };
        } },
        appTableField: { list: async (request) => {
          calls.push(["fields", request]);
          fieldPage += 1;
          return fieldPage === 1
            ? { code: 0, data: { items: [{ field_id: "fld_a", field_name: "A", type: 1 }], has_more: true, page_token: "fields-next" } }
            : { code: 0, data: { items: [{ field_id: "fld_b", field_name: "B", type: 1 }], has_more: false } };
        } },
      },
    },
    },
  });
  const result = await reader.preview("https://example.feishu.cn/base/bas_demo?table=tbl_demo");
  assert.deepEqual(result.tables[0].fields.map((field) => field.fieldId), ["fld_a", "fld_b"]);
  assert.deepEqual(calls, [
    ["tables", { path: { app_token: "bas_demo" } }],
    ["tables", { path: { app_token: "bas_demo" }, params: { page_token: "tables-next" } }],
    ["fields", { path: { app_token: "bas_demo", table_id: "tbl_demo" } }],
    ["fields", { path: { app_token: "bas_demo", table_id: "tbl_demo" }, params: { page_token: "fields-next" } }],
  ]);
});
