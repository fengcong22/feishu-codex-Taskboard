import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { compileCodexFixture, installCodexFixture, quotePowerShell, runPowerShell } from "./helpers/codex-cli-fixture.mjs";

const helper = fileURLToPath(new URL("../scripts/codex-discovery.ps1", import.meta.url));
const vendorSuffix = "@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";

test("Codex discovery validates real CLI candidates in an isolated fresh Windows process", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-discovery-")));
  try {
    const template = await compileCodexFixture(directory);
    const environment = {
      // npm test injects npm_config_prefix/userconfig; isolate fixtures from it.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key))),
      PATH: "", Path: "",
      APPDATA: join(directory, "roaming"),
      LOCALAPPDATA: join(directory, "local"),
      CODEX_EXECUTABLE: "",
      PROCESSOR_ARCHITECTURE: "AMD64",
    };
    delete environment.PROCESSOR_ARCHITEW6432;
    const run = (body, env = {}) => {
      const result = runPowerShell(`$ErrorActionPreference = 'Stop'
. ${quotePowerShell(helper)}
${body}`, { cwd: directory, env: { ...environment, ...env } });
      const match = result.stdout.match(/^RESULT:(.*)\r?$/m);
      assert.ok(match, result.stderr || result.stdout);
      return { value: JSON.parse(match[1]), ...result };
    };
    const resolve = (argumentsText = "", env = {}) => run(`$resolved = Resolve-CodexExecutable ${argumentsText}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Write-Output ('RESULT:' + (@{ path = $resolved } | ConvertTo-Json -Compress))`, env);

    await t.test("Desktop-only install works without PATH or a deployment-session override", async () => {
      const desktop = await installCodexFixture(template, join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin", "desktop-version-1", "codex.exe"));
      assert.equal(resolve().value.path, desktop);
      await rm(dirname(desktop), { recursive: true, force: true });
    });

    await t.test("explicit literal paths support Chinese, spaces, apostrophes and shell metacharacters", async () => {
      const explicit = await installCodexFixture(template, join(directory, "中文 test's & (path) [1]", "codex.exe"), "codex-cli 0.115.0-beta.1");
      assert.equal(resolve(`-ExplicitExecutable ${quotePowerShell(explicit)} -Candidates @()`).value.path, explicit);
      assert.equal(resolve(`-ExplicitExecutable ${quotePowerShell(".\\中文 test's & (path) [1]\\codex.exe")} -Candidates @()`).value.path, explicit);
      assert.equal(await readFile(`${explicit}.invocations`, "utf8"), "--version\n--version\n");
    });

    await t.test("invalid explicit/PATH candidates fall through; candidate output remains private", async () => {
      const invalid = await installCodexFixture(template, join(directory, "invalid", "codex.exe"), "invalid");
      const nonzero = await installCodexFixture(template, join(directory, "nonzero", "codex.exe"), "nonzero");
      const valid = await installCodexFixture(template, join(directory, "valid-path", "codex.exe"));
      const result = resolve(`-ExplicitExecutable ${quotePowerShell(invalid)} -Candidates @()`, { PATH: `${dirname(nonzero)};${dirname(valid)}` });
      assert.equal(result.value.path, valid);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|9\.9\.9/);
      const stale = resolve(`-ExplicitExecutable 'missing.exe' -Candidates @(${quotePowerShell(valid)})`);
      assert.equal(stale.value.path, valid);
      assert.match(stale.stderr + stale.stdout, /Configured CODEX_EXECUTABLE was not found; continuing with automatic Codex discovery\./);
    });

    await t.test("explicit and PATH override Desktop, while GUI locations are never searched", async () => {
      const explicit = await installCodexFixture(template, join(directory, "priority-explicit", "codex.exe"));
      const pathCli = await installCodexFixture(template, join(directory, "priority-path", "codex.exe"));
      const desktop = await installCodexFixture(template, join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin", "priority-version", "codex.exe"));
      const gui = await installCodexFixture(template, join(environment.LOCALAPPDATA, "OpenAI", "Codex", "Codex.exe"));
      const pathEnv = { PATH: dirname(pathCli) };
      assert.equal(resolve(`-ExplicitExecutable ${quotePowerShell(explicit)}`, pathEnv).value.path, explicit);
      assert.equal(resolve("", pathEnv).value.path, pathCli);
      await assert.rejects(access(`${desktop}.invocations`));
      await assert.rejects(access(`${gui}.invocations`));
      await rm(dirname(desktop), { recursive: true, force: true });
      assert.equal(resolve().value.path, null);
      await assert.rejects(access(`${gui}.invocations`));
    });

    await t.test("timeouts, launch errors, and non-CLI output reject candidates without hanging", async () => {
      const timeout = await installCodexFixture(template, join(directory, "timeout", "codex.exe"), "timeout");
      const broken = join(directory, "broken.exe");
      await writeFile(broken, "not an executable");
      const valid = await installCodexFixture(template, join(directory, "valid-fallback", "codex.exe"));
      const start = Date.now();
      assert.equal(resolve(`-Candidates @(${[timeout, broken, valid].map(quotePowerShell).join(",")}) -ProbeTimeoutMs 1500`).value.path, valid);
      assert.ok(Date.now() - start < 15_000, "timed-out CLI must be terminated and discovery must continue");
      await rm(timeout);
      const flooding = await installCodexFixture(template, join(directory, "flood", "codex.exe"), "flood");
      assert.equal(resolve(`-Candidates @(${[flooding, valid].map(quotePowerShell).join(",")}) -ProbeTimeoutMs 1500`).value.path, valid);
      await writeFile(`${flooding}.mode`, "stderr-flood");
      assert.equal(resolve(`-Candidates @(${[flooding, valid].map(quotePowerShell).join(",")}) -ProbeTimeoutMs 1500`).value.path, valid);
      await rm(flooding);
      const invalidVersions = ["v0.114.0", "Codex Desktop 0.114.0", "codex-cli 0.114", "prefix codex-cli 0.114.0"];
      for (const version of invalidVersions) {
        await writeFile(`${valid}.mode`, version);
        assert.equal(resolve(`-Candidates @(${quotePowerShell(valid)})`).value.path, null);
      }
    });

    await t.test("Desktop updates are rediscovered and newest candidate wins with stable path ties", async () => {
      const base = join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      const older = await installCodexFixture(template, join(base, "z-old", "codex.exe"));
      const newer = await installCodexFixture(template, join(base, "a-new", "codex.exe"));
      const now = new Date();
      await utimes(older, new Date(0), new Date(0));
      await utimes(newer, now, now);
      assert.equal(resolve().value.path, newer);
      await rm(dirname(newer), { recursive: true, force: true });
      assert.equal(resolve().value.path, older);
      const replacement = await installCodexFixture(template, join(base, "b-updated", "codex.exe"));
      assert.equal(resolve().value.path, replacement);
      await utimes(older, now, now);
      await utimes(replacement, now, now);
      assert.equal(resolve().value.path, replacement);
      await rm(base, { recursive: true, force: true });
    });

    await t.test("probe cleanup contains descendants on timeout, early exit, and successful version output", async (children) => {
      const valid = await installCodexFixture(template, join(directory, "child-fallback", "codex.exe"));
      for (const mode of ["child-timeout", "child-early-exit", "child-success"]) {
        await children.test(mode, async () => {
          const candidate = await installCodexFixture(template, join(directory, mode, "codex.exe"), mode);
          try {
            const result = resolve(`-Candidates @(${[candidate, valid].map(quotePowerShell).join(",")}) -ProbeTimeoutMs 2000`);
            assert.equal(result.value.path, mode === "child-success" ? candidate : valid);
            await access(`${candidate}.child-ready`);
            // The fixture child holds this file exclusively for its entire lifetime.
            // A successful open proves the exact spawned child has stopped, without PID reuse risks.
            const handle = await open(`${candidate}.child-lock`, "r+");
            await handle.close();
          } finally {
            await writeFile(`${candidate}.child-stop`, "stop");
            // Stop only our fixture if a deliberately red test exposed a leaked child.
            for (let attempt = 0; attempt < 50; attempt += 1) {
              try { const handle = await open(`${candidate}.child-lock`, "r+"); await handle.close(); break; }
              catch { await delay(20); }
            }
          }
        });
      }
    });

    await t.test("explicit candidates suppress automatic discovery, missing env and nonfilesystem overrides are safe", async () => {
      const desktop = await installCodexFixture(template, join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin", "suppressed", "codex.exe"));
      assert.equal(resolve("-Candidates @()").value.path, null);
      assert.equal(resolve("-ExplicitExecutable 'env:PATH' -Candidates @()").value.path, null);
      assert.equal(resolve("-ExplicitExecutable . -Candidates @()").value.path, null);
      assert.equal(resolve("", { LOCALAPPDATA: "", APPDATA: "" }).value.path, null);
      await assert.rejects(access(`${desktop}.invocations`));
      await rm(dirname(desktop), { recursive: true, force: true });
    });

    await t.test("vendor selection preserves native, WOW64, and unknown-architecture behavior", async () => {
      const result = run(`$root = ${quotePowerShell(directory)}
$x64 = @(Get-CodexVendorCandidates -NpmRoot $root -Architecture AMD64)
$arm64 = @(Get-CodexVendorCandidates -NpmRoot $root -Architecture ARM64)
$unknown = @(Get-CodexVendorCandidates -NpmRoot $root -Architecture x86)
$wow64 = @(Get-CodexVendorCandidates -NpmRoot $root)
Write-Output ('RESULT:' + (@{ x64 = $x64; arm64 = $arm64; unknown = $unknown; wow64 = $wow64 } | ConvertTo-Json -Compress))`, { PROCESSOR_ARCHITECTURE: "x86", PROCESSOR_ARCHITEW6432: "AMD64" });
      assert.match(result.value.x64[0], /codex-win32-x64\\vendor\\x86_64-pc-windows-msvc/);
      assert.match(result.value.arm64[0], /codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc/);
      assert.deepEqual(result.value.unknown, []);
      assert.deepEqual(result.value.wow64, result.value.x64);
    });

    await t.test("actual npm global root takes precedence over the APPDATA fallback", async () => {
      const npmDirectory = join(directory, "custom npm's & path");
      const npm = join(npmDirectory, "npm.cmd");
      const npmCli = join(npmDirectory, "node_modules", "npm", "bin", "npm-cli.js");
      await mkdir(dirname(npmCli), { recursive: true });
      await writeFile(npm, "@exit /b 99\r\n"); // The batch shim must never be launched.
      const expectedArguments = ["root", "--global", "--logs-max=0", "--timing=false", "--update-notifier=false", "--offline", "--cache", npmDirectory];
      await writeFile(npmCli, `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expectedArguments))}) process.exit(22); console.log(process.env.CODEX_TEST_NPM_ROOT);\n`);
      const npmRoot = join(directory, "中文 actual global", "node_modules");
      const actual = await installCodexFixture(template, join(npmRoot, vendorSuffix));
      const fallback = await installCodexFixture(template, join(environment.APPDATA, "npm", "node_modules", vendorSuffix));
      const npmEnv = { PATH: dirname(process.execPath), CODEX_TEST_NPM_ROOT: npmRoot };
      assert.equal(resolve(`-NpmCommand ${quotePowerShell(npm)}`, npmEnv).value.path, actual);
      for (const codePage of [437, 936]) {
        const result = run(`[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(${codePage})
$resolved = Resolve-CodexExecutable -NpmCommand ${quotePowerShell(npm)}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Write-Output ('RESULT:' + (@{ path = $resolved } | ConvertTo-Json -Compress))`, npmEnv);
        assert.equal(result.value.path, actual, `npm UTF-8 output under console CP${codePage}`);
      }
      await rm(actual);
      assert.equal(resolve(`-NpmCommand ${quotePowerShell(npm)}`, npmEnv).value.path, fallback);
      await writeFile(npmCli, "setInterval(() => {}, 1000);\n");
      const start = Date.now();
      assert.equal(resolve(`-NpmCommand ${quotePowerShell(npm)} -ProbeTimeoutMs 1500`, npmEnv).value.path, fallback);
      assert.ok(Date.now() - start < 15_000);
      for (const output of ["relative/path", `${npmRoot}\nPRIVATE OUTPUT`]) {
        await writeFile(npmCli, `console.log(${JSON.stringify(output)});\n`);
        const result = resolve(`-NpmCommand ${quotePowerShell(npm)}`, npmEnv);
        assert.equal(result.value.path, fallback);
        assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE OUTPUT/);
      }
      await rm(npmCli);
      assert.equal(resolve(`-NpmCommand ${quotePowerShell(npm)}`, npmEnv).value.path, fallback);
    });

    await t.test("real npm honors user prefix configuration without creating configured cache or logs", async (npmTest) => {
      const realNpm = join(dirname(process.execPath), "npm.cmd");
      try { await access(realNpm); }
      catch { npmTest.skip("npm is not installed beside the test Node runtime"); return; }
      const prefix = join(directory, "real npm prefix");
      const actual = await installCodexFixture(template, join(prefix, "node_modules", vendorSuffix));
      const cache = join(directory, "cache-must-not-be-created");
      const logs = join(directory, "logs-must-not-be-created");
      const userConfig = join(directory, "fixture-user.npmrc");
      const globalConfig = join(directory, "fixture-global.npmrc");
      await writeFile(userConfig, `prefix=${prefix.replaceAll("\\", "/")}\ncache=${cache.replaceAll("\\", "/")}\nlogs-dir=${logs.replaceAll("\\", "/")}\nlogs-max=10\ntiming=true\nupdate-notifier=true\n`);
      await writeFile(globalConfig, "");
      assert.equal(resolve(`-NpmCommand ${quotePowerShell(realNpm)}`, {
        PATH: dirname(process.execPath),
        NPM_CONFIG_USERCONFIG: userConfig,
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
      }).value.path, actual);
      await assert.rejects(access(cache));
      await assert.rejects(access(logs));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
