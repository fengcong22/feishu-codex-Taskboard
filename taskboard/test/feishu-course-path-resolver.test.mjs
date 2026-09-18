import assert from "node:assert/strict";
import { test } from "node:test";

import { createWindowsCoursePathResolver } from "../server/feishu-course-path-resolver.mjs";

function fakeExec({ stdout = "", error = null } = {}) {
  return async (command, argumentsList, options) => {
    assert.equal(command, "powershell.exe");
    assert.deepEqual(argumentsList.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(options.windowsHide, true);
    if (error) throw error;
    return { stdout };
  };
}

test("classifies a local configured root without placing it in a shell command", async () => {
  const resolver = createWindowsCoursePathResolver({
    platform: "win32",
    execFile: fakeExec({ stdout: JSON.stringify({ DeviceID: "D:", DriveType: 3, ProviderName: null }) }),
  });

  assert.equal(await resolver.classifyDrive("D:\\交付根目录"), "local");
});

test("resolves a mapped drive to its UNC share root", async () => {
  const resolver = createWindowsCoursePathResolver({
    platform: "win32",
    execFile: fakeExec({ stdout: JSON.stringify({
      DeviceID: "W:", DriveType: 4, ProviderName: "\\\\nas-server\\学科实拍素材临时传输",
    }) }),
  });

  assert.equal(await resolver.classifyDrive("W:\\【--剪映草稿--】"), "network");
  assert.equal(
    await resolver.resolveMappedDrive("W:\\【--剪映草稿--】"),
    "\\\\nas-server\\学科实拍素材临时传输",
  );
});

test("requests UTF-8 output before reading a mapped drive UNC name", async () => {
  let script = null;
  const resolver = createWindowsCoursePathResolver({
    platform: "win32",
    execFile: async (command, argumentsList) => {
      assert.equal(command, "powershell.exe");
      script = argumentsList.at(-1);
      return { stdout: JSON.stringify({
        DeviceID: "W:",
        DriveType: 4,
        ProviderName: "\\\\nas-server\\学科实拍素材临时传输",
      }) };
    },
  });

  await resolver.resolveMappedDrive("W:\\【--剪映草稿--】");

  assert.match(script, /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/u);
});

test("rejects a network drive whose UNC mapping cannot be resolved", async () => {
  const resolver = createWindowsCoursePathResolver({
    platform: "win32",
    execFile: fakeExec({ stdout: JSON.stringify({ DeviceID: "W:", DriveType: 4, ProviderName: null }) }),
  });

  await assert.rejects(
    () => resolver.resolveMappedDrive("W:\\【--剪映草稿--】"),
    { code: "NETWORK_ROOT_UNRESOLVED" },
  );
});

test("fails closed when the Taskboard is not running on Windows", async () => {
  const resolver = createWindowsCoursePathResolver({ platform: "linux", execFile: fakeExec() });
  await assert.rejects(() => resolver.classifyDrive("D:\\交付根目录"), { code: "ROOT_PATH_PLATFORM_UNSUPPORTED" });
});
