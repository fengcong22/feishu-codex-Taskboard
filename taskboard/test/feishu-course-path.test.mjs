import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalCoursePathKey,
  deriveCourseDestinations,
  deriveFinalDirectoryDestination,
  deriveStageDestination,
  normalizeCourseName,
  previewCoursePath,
} from "../server/feishu-course-path.mjs";

test("preview keeps a mapped drive for operations and shows the UNC share onward", async () => {
  const result = await previewCoursePath(
    { rootPath: "W:\\【--剪映草稿--】", courseName: "课程001" },
    {
      classifyDrive: async () => "network",
      resolveMappedDrive: async () => "\\\\nas.example\\学科实拍素材临时传输",
    },
  );

  assert.deepEqual(result, {
    actualRoot: "W:\\【--剪映草稿--】",
    coursePath: "W:\\【--剪映草稿--】\\课程001",
    displayPath: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
    pathKind: "network",
    canonicalLocationKey: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
  });
});

test("preview retains a mapped share subdirectory in the display path", async () => {
  const result = await previewCoursePath(
    { rootPath: "W:\\待交付", courseName: "课程001" },
    {
      classifyDrive: async () => "network",
      resolveMappedDrive: async () => "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】",
    },
  );

  assert.equal(result.displayPath, "学科实拍素材临时传输\\【--剪映草稿--】\\待交付\\课程001");
  assert.equal(
    result.canonicalLocationKey,
    "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\待交付\\课程001",
  );
});

test("preview removes only a local drive prefix from the display path", async () => {
  const result = await previewCoursePath(
    { rootPath: "D:/交付", courseName: "课程001" },
    {
      classifyDrive: async () => "local",
      resolveMappedDrive: async () => {
        throw new Error("local roots must not resolve a network mapping");
      },
    },
  );

  assert.deepEqual(result, {
    actualRoot: "D:\\交付",
    coursePath: "D:\\交付\\课程001",
    displayPath: "交付\\课程001",
    pathKind: "local",
    canonicalLocationKey: "d:\\交付\\课程001",
  });
});

test("preview normalizes a harmless trailing root separator", async () => {
  const result = await previewCoursePath(
    { rootPath: "D:\\交付\\", courseName: "课程001" },
    { classifyDrive: async () => "local", resolveMappedDrive: async () => null },
  );

  assert.equal(result.actualRoot, "D:\\交付");
  assert.equal(result.coursePath, "D:\\交付\\课程001");
});

test("preview handles a configured UNC root without a drive lookup", async () => {
  const result = await previewCoursePath(
    { rootPath: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】", courseName: "课程001" },
    {
      classifyDrive: async () => {
        throw new Error("UNC roots do not use drive classification");
      },
      resolveMappedDrive: async () => {
        throw new Error("UNC roots do not resolve a mapped drive");
      },
    },
  );

  assert.deepEqual(result, {
    actualRoot: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】",
    coursePath: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
    displayPath: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
    pathKind: "unc",
    canonicalLocationKey: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
  });
});

test("preview rejects a mapped drive without a current UNC mapping", async () => {
  await assert.rejects(
    previewCoursePath(
      { rootPath: "W:\\交付", courseName: "课程001" },
      { classifyDrive: async () => "network", resolveMappedDrive: async () => null },
    ),
    { code: "NETWORK_ROOT_UNRESOLVED" },
  );
});

test("preview rejects an unknown drive kind instead of treating it as local", async () => {
  await assert.rejects(
    previewCoursePath(
      { rootPath: "W:\\交付", courseName: "课程001" },
      { classifyDrive: async () => "unknown", resolveMappedDrive: async () => "\\\\nas.example\\share" },
    ),
    { code: "ROOT_PATH_KIND_UNKNOWN" },
  );
});

test("course names reject Windows-invalid, ambiguous, and path-escaping values", () => {
  for (const value of [
    "",
    "   ",
    ".",
    "..",
    "课程/001",
    "课程\\001",
    "课程:001",
    "课程.",
    "课程 ",
    "CON",
    "aux.txt",
    `课程${"x".repeat(256)}`,
  ]) {
    assert.throws(() => normalizeCourseName(value), { code: "COURSE_NAME_INVALID" }, value);
  }

  assert.equal(normalizeCourseName("课程001"), "课程001");
});

test("preview rejects roots and course paths that can escape or exceed Windows path limits", async () => {
  await assert.rejects(
    previewCoursePath(
      { rootPath: "D:\\delivery\\..\\outside", courseName: "课程001" },
      { classifyDrive: async () => "local", resolveMappedDrive: async () => null },
    ),
    { code: "ROOT_PATH_INVALID" },
  );

  await assert.rejects(
    previewCoursePath(
      { rootPath: `D:\\${"a".repeat(253)}`, courseName: "课程001" },
      { classifyDrive: async () => "local", resolveMappedDrive: async () => null },
    ),
    { code: "COURSE_PATH_TOO_LONG" },
  );
});

test("canonical path keys are case-insensitive for Windows collision checks", async () => {
  const [first, second] = await Promise.all([
    previewCoursePath(
      { rootPath: "D:\\交付", courseName: "课程001" },
      { classifyDrive: async () => "local", resolveMappedDrive: async () => null },
    ),
    previewCoursePath(
      { rootPath: "d:\\交付", courseName: "课程001" },
      { classifyDrive: async () => "local", resolveMappedDrive: async () => null },
    ),
  ]);

  assert.equal(first.canonicalLocationKey, second.canonicalLocationKey);
  assert.equal(canonicalCoursePathKey("D:/交付/课程001"), first.canonicalLocationKey);
});

test("fixed delivery directories derive without filesystem access", () => {
  const binding = { coursePath: "W:\\【--剪映草稿--】\\课程001" };

  assert.deepEqual(deriveCourseDestinations(binding), {
    final: "W:\\【--剪映草稿--】\\课程001\\00成片",
    initial: "W:\\【--剪映草稿--】\\课程001\\01初稿",
    first_review: "W:\\【--剪映草稿--】\\课程001\\02初审",
    final_review: "W:\\【--剪映草稿--】\\课程001\\03终审",
  });
  assert.equal(deriveStageDestination(binding, "initial"), "W:\\【--剪映草稿--】\\课程001\\01初稿");
  assert.equal(deriveStageDestination(binding, "first_review"), "W:\\【--剪映草稿--】\\课程001\\02初审");
  assert.equal(deriveStageDestination(binding, "final_review"), "W:\\【--剪映草稿--】\\课程001\\03终审");
  assert.equal(deriveFinalDirectoryDestination(binding), "W:\\【--剪映草稿--】\\课程001\\00成片");
  assert.throws(() => deriveStageDestination(binding, "other"), { code: "STAGE_ID_INVALID" });
  assert.throws(() => deriveStageDestination({ coursePath: "relative\\课程001" }, "initial"), { code: "COURSE_PATH_INVALID" });
});
