#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareVmSource } from "../server/vm-source-adapter.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

const HELP = `Usage: node taskboard/cli/vm-source.mjs acquire --request FILE --output-root DIRECTORY
       [--ffprobe ABSOLUTE_PATH] [--ffmpeg ABSOLUTE_PATH] [--max-bytes N] [--timeout-ms N]

Standalone VM material acquisition from an operator-approved URL or local file.
No automatic VM approval, Bridge registration, PMO writeback or production execution.
Keep the request in .runtime/; signed URLs are never included in the JSON receipt.
Exit codes: 0 ready, 2 invalid request, 3 failed, 4 approval required.
`;

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new VmSourceError("VM_REQUEST_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new VmSourceError("VM_REQUEST_INVALID");
  return parsed;
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout, prepare = prepareVmSource,
} = {}) {
  if (argv.length === 1 && argv[0] === "--help") { stdout.write(HELP); return 0; }
  try {
    if (argv[0] !== "acquire") throw new VmSourceError("VM_REQUEST_INVALID");
    const options = {};
    const allowed = new Set(["request", "output-root", "ffprobe", "ffmpeg", "max-bytes", "timeout-ms"]);
    for (let i = 1; i < argv.length; i += 2) {
      const key = argv[i].startsWith("--") ? argv[i].slice(2) : "";
      if (!allowed.has(key) || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) {
        throw new VmSourceError("VM_REQUEST_INVALID");
      }
      options[key] = argv[i + 1];
    }
    if (!options.request || !options["output-root"]) throw new VmSourceError("VM_REQUEST_INVALID");
    for (const tool of ["ffprobe", "ffmpeg"]) {
      if (options[tool] && !path.isAbsolute(options[tool])) throw new VmSourceError("VM_REQUEST_INVALID");
    }
    const maxBytes = options["max-bytes"] === undefined ? undefined : positiveInteger(options["max-bytes"]);
    const timeoutMs = options["timeout-ms"] === undefined ? undefined : positiveInteger(options["timeout-ms"]);
    let request;
    try {
      const info = await lstat(options.request);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error();
      request = JSON.parse(await readFile(options.request, "utf8"));
    } catch { throw new VmSourceError("VM_REQUEST_INVALID"); }
    const result = await prepare(request, {
      outputRoot: path.resolve(options["output-root"]),
      ...(options.ffprobe ? { ffprobePath: options.ffprobe } : {}),
      ...(options.ffmpeg ? { ffmpegPath: options.ffmpeg } : {}),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "ready" ? 0 : 4;
  } catch (error) {
    const code = error instanceof VmSourceError ? error.code : "VM_ACQUISITION_FAILED";
    stdout.write(`${JSON.stringify({ status: "failed", error: { code } })}\n`);
    return code === "VM_REQUEST_INVALID" ? 2 : 3;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
