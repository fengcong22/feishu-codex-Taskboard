import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { runVmPmoOffline } from "../server/vm-pmo-offline-runner.mjs";
import { validateVmPmoInput } from "../server/vm-pmo-result-validator.mjs";

let PYTHON;
try { PYTHON = execFileSync("python", ["-c", "import sys; print(sys.executable)"],
  { encoding: "utf8" }).trim(); } catch { /* Python-dependent cases skip when unavailable. */ }
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runCommand = promisify(execFile);
let sourcePromise;
async function sourceFixture() {
  sourcePromise ??= (async () => {
    const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-pmo-runner-source-")));
    try {
      const source = path.join(temporary, "source.mp4");
      await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=black:s=1280x720:r=25:d=1", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source], { timeout: 120_000 });
      return await readFile(source);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  })();
  return sourcePromise;
}

async function fixture(t, body, withPlan = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-pmo-runner-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const moduleRoot = path.join(root, "auto_cut_slicing");
  const runDir = path.join(root, "run");
  await mkdir(moduleRoot);
  await mkdir(runDir);
  await writeFile(path.join(moduleRoot, "__init__.py"), "", "utf8");
  await writeFile(path.join(moduleRoot, "vm_pmo.py"), body, "utf8");
  const contextPath = path.join(runDir, "execution-context.json");
  const planPath = path.join(runDir, "plan.json");
  const identity = { protocol: "vm_pmo_review_video", schema_version: 1,
    package: { alias: "vm", name: "auto-cut-slicing", version: "0.2.0", manifest_sha256: "a".repeat(64) },
    binding: { task_id: "task-1", run_id: "run-1", subject_key: "base:table", config_version: "config-1",
      stage_id: "initial", event_id: "event-1" },
    record: { base_token: "base", table_id: "table", record_id: "record" },
    review_round: { round_id: "round-1", input_snapshot_id: "snapshot-1", parent: null },
    delivery_target: { attachment_field_id: "fld-output" } };
  const sourceBytes = await sourceFixture();
  const source = { source_id: "source-1", timeline_basis: "vm_original", vmid: "vmid-1",
    sha256: hash(sourceBytes), bytes: sourceBytes.length, duration_ms: 1000 };
  const input = { ...identity, source, instructions: [{ instruction_id: "opinion-1", source_field_id: "fld-opinion",
    raw_text: "0:00-0:01", timeline_basis: "vm_original", applicability: "current_round" }],
    output_profile: { id: "review_mp4_v1", width: 1920, height: 1080, fps: 25, audio: "preserve" } };
  const inputBytes = Buffer.from(JSON.stringify(input));
  const context = {
    protocol: "vm_pmo_review_video", schema_version: 1, input_sha256: hash(inputBytes),
    run_dir: runDir, source_path: path.join(runDir, "source.mp4"),
    plan_path: planPath, plan_result_path: path.join(runDir, "plan-result.json"),
    result_path: path.join(runDir, "result.json"), output_path: path.join(runDir, "review.mp4"),
  };
  await writeFile(contextPath, JSON.stringify(context));
  await writeFile(context.source_path, sourceBytes);
  await writeFile(path.join(runDir, "input.json"), inputBytes);
  if (withPlan) {
    const instruction = input.instructions[0];
    const plan = { ...identity, source, input_sha256: context.input_sha256, source_sha256: source.sha256,
      instruction_results: [{ instruction_id: instruction.instruction_id, source_field_id: instruction.source_field_id,
        raw_text: instruction.raw_text, status: "resolved", segments: ["segment-1"] }],
      segments: [{ segment_id: "segment-1", source_id: source.source_id, start_ms: 0, end_ms: 1000 }],
      operations: [], expected_duration_ms: 1000, engine_plan_sha256: "b".repeat(64) };
    const planBytes = Buffer.from(JSON.stringify(plan));
    await writeFile(planPath, planBytes);
    await writeFile(context.plan_result_path, JSON.stringify({ ...identity, status: "ready",
      input_sha256: context.input_sha256, source_sha256: source.sha256, plan_sha256: hash(planBytes),
      instruction_results: plan.instruction_results, error: null }));
  }
  return { root, runDir, contextPath, planPath };
}

test("fixed module entry receives only the bound plan/render paths", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, `
import json, os, sys
with open(os.path.join(os.path.dirname(sys.argv[sys.argv.index('--context')+1]), 'argv.json'), 'w') as f:
    json.dump(sys.argv[1:], f)
with open(sys.argv[sys.argv.index('--input')+1]) as f:
    data = json.load(f)
with open(sys.argv[sys.argv.index('--context')+1]) as f:
    context = json.load(f)
with open(context['plan_result_path']) as f:
    ready = json.load(f)
result = {k: ready[k] for k in ['protocol', 'schema_version', 'package', 'binding', 'record', 'review_round',
                              'delivery_target', 'input_sha256', 'source_sha256', 'plan_sha256']}
result.update(status='blocked', artifacts=[], error={'code': 'RENDER_BLOCKED', 'message': 'Render blocked'},
              instruction_results=[{k: item[k] for k in ['instruction_id', 'source_field_id', 'raw_text']}
                                   | {'status': 'blocked', 'segments': []} for item in data['instructions']])
with open(context['result_path'], 'w') as f:
    json.dump(result, f)
with open(os.path.join(context['run_dir'], 'env.json'), 'w') as f:
    json.dump({'secret_present': 'FEISHU_APP_SECRET' in os.environ,
               'pythonpath_present': 'PYTHONPATH' in os.environ,
               'no_user_site': os.environ.get('PYTHONNOUSERSITE')}, f)
`);
  const outcome = await runVmPmoOffline({ mode: "render", pythonPath: PYTHON, packageRoot: current.root,
    contextPath: current.contextPath, environment: { ...process.env, FEISHU_APP_SECRET: "must-not-pass",
      PYTHONPATH: current.root } });
  assert.equal(outcome.status, "blocked");
  assert.deepEqual(JSON.parse(await readFile(path.join(current.runDir, "argv.json"), "utf8")), [
    "render", "--input", path.join(current.runDir, "input.json"),
    "--context", current.contextPath, "--plan", current.planPath,
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(current.runDir, "env.json"), "utf8")),
    { secret_present: false, pythonpath_present: false, no_user_site: "1" });
});

test("runner times out a hung package with a safe error", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, "import time\ntime.sleep(20)\n", false);
  await assert.rejects(runVmPmoOffline({ mode: "plan", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath, timeoutMs: 200 }),
  { code: "VM_PMO_RUN_TIMEOUT" });
});

test("runner reports actual spawn once and stops if start evidence cannot persist", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, "import time\ntime.sleep(20)\n", false);
  const starts = [];
  await assert.rejects(runVmPmoOffline({ mode: "plan", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath, timeoutMs: 5000,
    onStarted: async (evidence) => { starts.push(evidence); throw new Error("cannot persist"); } }),
  { code: "VM_PMO_START_EVIDENCE_FAILED" });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].mode, "plan");
  assert.ok(Number.isSafeInteger(starts[0].pid) && starts[0].pid > 0);
  assert.equal(new Date(starts[0].startedAt).toISOString(), starts[0].startedAt);
});

test("runner timeout also bounds a start evidence callback that never settles", { timeout: 5000 }, async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, "import time\ntime.sleep(20)\n", false);
  await assert.rejects(runVmPmoOffline({ mode: "plan", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath, timeoutMs: 200,
    onStarted: () => new Promise(() => {}) }), { code: "VM_PMO_RUN_TIMEOUT" });
});

test("runner rejects malformed input without emitting start evidence", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, "raise RuntimeError('must not launch')\n", false);
  let starts = 0;
  await assert.rejects(runVmPmoOffline({ mode: "shell", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath,
    onStarted: () => { starts += 1; } }), { code: "VM_PMO_RUN_INPUT_INVALID" });
  assert.equal(starts, 0);
});

test("runner rejects input rebound after runtime validation before emitting start evidence", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, "raise RuntimeError('must not launch')\n", false);
  const expectedBound = await validateVmPmoInput({ contextPath: current.contextPath });
  const inputPath = path.join(current.runDir, "input.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  input.binding.task_id = "another-task";
  const inputBytes = Buffer.from(JSON.stringify(input));
  const context = JSON.parse(await readFile(current.contextPath, "utf8"));
  context.input_sha256 = hash(inputBytes);
  await writeFile(inputPath, inputBytes);
  await writeFile(current.contextPath, JSON.stringify(context));
  let starts = 0;
  await assert.rejects(runVmPmoOffline({ mode: "plan", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath, expectedBound,
    onStarted: () => { starts += 1; } }), { code: "RUN_BINDING_MISMATCH" });
  assert.equal(starts, 0);
});

test("runner aborts a package without exposing stderr", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, "import sys, time\nprint('secret=do-not-report', file=sys.stderr)\ntime.sleep(20)\n", false);
  const controller = new AbortController();
  const pending = runVmPmoOffline({ mode: "plan", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath, signal: controller.signal });
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(pending, (error) => error?.code === "VM_PMO_RUN_INTERRUPTED"
    && !error.message.includes("do-not-report"));
});

test("runner rejects untrusted entry parameters before launch", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, "raise RuntimeError('must not launch')\n");
  await assert.rejects(runVmPmoOffline({ mode: "shell", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath }), { code: "VM_PMO_RUN_INPUT_INVALID" });
  await assert.rejects(runVmPmoOffline({ mode: "plan", pythonPath: PYTHON,
    packageRoot: "relative", contextPath: current.contextPath }), { code: "VM_PMO_RUN_INPUT_INVALID" });
});

test("runner rejects a zero-exit invalid receipt", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, `
import json, sys
with open(sys.argv[sys.argv.index('--context')+1]) as f:
    context = json.load(f)
with open(context['result_path'], 'w') as f:
    f.write('{}')
`);
  await assert.rejects(runVmPmoOffline({ mode: "render", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath }), { code: "RENDER_RESULT_INVALID" });
});

test("runner accepts legal blocked planning and does not launch rendering", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, `
import json, os, sys
with open(sys.argv[sys.argv.index('--input')+1]) as f:
    data = json.load(f)
with open(sys.argv[sys.argv.index('--context')+1]) as f:
    context = json.load(f)
if sys.argv[1] != 'plan':
    raise RuntimeError('must not render a blocked plan')
with open(os.path.join(context['run_dir'], 'launch-count.txt'), 'w') as f:
    f.write('1')
receipt = {k: data[k] for k in ['protocol', 'schema_version', 'package', 'binding', 'record',
                              'review_round', 'delivery_target']}
receipt.update(status='blocked', input_sha256=context['input_sha256'], source_sha256=data['source']['sha256'],
               plan_sha256=None, error={'code': 'UNSUPPORTED_INSTRUCTION', 'message': 'Instruction blocked'},
               instruction_results=[{k: item[k] for k in ['instruction_id', 'source_field_id', 'raw_text']}
                                   | {'status': 'blocked', 'segments': []} for item in data['instructions']])
with open(context['plan_result_path'], 'w') as f:
    json.dump(receipt, f)
`, false);
  const params = { pythonPath: PYTHON, packageRoot: current.root, contextPath: current.contextPath };
  const planned = await runVmPmoOffline({ ...params, mode: "plan" });
  assert.equal(planned.status, "blocked");
  const rendered = await runVmPmoOffline({ ...params, mode: "render" });
  assert.equal(rendered.status, "blocked");
  assert.equal(await readFile(path.join(current.runDir, "launch-count.txt"), "utf8"), "1");
});

test("runner rejects a package that rebinds its input and context during planning", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, `
import hashlib, json, sys
input_path = sys.argv[sys.argv.index('--input')+1]
context_path = sys.argv[sys.argv.index('--context')+1]
with open(input_path) as f:
    data = json.load(f)
with open(context_path) as f:
    context = json.load(f)
data['binding']['task_id'] = 'wrong-task'
encoded = json.dumps(data).encode('utf-8')
with open(input_path, 'wb') as f:
    f.write(encoded)
context['input_sha256'] = hashlib.sha256(encoded).hexdigest()
with open(context_path, 'w') as f:
    json.dump(context, f)
identity = {k: data[k] for k in ['protocol', 'schema_version', 'package', 'binding', 'record',
                              'review_round', 'delivery_target']}
item = data['instructions'][0]
dispositions = [{k: item[k] for k in ['instruction_id', 'source_field_id', 'raw_text']}
                | {'status': 'resolved', 'segments': ['s1']}]
plan = dict(identity, source=data['source'], input_sha256=context['input_sha256'],
            source_sha256=data['source']['sha256'], instruction_results=dispositions,
            segments=[{'segment_id': 's1', 'source_id': data['source']['source_id'], 'start_ms': 0, 'end_ms': 1000}],
            operations=[], expected_duration_ms=1000, engine_plan_sha256='b'*64)
encoded_plan = json.dumps(plan).encode('utf-8')
with open(context['plan_path'], 'wb') as f:
    f.write(encoded_plan)
receipt = dict(identity, status='ready', input_sha256=context['input_sha256'],
               source_sha256=data['source']['sha256'], plan_sha256=hashlib.sha256(encoded_plan).hexdigest(),
               instruction_results=dispositions, error=None)
with open(context['plan_result_path'], 'w') as f:
    json.dump(receipt, f)
`, false);
  await assert.rejects(runVmPmoOffline({ mode: "plan", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath }), { code: "RUN_BINDING_MISMATCH" });
});

test("runner rejects a package that replaces the approved plan and ready receipt during rendering", async (t) => {
  if (!PYTHON) return t.skip("python is unavailable");
  const current = await fixture(t, `
import hashlib, json, sys
with open(sys.argv[sys.argv.index('--context')+1]) as f:
    context = json.load(f)
with open(sys.argv[sys.argv.index('--input')+1]) as f:
    data = json.load(f)
with open(context['plan_path']) as f:
    plan = json.load(f)
with open(context['plan_result_path']) as f:
    ready = json.load(f)
plan['segments'][0]['start_ms'] = 200
plan['expected_duration_ms'] = 800
encoded = json.dumps(plan).encode('utf-8')
with open(context['plan_path'], 'wb') as f:
    f.write(encoded)
ready['plan_sha256'] = hashlib.sha256(encoded).hexdigest()
with open(context['plan_result_path'], 'w') as f:
    json.dump(ready, f)
result = {k: ready[k] for k in ['protocol', 'schema_version', 'package', 'binding', 'record', 'review_round',
                              'delivery_target', 'input_sha256', 'source_sha256', 'plan_sha256']}
result.update(status='blocked', artifacts=[], error={'code': 'RENDER_BLOCKED', 'message': 'Render blocked'},
              instruction_results=[{k: item[k] for k in ['instruction_id', 'source_field_id', 'raw_text']}
                                   | {'status': 'blocked', 'segments': []} for item in data['instructions']])
with open(context['result_path'], 'w') as f:
    json.dump(result, f)
`);
  await assert.rejects(runVmPmoOffline({ mode: "render", pythonPath: PYTHON,
    packageRoot: current.root, contextPath: current.contextPath }), { code: "PLAN_BINDING_MISMATCH" });
});
