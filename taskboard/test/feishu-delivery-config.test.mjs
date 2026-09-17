import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeDeliveryConfig,
  validateDeliveryConfig,
} from "../shared/feishu-delivery-config.mjs";

const fields = [
  { fieldId: "fld_course_name", fieldName: "课程名称", type: 1, uiType: "Text" },
  { fieldId: "fld_formula_name", fieldName: "课程公式名称", type: 20, uiType: "Formula" },
  { fieldId: "fld_course_path", fieldName: "课程目录", type: 1, uiType: "Text" },
  {
    fieldId: "fld_status",
    fieldName: "当前状态",
    type: 3,
    uiType: "SingleSelect",
    options: [
      { id: "opt_editing", name: "自动剪辑中" },
      { id: "opt_initial_ready", name: "初稿完成" },
    ],
  },
  { fieldId: "fld_attachment", fieldName: "视频", type: 17, uiType: "Attachment" },
];

const enabledStages = {
  initial: { enabled: true },
  first_review: { enabled: false },
  final_review: { enabled: false },
};

function configuredDelivery(overrides = {}) {
  return {
    version: 1,
    rootPath: "W:\\学科实拍素材临时传输\\【--剪映草稿--】",
    courseNaming: { mode: "field", fieldId: "fld_course_name" },
    coursePathWriteback: { enabled: true, fieldId: "fld_course_path" },
    writeback: {
      initial: {
        onProcessing: [{ fieldId: "fld_status", optionId: "opt_editing" }],
        onUploaded: [{ fieldId: "fld_status", optionId: "opt_initial_ready" }],
      },
      first_review: { onProcessing: [], onUploaded: [] },
      final_review: { onProcessing: [], onUploaded: [] },
    },
    finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
    ...overrides,
  };
}

test("incomplete delivery is saveable as a draft but cannot activate", () => {
  const delivery = {
    version: 1,
    rootPath: null,
    courseNaming: { mode: "field", fieldId: null },
    coursePathWriteback: { enabled: false, fieldId: null },
    writeback: {
      initial: { onProcessing: [], onUploaded: [] },
      first_review: { onProcessing: [], onUploaded: [] },
      final_review: { onProcessing: [], onUploaded: [] },
    },
    finalDirectoryTrigger: { enabled: true, fieldId: null, optionId: null },
  };

  assert.deepEqual(
    validateDeliveryConfig(delivery, { mode: "draft", fields: [], stages: enabledStages, uploadEnabled: false }).issues,
    [],
  );
  const activation = validateDeliveryConfig(delivery, {
    mode: "activation",
    fields,
    stages: enabledStages,
    uploadEnabled: false,
  });
  assert.deepEqual(
    activation.issues.map((issue) => issue.path),
    ["delivery.rootPath", "delivery.courseNaming.fieldId", "delivery.finalDirectoryTrigger.fieldId", "delivery.finalDirectoryTrigger.optionId"],
  );
});

test("delivery rejects unsupported keys, unsafe paths, and malformed assignments in every mode", () => {
  assert.throws(
    () => normalizeDeliveryConfig({ version: 1, unexpected: true }),
    (error) => error.code === "DELIVERY_CONFIG_INVALID" && /unexpected/u.test(error.message),
  );
  assert.throws(
    () => normalizeDeliveryConfig(configuredDelivery({ rootPath: "relative\\output" })),
    (error) => error.code === "DELIVERY_CONFIG_INVALID" && /rootPath/u.test(error.message),
  );
  assert.throws(
    () => normalizeDeliveryConfig(configuredDelivery({
      writeback: {
        initial: { onProcessing: [{ fieldId: "fld_status", optionId: "opt_editing", text: "no" }], onUploaded: [] },
        first_review: { onProcessing: [], onUploaded: [] },
        final_review: { onProcessing: [], onUploaded: [] },
      },
    })),
    (error) => error.code === "DELIVERY_CONFIG_INVALID" && /text/u.test(error.message),
  );
});

test("activation accepts a text or formula course naming field", () => {
  const text = validateDeliveryConfig(configuredDelivery(), {
    mode: "activation",
    fields,
    stages: enabledStages,
    uploadEnabled: true,
  });
  assert.deepEqual(text.issues, []);

  const formula = validateDeliveryConfig(configuredDelivery({
    courseNaming: { mode: "field", fieldId: "fld_formula_name" },
  }), {
    mode: "activation",
    fields,
    stages: enabledStages,
    uploadEnabled: true,
  });
  assert.deepEqual(formula.issues, []);
});

test("activation validates existing writeback fields and options", () => {
  const invalid = validateDeliveryConfig(configuredDelivery({
    coursePathWriteback: { enabled: true, fieldId: "fld_formula_name" },
    writeback: {
      initial: {
        onProcessing: [{ fieldId: "fld_attachment", optionId: "opt_editing" }],
        onUploaded: [{ fieldId: "fld_status", optionId: "opt_missing" }],
      },
      first_review: { onProcessing: [], onUploaded: [] },
      final_review: { onProcessing: [], onUploaded: [] },
    },
  }), {
    mode: "activation",
    fields,
    stages: enabledStages,
    uploadEnabled: true,
  });

  assert.deepEqual(
    invalid.issues.map((issue) => [issue.code, issue.path]),
    [
      ["WRITEBACK_FIELD_TYPE_INVALID", "delivery.coursePathWriteback.fieldId"],
      ["WRITEBACK_FIELD_TYPE_INVALID", "delivery.writeback.initial.onProcessing[0].fieldId"],
      ["WRITEBACK_OPTION_NOT_FOUND", "delivery.writeback.initial.onUploaded[0].optionId"],
    ],
  );
});

test("disabled stages retain their draft writeback choices without blocking activation", () => {
  const result = validateDeliveryConfig(configuredDelivery({
    writeback: {
      initial: { onProcessing: [], onUploaded: [] },
      first_review: {
        onProcessing: [{ fieldId: "fld_attachment", optionId: "opt_missing" }],
        onUploaded: [],
      },
      final_review: { onProcessing: [], onUploaded: [] },
    },
  }), {
    mode: "activation",
    fields,
    stages: enabledStages,
    uploadEnabled: true,
  });
  assert.deepEqual(result.issues, []);
});

test("upload dependencies are checked only when a delivery action needs them", () => {
  const processingOnly = configuredDelivery({
    rootPath: null,
    courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
    coursePathWriteback: { enabled: false, fieldId: null },
    writeback: {
      initial: { onProcessing: [{ fieldId: "fld_status", optionId: "opt_editing" }], onUploaded: [] },
      first_review: { onProcessing: [], onUploaded: [] },
      final_review: { onProcessing: [], onUploaded: [] },
    },
  });
  assert.deepEqual(validateDeliveryConfig(processingOnly, {
    mode: "activation",
    fields,
    stages: enabledStages,
    uploadEnabled: false,
  }).issues, []);

  const uploadRequired = validateDeliveryConfig(configuredDelivery(), {
    mode: "activation",
    fields,
    stages: enabledStages,
    uploadEnabled: false,
  });
  assert.deepEqual(
    uploadRequired.issues.map((issue) => issue.path),
    ["upload.enabled", "delivery.coursePathWriteback.enabled", "delivery.writeback.initial.onUploaded"],
  );
});

test("omitted delivery stays compatible with existing subjects", () => {
  assert.equal(normalizeDeliveryConfig(undefined), null);
  assert.deepEqual(
    validateDeliveryConfig(undefined, { mode: "activation", fields, stages: enabledStages, uploadEnabled: true }),
    { value: null, issues: [] },
  );
});
