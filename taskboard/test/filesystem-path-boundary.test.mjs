import assert from "node:assert/strict";
import test from "node:test";
import { isSameFilesystemPath, isStrictDescendantPath } from "../server/filesystem-path-boundary.mjs";

test("Windows canonical path comparison accepts ordinary and extended forms of the same file", () => {
  const ordinary = "D:\\a\\_temp\\vm-output\\source.mp4";
  const extended = "\\\\?\\D:\\a\\_temp\\vm-output\\source.mp4";

  assert.equal(isSameFilesystemPath(extended, ordinary, "win32"), true);
  assert.equal(isSameFilesystemPath(ordinary, extended, "win32"), true);
  assert.equal(isSameFilesystemPath(extended, "\\\\?\\E:\\a\\_temp\\vm-output\\source.mp4", "win32"), false);
});

test("Windows descendant checks accept mixed extended and ordinary absolute path forms", () => {
  const ordinaryRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\materials";
  const extendedRoot = "\\\\?\\C:\\Users\\runneradmin\\AppData\\Local\\Temp\\materials";
  const ordinaryChild = `${ordinaryRoot}\\vm-0123456789abcdef01234567-job`;
  const extendedChild = `${extendedRoot}\\vm-0123456789abcdef01234567-job`;

  assert.equal(isStrictDescendantPath(extendedRoot, ordinaryChild, "win32"), true);
  assert.equal(isStrictDescendantPath(ordinaryRoot, extendedChild, "win32"), true);
});

test("descendant checks continue to reject the parent, siblings, and another Windows volume", () => {
  const root = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\materials";

  assert.equal(isStrictDescendantPath(root, root, "win32"), false);
  assert.equal(isStrictDescendantPath(root, "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\materials-old\\vm-job", "win32"), false);
  assert.equal(isStrictDescendantPath(root, "C:\\Users\\runneradmin\\AppData\\Local\\Temp", "win32"), false);
  assert.equal(isStrictDescendantPath(root, "D:\\materials\\vm-job", "win32"), false);
  assert.equal(isStrictDescendantPath(root, `${root}\\vm-job`, "win32"), true);
});

test("POSIX descendant checks reject sibling-prefix paths", () => {
  assert.equal(isStrictDescendantPath("/tmp/materials", "/tmp/materials/vm-job", "linux"), true);
  assert.equal(isStrictDescendantPath("/tmp/materials", "/tmp/materials-old/vm-job", "linux"), false);
});
