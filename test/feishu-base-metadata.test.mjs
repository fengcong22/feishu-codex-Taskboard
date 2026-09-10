import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPhasedSubjectMetadata,
  comparePhasedSubjectMetadata,
  createFeishuBaseMetadataReader,
  parseBaseLink,
} from "../src/feishu-base-metadata.mjs";

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
