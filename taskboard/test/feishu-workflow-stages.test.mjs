import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizePhasedSubjectPatch, validatePhasedSubjectConfig } from "../server/feishu-workflow-stages.mjs";

function fixture() {
  const stage = (fieldId, optionId) => ({
    enabled: true,
    trigger: { fieldId, fieldName: fieldId, optionId, value: optionId },
    videoSource: { kind: "docx_section", anchorText: "video" },
    reviewSource: { kind: "docx_section", anchorText: "review" },
    audio: { mode: "video_original" }, artifactTargetPath: null, nameSuffix: "_stage",
  });
  return {
    statusField: { fieldId: "fld_initial", fieldName: "fld_initial" },
    reviewStatusField: { fieldId: "fld_review", fieldName: "fld_review" },
    documentField: { fieldId: "fld_doc", fieldName: "doc" },
    namingField: { fieldId: "fld_doc", fieldName: "doc" },
    metadata: { fields: [
      ...["fld_initial", "fld_review"].map((fieldId) => ({ fieldId, fieldName: fieldId, type: 3,
        options: ["opt_a", "opt_b", "opt_c"].map((id) => ({ id, name: id })),
      })),
      { fieldId: "fld_doc", fieldName: "doc", type: 1 },
    ] },
    stages: {
      initial: stage("fld_initial", "opt_a"),
      first_review: stage("fld_review", "opt_a"),
      final_review: stage("fld_review", "opt_b"),
    },
  };
}

test("phased validation supports independent initial and review fields with field-scoped option IDs", () => {
  const value = fixture();
  assert.deepEqual(validatePhasedSubjectConfig(value).reviewStatusField, value.reviewStatusField);
  value.stages.final_review.trigger.optionId = "opt_a";
  assert.throws(() => validatePhasedSubjectConfig(value), /unique/u);
});

test("review fields are single select and options must exist in their own field", () => {
  const value = fixture();
  value.metadata.fields[1].options = [{ id: "opt_b", name: "opt_b" }];
  assert.throws(() => validatePhasedSubjectConfig(value), { code: "TRIGGER_OPTION_NOT_FOUND" });
  value.metadata.fields[1].type = 1;
  assert.throws(() => validatePhasedSubjectConfig(value), { code: "FIELD_TYPE_INVALID" });
});

test("legacy omitted review field falls back but explicit empty review cannot rebind", () => {
  const value = fixture();
  delete value.reviewStatusField;
  for (const [index, stage] of Object.values(value.stages).entries()) {
    stage.trigger = { fieldId: "fld_initial", fieldName: "fld_initial", optionId: `opt_${String.fromCharCode(97 + index)}`, value: `opt_${String.fromCharCode(97 + index)}` };
  }
  assert.doesNotThrow(() => validatePhasedSubjectConfig(value));
  value.reviewStatusField = { fieldId: null, fieldName: null };
  assert.throws(() => validatePhasedSubjectConfig(value), /reviewStatusField/u);
});

test("review field aliases normalize and reject conflicting representations", () => {
  assert.deepEqual(canonicalizePhasedSubjectPatch({ reviewStatusField: { field_id: "fld_review", field_name: "Review" } }),
    { reviewStatusField: { fieldId: "fld_review", fieldName: "Review" } });
  assert.throws(() => canonicalizePhasedSubjectPatch({ reviewStatusField: { fieldId: "fld_review", field_id: "fld_other" } }), /multiple representations/u);
});
