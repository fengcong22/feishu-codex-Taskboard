import { closeSync, openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function requiredOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function environmentOptions(args) {
  const environment = { ...process.env };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--env") continue;
    const assignment = args[index + 1];
    if (!assignment || assignment.startsWith("--")) throw new Error("--env requires KEY=VALUE");
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error("--env requires KEY=VALUE");
    const key = assignment.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment key: ${key}`);
    environment[key] = assignment.slice(separator + 1);
    index += 1;
  }
  return environment;
}

function main(argv = process.argv.slice(2)) {
  const script = path.resolve(requiredOption(argv, "--script"));
  const cwd = path.resolve(requiredOption(argv, "--cwd"));
  const pidFile = path.resolve(requiredOption(argv, "--pid-file"));
  const stdoutFile = path.resolve(requiredOption(argv, "--stdout"));
  const stderrFile = path.resolve(requiredOption(argv, "--stderr"));
  const stdout = openSync(stdoutFile, "a");
  const stderr = openSync(stderrFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [script], {
      cwd,
      env: environmentOptions(argv),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    const pidText = `${child.pid}\n`;
    process.stdout.write(pidText);
    try {
      writeFileSync(pidFile, pidText, "utf8");
    } catch (error) {
      try {
        child.kill();
      } catch {
        // Best-effort cleanup; the caller can still use the reported PID.
      }
      throw error;
    }
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  child.unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { main };
