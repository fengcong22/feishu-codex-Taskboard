import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../cli/vm-source.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

function capture() {
  let text = "";
  return {
    stream: { write(chunk) { text += chunk; } },
    text: () => text,
    json: () => JSON.parse(text),
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-source-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    outputRoot: path.join(root, "output"),
    request: path.join(root, "request.json"),
  };
}

async function writeRequest(file, contents = { schema_version: 1, vmid: "5dd7753a4723ba416403cbad", source: { kind: "approval_required" } }) {
  await writeFile(file, JSON.stringify(contents), "utf8");
}

async function run(argv, overrides = {}) {
  const stdout = capture();
  const exitCode = await main(argv, { stdout: stdout.stream, ...overrides });
  return { exitCode, output: stdout.json(), text: stdout.text() };
}

test("prints standalone acquisition help without calling the acquisition adapter", async () => {
  let invoked = false;
  const stdout = capture();
  const exitCode = await main(["--help"], {
    stdout: stdout.stream,
    prepare: async () => { invoked = true; },
  });
  assert.equal(exitCode, 0);
  assert.equal(invoked, false);
  assert.match(stdout.text(), /Standalone VM material acquisition/u);
  assert.match(stdout.text(), /Exit codes: 0 ready, 2 invalid request, 3 failed, 4 approval required/u);
});

test("rejects malformed commands, flags and numeric options before acquisition", async (t) => {
  const { request, outputRoot } = await fixture(t);
  await writeRequest(request);
  const invalidArgv = [
    [],
    ["download", "--request", request, "--output-root", outputRoot],
    ["acquire", "--request", request],
    ["acquire", "--request", request, "--output-root", outputRoot, "--unknown", "value"],
    ["acquire", "--request", request, "--request", request, "--output-root", outputRoot],
    ["acquire", "--request", request, "--output-root", outputRoot, "--ffmpeg", "relative/ffmpeg"],
    ["acquire", "--request", request, "--output-root", outputRoot, "--max-bytes", "0"],
    ["acquire", "--request", request, "--output-root", outputRoot, "--max-bytes", "1e6"],
    ["acquire", "--request", request, "--output-root", outputRoot, "--timeout-ms", "0"],
    ["acquire", "--request", request, "--output-root", outputRoot, "--timeout-ms", "not-a-number"],
  ];
  for (const argv of invalidArgv) {
    let invoked = false;
    const result = await run(argv, { prepare: async () => { invoked = true; } });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.deepEqual(result.output, { status: "failed", error: { code: "VM_REQUEST_INVALID" } });
    assert.equal(invoked, false, argv.join(" "));
  }
});

test("rejects unreadable, malformed, non-regular and oversized request files", async (t) => {
  const { root, outputRoot, request } = await fixture(t);
  const missing = path.join(root, "missing.json");
  const directory = path.join(root, "request-directory");
  const oversized = path.join(root, "oversized.json");
  const malformed = path.join(root, "malformed.json");
  await mkdir(directory);
  await writeFile(oversized, "x".repeat(64 * 1024 + 1));
  await writeFile(malformed, "{ not JSON", "utf8");
  for (const file of [missing, directory, oversized, malformed]) {
    let invoked = false;
    const result = await run(["acquire", "--request", file, "--output-root", outputRoot], {
      prepare: async () => { invoked = true; },
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.output, { status: "failed", error: { code: "VM_REQUEST_INVALID" } });
    assert.equal(invoked, false);
  }
});

test("rejects a symbolic-link request file", async (t) => {
  const { root, outputRoot, request } = await fixture(t);
  await writeRequest(request);
  const linked = path.join(root, "linked-request.json");
  try { await symlink(request, linked); }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Creating file symlinks requires OS permission"); return; }
    throw error;
  }
  const result = await run(["acquire", "--request", linked, "--output-root", outputRoot], {
    prepare: async () => assert.fail("symbolic-link request must not reach adapter"),
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.output, { status: "failed", error: { code: "VM_REQUEST_INVALID" } });
});

test("passes a parsed request and normalized CLI options to a ready acquisition", async (t) => {
  const { root, request, outputRoot } = await fixture(t);
  const payload = { schema_version: 1, vmid: "5dd7753a4723ba416403cbad", source: { kind: "approval_required" } };
  await writeRequest(request, payload);
  let call;
  const ready = { protocol: "vm_source_acquisition", schema_version: 1, status: "ready", vmid: payload.vmid };
  const result = await run([
    "acquire", "--request", request, "--output-root", outputRoot,
    "--ffprobe", path.join(root, "bin", "ffprobe"),
    "--ffmpeg", path.join(root, "bin", "ffmpeg"),
    "--max-bytes", "1024", "--timeout-ms", "5000",
  ], {
    prepare: async (receivedRequest, options) => {
      call = { receivedRequest, options };
      return ready;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, ready);
  assert.deepEqual(call, {
    receivedRequest: payload,
    options: {
      outputRoot: path.resolve(outputRoot),
      ffprobePath: path.join(root, "bin", "ffprobe"),
      ffmpegPath: path.join(root, "bin", "ffmpeg"),
      maxBytes: 1024,
      timeoutMs: 5000,
    },
  });
});

test("maps a blocked approval result to exit code 4", async (t) => {
  const { request, outputRoot } = await fixture(t);
  await writeRequest(request);
  const blocked = {
    protocol: "vm_source_acquisition", schema_version: 1, status: "blocked",
    error: { code: "SOURCE_APPROVAL_REQUIRED", retryable: false },
  };
  const result = await run(["acquire", "--request", request, "--output-root", outputRoot], {
    prepare: async () => blocked,
  });
  assert.equal(result.exitCode, 4);
  assert.deepEqual(result.output, blocked);
});

test("maps expected acquisition errors and unexpected failures to safe failure results", async (t) => {
  const { request, outputRoot } = await fixture(t);
  await writeRequest(request);
  for (const [error, expected] of [
    [new VmSourceError("VM_SOURCE_TRANSFER_FAILED"), "VM_SOURCE_TRANSFER_FAILED"],
    [new Error("signed URL must not be exposed"), "VM_ACQUISITION_FAILED"],
  ]) {
    const result = await run(["acquire", "--request", request, "--output-root", outputRoot], {
      prepare: async () => { throw error; },
    });
    assert.equal(result.exitCode, 3);
    assert.deepEqual(result.output, { status: "failed", error: { code: expected } });
    assert.doesNotMatch(result.text, /signed URL/u);
  }
});
