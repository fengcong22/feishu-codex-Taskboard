import assert from "node:assert/strict";
import { test } from "node:test";

const modulePath = "../server/feishu-vm-delivery-plan.mjs";
const metadata = { fields: [
  { fieldId: "name", type: 1, uiType: "Text" },
  { fieldId: "formula", type: 20, uiType: "Formula" },
  { fieldId: "directory", type: 20, uiType: "Formula" },
  { fieldId: "directory_text", type: 1, uiType: "Text" },
] };
const record = { baseToken: "bas_test", tableId: "tbl_test", recordId: "rec_test" };
const archive = { enabled: true, statusFieldId: "status", triggerOptionId: "finished", pathSource: "manual", directoryPath: "\\\\nas.example\\交付\\具体目录", pathFieldId: null };
const namingConfig = (fieldId) => ({ fields: { namingFieldId: fieldId } });
const delivered = {
  status: "confirmed", artifactKind: "review_mp4", record,
  artifactId: "artifact_2", runId: "run_2", deliveryId: "delivery_2",
  localPath: "C:\\controlled\\run_2\\output.mp4", sha256: "a".repeat(64), bytes: 120,
};
function planInput() {
  return { config: { fields: { namingFieldId: "formula" }, finalArchive: { ...archive } }, metadata: structuredClone(metadata), record: { ...record },
    fields: { directory: "\\\\nas.example\\交付\\字段目录", formula: [{ type: "text", text: "牛顿定律.mp4" }] },
    latestDeliveredVideo: structuredClone(delivered) };
}

test("stages and final archive share one name field while retaining only their required suffixes", async () => {
  const { resolveVmStageFilename } = await import(modulePath);
  assert.equal(resolveVmStageFilename({ stageId: "initial", config: namingConfig("name"), metadata, fields: { name: "牛顿定律" } }), "牛顿定律_初稿.mp4");
  const shared = planInput();
  assert.equal(resolveVmStageFilename({ ...shared, stageId: "initial" }), "牛顿定律_初稿.mp4");
  for (const reviewRound of [1, 2, 12]) {
    assert.equal(resolveVmStageFilename({ ...shared, stageId: "review", reviewRound }), `牛顿定律_第${reviewRound}稿.mp4`);
  }
  const { planVmFinalArchive } = await import(modulePath);
  assert.equal((await planVmFinalArchive(shared)).filename, "牛顿定律.mp4");
});

test("review retries keep their frozen round and numbering is never inferred from filename or attachment order", async () => {
  const { resolveVmStageFilename } = await import(modulePath);
  const input = { stageId: "review", reviewRound: 2, config: namingConfig("name"), metadata, fields: { name: "课程" } };
  assert.equal(resolveVmStageFilename(input), "课程_第2稿.mp4");
  assert.equal(resolveVmStageFilename(input), "课程_第2稿.mp4");
  for (const reviewRound of [undefined, null, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveVmStageFilename({ ...input, reviewRound }), { code: "VM_REVIEW_ROUND_INVALID" });
  }
});

test("long shared names retain the same complete stem in every stage and final archive", async () => {
  const { resolveVmStageFilename, planVmFinalArchive } = await import(modulePath);
  for (const name of ["长".repeat(220), "😀".repeat(220)]) {
    const input = planInput();
    input.fields.formula = name;
    const finalName = (await planVmFinalArchive(input)).filename;
    const stem = finalName.slice(0, -4);
    const initial = resolveVmStageFilename({ ...input, stageId: "initial" });
    assert.equal(initial, `${stem}_初稿.mp4`);
    for (const reviewRound of [1, 12, Number.MAX_SAFE_INTEGER]) {
      const review = resolveVmStageFilename({ ...input, stageId: "review", reviewRound });
      assert.equal(review, `${stem}_第${reviewRound}稿.mp4`);
      assert.ok(review.length <= 180);
      assert.equal(review.isWellFormed(), true);
    }
    assert.ok(finalName.length <= 180);
    assert.equal(finalName.isWellFormed(), true);
  }
});

test("file names stay one Windows segment and preserve the suffix within the length limit", async () => {
  const { resolveVmStageFilename } = await import(modulePath);
  const filename = resolveVmStageFilename({ stageId: "initial", config: namingConfig("name"), metadata, fields: { name: " ../课:程\\一? " } });
  assert.equal(filename, "_课_程_一__初稿.mp4");
  const long = resolveVmStageFilename({ stageId: "review", reviewRound: 123, config: namingConfig("name"), metadata, fields: { name: "😀".repeat(220) } });
  assert.ok(long.length <= 180);
  assert.equal(long.isWellFormed(), true);
  assert.equal(long.endsWith("_第123稿.mp4"), true);
  const initial = resolveVmStageFilename({ stageId: "initial", config: namingConfig("name"), metadata, fields: { name: "😀".repeat(220) } });
  assert.ok(initial.length <= 180);
  assert.equal(initial.isWellFormed(), true);
  assert.equal(initial.endsWith("_初稿.mp4"), true);
});

test("Windows device names gain the same safe prefix in every output", async () => {
  const { resolveVmStageFilename, planVmFinalArchive } = await import(modulePath);
  for (const name of ["CON", "COM1", "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³", "CONIN$", "CONOUT$", "CON .txt", "NUL .txt", "COM1 .txt"]) {
    const input = planInput();
    input.fields.formula = name;
    assert.equal((await planVmFinalArchive(input)).filename, `_${name}.mp4`);
    assert.equal(resolveVmStageFilename({ ...input, stageId: "initial" }), `_${name}_初稿.mp4`);
    assert.equal(resolveVmStageFilename({ ...input, stageId: "review", reviewRound: 1 }), `_${name}_第1稿.mp4`);
  }
});

test("naming rejects absent fields, duplicate or contradictory metadata, non-text values and formula errors", async () => {
  const { resolveVmStageFilename } = await import(modulePath);
  const input = { stageId: "initial", config: namingConfig("formula"), metadata, fields: { formula: "名称" } };
  for (const value of ["", " ", 42, null, ["名称"], [{ text: "一" }, { text: "二" }], "#VALUE!", "#ERROR!", { text: "名称" }]) {
    assert.throws(() => resolveVmStageFilename({ ...input, fields: { formula: value } }), { code: "VM_NAMING_VALUE_INVALID" });
  }
  assert.throws(() => resolveVmStageFilename({ ...input, fields: { "公式显示名": "名称" } }), { code: "VM_NAMING_VALUE_INVALID" });
  for (const fields of [[], [metadata.fields[1], metadata.fields[1]], [{ fieldId: "formula", type: 1, uiType: "Formula" }], [{ fieldId: "formula", type: 2, uiType: "Number" }]]) {
    assert.throws(() => resolveVmStageFilename({ ...input, metadata: { fields } }), { code: "VM_NAMING_FIELD_INVALID" });
  }
});

test("final archive plans use the exact directory and retain the confirmed MP4 identity without course folders", async () => {
  const { planVmFinalArchive } = await import(modulePath);
  const input = planInput();
  const result = await planVmFinalArchive(input);
  assert.equal(result.destinationDirectory, "\\\\nas.example\\交付\\具体目录");
  assert.equal(result.destinationPath, "\\\\nas.example\\交付\\具体目录\\牛顿定律.mp4");
  assert.equal(result.canonicalLocationKey, "\\\\nas.example\\交付\\具体目录\\牛顿定律.mp4");
  assert.equal(Object.hasOwn(result, "coursePath"), false);
  assert.equal(result.source.sha256, delivered.sha256);
  assert.equal(result.source.deliveryId, "delivery_2");
  assert.equal(result.source.runId, "run_2");
  input.latestDeliveredVideo.sha256 = "b".repeat(64);
  input.fields.formula = "新名称";
  assert.equal(result.source.sha256, delivered.sha256);
  assert.equal(result.filename, "牛顿定律.mp4");
  assert.equal(Object.isFrozen(result.source), true);
  assert.equal(Object.isFrozen(result), true);
});

test("mapped NAS paths keep operational drive letters but use the canonical UNC identity", async () => {
  const { planVmFinalArchive } = await import(modulePath);
  const input = planInput(); input.config.finalArchive.directoryPath = "W:\\成片";
  const result = await planVmFinalArchive(input, {
    classifyDrive: async () => "network", resolveMappedDrive: async () => "\\\\nas.example\\教学素材",
  });
  assert.equal(result.destinationPath, "W:\\成片\\牛顿定律.mp4");
  assert.equal(result.canonicalLocationKey, "\\\\nas.example\\教学素材\\成片\\牛顿定律.mp4");
});

test("archive never guesses the latest video from attachments and blocks unconfirmed or other-record sources", async () => {
  const { planVmFinalArchive } = await import(modulePath);
  for (const patch of [null, { status: "uploaded" }, { artifactKind: "draft_zip" }, { sha256: "bad" }, { bytes: 0 }, { deliveryId: "" }, { localPath: "relative.mp4" }, { localPath: "C:\\output.zip" }, { record: { ...record, recordId: "other" } }]) {
    const input = planInput();
    input.latestDeliveredVideo = patch === null ? null : { ...input.latestDeliveredVideo, ...patch };
    input.fields.attachments = ["latest.mp4"];
    await assert.rejects(planVmFinalArchive(input), { code: "VM_ARCHIVE_SOURCE_INVALID" });
  }
});

test("invalid directory paths and total destination lengths block planning without touching storage", async () => {
  const { planVmFinalArchive } = await import(modulePath);
  for (const directoryPath of ["relative", "C:\\交付\\..\\other", "\\\\nas.example\\..\\other", "\\\\nas.example", "C:\\bad\0path"]) {
    const input = planInput(); input.config.finalArchive.directoryPath = directoryPath;
    await assert.rejects(planVmFinalArchive(input), { code: "ROOT_PATH_INVALID" });
  }
  const input = planInput(); input.config.finalArchive.directoryPath = `\\\\nas.example\\share\\${"课".repeat(180)}`; input.fields.formula = "片".repeat(150);
  await assert.rejects(planVmFinalArchive(input), { code: "COURSE_PATH_TOO_LONG" });
});

test("PMO directory fields resolve strictly by the selected field ID with text and formula values", async () => {
  const { planVmFinalArchive } = await import(modulePath);
  for (const [pathFieldId, value] of [
    ["directory", "\\\\nas.example\\交付\\字段目录"],
    ["directory", [{ type: "text", text: "\\\\nas.example\\交付\\字段目录" }]],
    ["directory_text", "\\\\nas.example\\交付\\字段目录"],
  ]) {
    const input = planInput();
    input.config.finalArchive.pathSource = "pmo_field";
    input.config.finalArchive.pathFieldId = pathFieldId;
    input.fields[pathFieldId] = value;
    const result = await planVmFinalArchive(input);
    assert.equal(result.destinationPath, "\\\\nas.example\\交付\\字段目录\\牛顿定律.mp4");
    input.fields[pathFieldId] = "\\\\nas.example\\交付\\changed";
    assert.equal(result.destinationDirectory, "\\\\nas.example\\交付\\字段目录");
  }
  const manual = planInput();
  manual.config.finalArchive.pathFieldId = "missing";
  manual.fields.directory = "relative";
  assert.equal((await planVmFinalArchive(manual)).destinationDirectory, "\\\\nas.example\\交付\\具体目录");
});

test("both archive directory sources reject Windows device aliases before planning", async () => {
  const { planVmFinalArchive } = await import(modulePath);
  for (const name of ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³", "CONIN$", "CONOUT$", "CON .txt", "NUL .txt", "COM1 .txt"]) {
    for (const pathSource of ["manual", "pmo_field"]) {
      const input = planInput();
      input.config.finalArchive.pathSource = pathSource;
      input.config.finalArchive.pathFieldId = "directory";
      input.config.finalArchive.directoryPath = `\\\\nas.example\\share\\${name}`;
      input.fields.directory = input.config.finalArchive.directoryPath;
      await assert.rejects(planVmFinalArchive(input), { code: "ROOT_PATH_INVALID" }, `${pathSource}: ${name}`);
    }
  }
});

test("PMO directory mode blocks missing, ambiguous and malformed metadata without using manual fallback", async () => {
  const { planVmFinalArchive } = await import(modulePath);
  const input = planInput();
  input.config.finalArchive.pathSource = "pmo_field";
  input.config.finalArchive.pathFieldId = "directory";
  for (const fields of [[], [metadata.fields[2], metadata.fields[2]], [{ fieldId: "directory", type: 1, uiType: "Formula" }], [{ fieldId: "directory", type: 17, uiType: "Attachment" }]]) {
    await assert.rejects(planVmFinalArchive({ ...input, metadata: { fields } }), { code: "VM_ARCHIVE_PATH_FIELD_INVALID" });
  }
  for (const value of [null, 42, "", "#REF!", ["\\\\nas.example\\share"], { text: "\\\\nas.example\\share" }, [{ text: "\\\\nas.example\\share" }, { text: "extra" }]]) {
    await assert.rejects(planVmFinalArchive({ ...input, fields: { ...input.fields, directory: value } }), { code: "VM_ARCHIVE_PATH_VALUE_INVALID" });
  }
  const missing = { ...input, fields: { formula: input.fields.formula, "目录显示名": "\\\\nas.example\\share" } };
  await assert.rejects(planVmFinalArchive(missing), { code: "VM_ARCHIVE_PATH_VALUE_INVALID" });
  for (const value of ["relative", "C:relative", "C:\\..\\outside", "\\\\nas.example", "\\\\nas.example\\share\\..\\outside", "C:\\dir\0value"]) {
    await assert.rejects(planVmFinalArchive({ ...input, fields: { ...input.fields, directory: value } }));
  }
  input.config.finalArchive.pathSource = "other";
  await assert.rejects(planVmFinalArchive(input), { code: "VM_ARCHIVE_PATH_SOURCE_INVALID" });
});

test("archive transitions trigger only when the configured option is newly present", async () => {
  const { isVmFinalArchiveTransition } = await import(modulePath);
  const event = { fieldId: "status", beforeOptionIds: [], afterOptionIds: ["finished"] };
  assert.equal(isVmFinalArchiveTransition(archive, event), true);
  assert.equal(isVmFinalArchiveTransition(archive, { ...event, beforeOptionIds: ["other"], afterOptionIds: ["other", "finished"] }), true);
  assert.equal(isVmFinalArchiveTransition(archive, { ...event, beforeOptionIds: ["finished"] }), false);
  assert.equal(isVmFinalArchiveTransition(archive, { ...event, fieldId: "other" }), false);
  assert.equal(isVmFinalArchiveTransition(archive, { ...event, afterOptionIds: [] }), false);
  assert.equal(isVmFinalArchiveTransition({ ...archive, enabled: false }, event), false);
});
