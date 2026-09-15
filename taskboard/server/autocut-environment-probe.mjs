// Run in a separate, bounded process in the same account/environment as Auto-Cut.
// CLI output may contain identity information; only fixed error codes leave here.
import { constants } from "node:fs";
import { access, open, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function withCode(code, operation) {
  try { return await operation(); } catch { throw Object.assign(new Error(code), { code }); }
}

async function readableFile(filename) {
  if (!path.isAbsolute(filename) || !(await stat(filename)).isFile()) throw new Error();
  await access(filename, constants.R_OK);
}

async function writableDirectory(directory) {
  if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error();
  const filename = path.join(directory, `.taskboard-access-${randomUUID()}.tmp`);
  // One exclusive create: do not use a tempfile retry loop on permission errors.
  const handle = await open(filename, "wx", 0o600);
  try { await handle.writeFile("probe"); } finally {
    await handle.close();
    await unlink(filename);
  }
}

async function probe({ larkCli, readinessPath, directories }) {
  const command = await withCode("AUTOCUT_LARK_CLI_UNAVAILABLE", async () => {
    await readableFile(larkCli);
    const extension = path.extname(larkCli).toLowerCase();
    // The installed Python workflow discovers lark-cli.cmd before any .exe/.js.
    // Only accept the npm shim layout whose discovery matches this fixed probe.
    if (process.platform === "win32" && ![".cmd", ".bat", ".ps1"].includes(extension)) throw new Error();
    if ([".cmd", ".bat", ".ps1"].includes(extension)) {
      const script = path.join(path.dirname(larkCli), "node_modules", "@larksuite", "cli", "scripts", "run.js");
      await readableFile(script);
      // Python's adapter discovers the .cmd shim on Windows before resolving run.js.
      if (process.platform === "win32") {
        const shim = path.join(path.dirname(larkCli), "lark-cli.cmd");
        await readableFile(shim);
        if (path.dirname(await realpath(shim)).toLowerCase() !== (await realpath(path.dirname(larkCli))).toLowerCase()) throw new Error();
        const adjacentNode = path.join(path.dirname(larkCli), "node.exe");
        try {
          // Python prefers an adjacent Node over PATH. Do not probe one Node and
          // subsequently let the workflow execute a different installation.
          if ((await realpath(adjacentNode)).toLowerCase() !== (await realpath(process.execPath)).toLowerCase()) throw new Error();
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      return [process.execPath, [script, "whoami"]];
    }
    if (extension === ".js") return [process.execPath, [larkCli, "whoami"]];
    await access(larkCli, constants.X_OK);
    return [larkCli, ["whoami"]];
  });
  await withCode("AUTOCUT_READINESS_UNAVAILABLE", async () => {
    if (!path.isAbsolute(readinessPath)) throw new Error();
    try {
      if (!(await stat(readinessPath)).isFile()) throw new Error();
      const handle = await open(readinessPath, "r+");
      await handle.close();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writableDirectory(path.dirname(readinessPath));
  });
  await withCode("AUTOCUT_OUTPUT_UNAVAILABLE", async () => {
    for (const directory of directories) await writableDirectory(directory);
  });
  await withCode("AUTOCUT_LARK_IDENTITY_UNAVAILABLE", async () => {
    // The enclosing process deadline also covers CLI/native children that hang.
    const { stdout } = await execFileAsync(command[0], command[1], {
      windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024,
    });
    const identity = JSON.parse(stdout);
    if (identity.available !== true || identity.identity?.toLowerCase() !== "user"
      || (identity.defaultAs ?? identity.default_as)?.toLowerCase() !== "user") throw new Error();
  });
}

try {
  await probe(JSON.parse(process.argv[2]));
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? "AUTOCUT_ENVIRONMENT_UNAVAILABLE" }));
  process.exitCode = 1;
}
