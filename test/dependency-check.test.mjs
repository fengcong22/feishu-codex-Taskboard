import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileCodexFixture, installCodexFixture, powershell } from "./helpers/codex-cli-fixture.mjs";

test("dependency-only check validates a Desktop-only CLI without config, services or session overrides", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-dependency-check-"));
  const project = join(directory, "示例 project's & path");
  try {
    const template = await compileCodexFixture(directory);
    await mkdir(join(project, "scripts"), { recursive: true });
    await copyFile(new URL("../scripts/check-local.ps1", import.meta.url), join(project, "scripts", "check-local.ps1"));
    await copyFile(new URL("../scripts/codex-discovery.ps1", import.meta.url), join(project, "scripts", "codex-discovery.ps1"));
    const nodeDirectory = join(directory, "node");
    await mkdir(nodeDirectory);
    await copyFile(process.execPath, join(nodeDirectory, "node.exe"));
    const localAppData = join(directory, "local");
    const cli = await installCodexFixture(template, join(localAppData, "OpenAI", "Codex", "bin", "desktop-version", "codex.exe"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (["path", "codex_executable", "appdata", "localappdata"].includes(key.toLowerCase())) delete env[key];
    }
    Object.assign(env, { PATH: nodeDirectory, APPDATA: join(directory, "roaming"), LOCALAPPDATA: localAppData });
    const run = (...args) => spawnSync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(project, "scripts", "check-local.ps1"), ...args,
    ], { cwd: directory, env, encoding: "utf8", windowsHide: true, timeout: 30_000 });

    const passed = run("-DependenciesOnly");
    assert.ifError(passed.error);
    assert.equal(passed.status, 0, passed.stderr || passed.stdout);
    assert.match(passed.stdout, /Codex CLI: ok/);
    assert.match(passed.stdout, /Local dependency check passed/);
    assert.deepEqual(await readdir(project), ["scripts"], "dependency check must not create config or runtime state");

    const incompatible = run("-DependenciesOnly", "-RequireFeishu");
    assert.notEqual(incompatible.status, 0, "cannot claim Feishu verification in dependency-only mode");
    assert.match(incompatible.stderr, /cannot be combined/);

    await writeFile(`${cli}.mode`, "invalid");
    const failed = run("-DependenciesOnly");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /usable Codex CLI was not found/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /PRIVATE/);

    await writeFile(`${cli}.mode`, "codex-cli 0.114.0");
    const regular = run();
    assert.notEqual(regular.status, 0);
    assert.match(regular.stderr, /Local config is missing/, "normal checks must retain config/service requirements");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
