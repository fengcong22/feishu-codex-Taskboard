import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SubjectVersionHistory } from "../src/subject-version-history.mjs";

function version(configVersion, overrides = {}) {
  return {
    subjectKey: "bas_demo:tbl_math",
    configVersion,
    lifecycle: "enabled",
    enabledAt: configVersion === 7 ? 1000 : 2000,
    closedAt: null,
    statusField: { fieldId: "fld_status" },
    documentField: { fieldId: `fld_document_v${configVersion}` },
    namingField: { fieldId: `fld_name_v${configVersion}` },
    stages: {},
    ...overrides,
  };
}

test("retains immutable enabled intervals for delayed events and retries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-subject-history-"));
  const history = new SubjectVersionHistory(path.join(dir, "workflow.json"));
  await history.syncSubject(version(7, { closedAt: 2000 }));
  await history.syncSubject(version(8, { lifecycle: "disabled", enabledAt: 2000 }));
  assert.equal((await history.resolveSubjectVersionAt("bas_demo:tbl_math", 1500)).configVersion, 7);
  assert.equal((await history.getSubjectVersion("bas_demo:tbl_math", 7)).documentField.fieldId, "fld_document_v7");
  assert.equal(await history.resolveSubjectVersionAt("bas_demo:tbl_math", 2500), null);
});

test("does not rewrite an old version when current config is edited", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-subject-history-"));
  const history = new SubjectVersionHistory(path.join(dir, "workflow.json"));
  await history.syncSubject(version(7, { closedAt: null }));
  await history.saveDraft("bas_demo:tbl_math", { documentField: { fieldId: "fld_document_v8" } });
  assert.equal((await history.getSubjectVersion("bas_demo:tbl_math", 7)).documentField.fieldId, "fld_document_v7");
});
