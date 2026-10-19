import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runVmPmoOffline } from '../taskboard/server/vm-pmo-offline-runner.mjs';
import { validateVmPmoPlan, validateVmPmoRender } from '../taskboard/server/vm-pmo-result-validator.mjs';

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  'package-root': { type: 'string' }, python: { type: 'string' },
} });
if (![values['package-root'], values.python].every(value => typeof value === 'string' && path.isAbsolute(value))) {
  throw new Error('Provide absolute --package-root and --python paths. This check only uses synthetic media.');
}
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verificationRoot = path.join(workspace, '.runtime/vm-pmo-offline');
await mkdir(verificationRoot, {recursive: true});
const root = await mkdtemp(path.join(verificationRoot, 'run-'));
const packageRoot = values['package-root'];
const pythonPath = values.python;
const sourcePath = path.join(root, 'source.mp4');
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase())));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => readFile(file, 'utf8').then(JSON.parse);
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const checks = [];

async function probeDurationMs(filename) {
  const {stdout: probe} = await exec('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', filename],
    {env: safeEnv, windowsHide: true, timeout: 30000});
  return Math.round(Number(JSON.parse(probe).format.duration) * 1000);
}

await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
  'testsrc2=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i',
  'sine=frequency=700:sample_rate=48000:duration=2', '-c:v', 'libx264',
  '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath],
  {env: safeEnv, windowsHide: true, timeout: 30000});
const {stdout} = await exec('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', sourcePath],
  {env: safeEnv, windowsHide: true, timeout: 30000});
const durationMs = Math.round(Number(JSON.parse(stdout).format.duration) * 1000);
const manifestSha256 = sha256(await readFile(path.join(packageRoot, 'PACKAGE-MANIFEST.json')));

async function fixture(name, opinion = '0:00.80-0:01.20+0:00-0:00.40', extra = null,
  sourceFile = sourcePath, schemaVersion = 1, words = null) {
  const runDir = path.join(root, name);
  await mkdir(runDir);
  const fixtureSource = await readFile(sourceFile);
  const input = {
    protocol: 'vm_pmo_review_video', schema_version: schemaVersion,
    package: {alias: 'slicing-offline', name: 'auto-cut-slicing', version: '0.3.0', manifest_sha256: manifestSha256},
    binding: {task_id: `offline-task-${name}`, run_id: `offline-run-${name}`, subject_key: 'offline-subject',
      config_version: 'offline-config-1', stage_id: 'initial', event_id: `offline-event-${name}`},
    record: {base_token: 'offline-base', table_id: 'offline-table', record_id: `offline-record-${name}`},
    review_round: {round_id: `offline-round-${name}`, input_snapshot_id: `offline-snapshot-${name}`, parent: null},
    source: {source_id: 'source-1', timeline_basis: 'vm_original', vmid: 'offline-vmid',
      sha256: sha256(fixtureSource), bytes: fixtureSource.length, duration_ms: durationMs},
    instructions: [{instruction_id: 'instruction-1', source_field_id: 'offline-opinion-field',
      raw_text: opinion, timeline_basis: 'vm_original', applicability: 'current_round'}],
    output_profile: {id: 'review_mp4_v1', width: 1920, height: 1080, fps: 25, audio: 'preserve'},
    delivery_target: {attachment_field_id: 'offline-output-field'},
  };
  if (extra) extra(input);
  const inputPath = path.join(runDir, 'input.json');
  await save(inputPath, input);
  const context = {protocol: input.protocol, schema_version: schemaVersion, input_sha256: sha256(await readFile(inputPath)),
    run_dir: runDir, source_path: sourceFile, plan_path: path.join(runDir, 'plan.json'),
    plan_result_path: path.join(runDir, 'plan-result.json'), result_path: path.join(runDir, 'result.json'),
    output_path: path.join(runDir, 'review.mp4')};
  const contextPath = path.join(runDir, 'execution-context.json');
  await save(contextPath, context);
  if (words) await save(path.join(runDir, 'alignment.words.json'), {
    schema_version: 1, source_sha256: input.source.sha256,
    provider: 'synthetic-offline-fixture', model: 'synthetic-offline-fixture',
    adapter: 'synthetic-offline-fixture', words,
  });
  const run = mode => runVmPmoOffline({mode, pythonPath, packageRoot, contextPath,
    timeoutMs: 60000, environment: {...safeEnv, FEISHU_APP_SECRET: 'synthetic-must-be-stripped'}});
  return {input, inputPath, context, contextPath, run};
}

async function reviewFixture(name, sourceFile, parent, opinion, words = null) {
  const runDir = path.join(root, name);
  await mkdir(runDir);
  const sourceBytes = await readFile(sourceFile);
  const sourceSha256 = sha256(sourceBytes);
  const duration = await probeDurationMs(sourceFile);
  const input = {
    protocol: 'vm_pmo_review_video', schema_version: 2,
    package: {alias: 'slicing-offline', name: 'auto-cut-slicing', version: '0.3.0', manifest_sha256: manifestSha256},
    binding: {task_id: `offline-task-${name}`, run_id: `offline-run-${name}`, subject_key: 'offline-subject',
      config_version: 'offline-config-1', stage_id: 'review', event_id: `offline-event-${name}`},
    record: {base_token: 'offline-base', table_id: 'offline-table', record_id: 'offline-record'},
    review_round: {round_id: `offline-round-${name}`, input_snapshot_id: `offline-snapshot-${name}`,
      parent: {...parent, sha256: sourceSha256, bytes: sourceBytes.length, duration_ms: duration}},
    source: {source_id: `source-${name}`, timeline_basis: 'previous_review_video', vmid: 'offline-vmid',
      sha256: sourceSha256, bytes: sourceBytes.length, duration_ms: duration},
    instructions: [{instruction_id: `instruction-${name}`, source_field_id: 'offline-review-opinion-field',
      raw_text: opinion, timeline_basis: 'previous_review_video', applicability: 'current_round'}],
    output_profile: {id: 'review_mp4_v1', width: 1920, height: 1080, fps: 25, audio: 'preserve'},
    delivery_target: {attachment_field_id: 'offline-output-field'},
  };
  const inputPath = path.join(runDir, 'input.json');
  await save(inputPath, input);
  const context = {protocol: input.protocol, schema_version: 2,
    input_sha256: sha256(await readFile(inputPath)), run_dir: runDir, source_path: sourceFile,
    plan_path: path.join(runDir, 'plan.json'), plan_result_path: path.join(runDir, 'plan-result.json'),
    result_path: path.join(runDir, 'result.json'), output_path: path.join(runDir, 'review.mp4')};
  const contextPath = path.join(runDir, 'execution-context.json');
  await save(contextPath, context);
  if (words) {
    await save(path.join(runDir, 'alignment.words.json'), {
      schema_version: 1, source_sha256: sourceSha256,
      provider: 'synthetic-offline-fixture', model: 'synthetic-offline-fixture',
      adapter: 'synthetic-offline-fixture', words,
    });
  }
  const run = mode => runVmPmoOffline({mode, pythonPath, packageRoot, contextPath,
    timeoutMs: 60000, environment: {...safeEnv, FEISHU_APP_SECRET: 'synthetic-must-be-stripped'}});
  return {input, inputPath, context, contextPath, run, sourceSha256, sourceBytes, duration};
}

const happy = await fixture('success');
const planOutcome = await happy.run('plan');
assert.equal(planOutcome.status, 'ready');
const plan = await validateVmPmoPlan({contextPath: happy.contextPath});
assert.equal(plan.status, 'ready');
assert.deepEqual(plan.plan.segments.map(s => [s.start_ms, s.end_ms]), [[800, 1200], [0, 400]]);
checks.push('real package plan preserves requested range order');
const renderOutcome = await happy.run('render');
assert.equal(renderOutcome.status, 'rendered');
const rendered = await validateVmPmoRender({contextPath: happy.contextPath});
assert.equal(rendered.status, 'rendered');
assert.equal(rendered.artifact.width, 1920);
assert.equal(rendered.artifact.height, 1080);
assert.equal(rendered.artifact.fps, 25);
assert.equal(rendered.artifact.has_audio, true);
assert.ok(Math.abs(rendered.media.durationMs - 800) <= 80);
checks.push('real package render passes independent H264/AAC/1080p25/full-decode/hash validation');
await assert.rejects(happy.run('render'));
checks.push('old receipt cannot be reused');

const initialSemantic = await fixture('initial-v2-semantic', '0:00 剪掉“上一章”三个字的声音', null,
  sourcePath, 2, [
    {text: '前文', start: 0, end: 0.2}, {text: '上一章', start: 0.2, end: 0.4},
    {text: '后文', start: 0.4, end: 1.8},
  ]);
assert.equal((await initialSemantic.run('plan')).status, 'ready');
const initialSemanticPlan = await validateVmPmoPlan({contextPath: initialSemantic.contextPath});
assert.equal(initialSemanticPlan.input.binding.stage_id, 'initial');
assert.equal(initialSemanticPlan.input.review_round.parent, null);
assert.equal(initialSemanticPlan.plan.operations[0].kind, 'mute_word');
assert.equal(initialSemanticPlan.plan.operations[0].matched_text, '上一章');
assert.equal(initialSemanticPlan.plan.source.timeline_basis, 'vm_original');
assert.equal((await initialSemantic.run('render')).status, 'rendered');
const initialSemanticRender = await validateVmPmoRender({contextPath: initialSemantic.contextPath});
assert.equal(initialSemanticRender.status, 'rendered');
assert.equal(initialSemanticRender.artifact.has_audio, true);
checks.push('v2 initial mutes a source-bound word on the original VM timeline and passes host validation');

const initialParent = {kind: 'managed_run', run_id: happy.input.binding.run_id,
  artifact_id: 'offline-initial-artifact', delivery_id: 'offline-initial-delivery'};
const firstReview = await reviewFixture('review-round-1', happy.context.output_path, initialParent,
  '剪掉“上一章”三个字，其他不变', [
    {text: '前文', start: 0, end: 0.2}, {text: '上一章', start: 0.2, end: 0.4},
    {text: '后文', start: 0.4, end: 0.8},
  ]);
assert.equal((await firstReview.run('plan')).status, 'ready');
const firstPlan = await validateVmPmoPlan({contextPath: firstReview.contextPath});
assert.equal(firstPlan.plan.operations[0].kind, 'word');
assert.equal(firstPlan.plan.operations[0].alignment_sha256, firstPlan.plan.alignment_sha256);
assert.equal(firstPlan.plan.operations[0].source_start_us, 200000);
assert.equal(firstPlan.plan.operations[0].source_end_us, 400000);
assert.equal((await firstReview.run('render')).status, 'rendered');
const firstRendered = await validateVmPmoRender({contextPath: firstReview.contextPath});
assert.equal(firstRendered.status, 'rendered');
assert.ok(Math.abs(firstRendered.media.durationMs - 600) <= 80);
checks.push('v2 review deletes an exactly aligned word from the confirmed parent and validates the MP4');

const muteReview = await reviewFixture('review-mute-word', happy.context.output_path, initialParent,
  '0:00 剪掉“上一章”三个字的声音', [
    {text: '前文', start: 0, end: 0.2}, {text: '上一章', start: 0.2, end: 0.4},
    {text: '后文', start: 0.4, end: 0.8},
  ]);
assert.equal((await muteReview.run('plan')).status, 'ready');
const mutePlan = await validateVmPmoPlan({contextPath: muteReview.contextPath});
assert.equal(mutePlan.plan.operations[0].kind, 'mute_word');
assert.equal(mutePlan.plan.operations[0].matched_text, '上一章');
assert.equal(mutePlan.plan.expected_duration_ms, 800);
assert.equal((await muteReview.run('render')).status, 'rendered');
const muteRendered = await validateVmPmoRender({contextPath: muteReview.contextPath});
assert.equal(muteRendered.status, 'rendered');
checks.push('v2 source-bound word mute renders and the host accepts the duration-preserving MP4');

const startCueReview = await reviewFixture('review-start-cue', happy.context.output_path, initialParent,
  '0:00.20（接下来）-0:00.80', [
    {text: '前文', start: 0, end: 0.2}, {text: '接下来', start: 0.2, end: 0.4},
    {text: '后文', start: 0.4, end: 0.8},
  ]);
assert.equal((await startCueReview.run('plan')).status, 'ready');
const startCuePlan = await validateVmPmoPlan({contextPath: startCueReview.contextPath});
assert.deepEqual(startCuePlan.plan.operations.map(({kind, source_start_us, source_end_us, matched_text}) =>
  ({kind, source_start_us, source_end_us, matched_text})), [
  {kind: 'start_cue', source_start_us: 200000, source_end_us: 400000, matched_text: '接下来'},
]);
assert.equal((await startCueReview.run('render')).status, 'rendered');
const startCueRendered = await validateVmPmoRender({contextPath: startCueReview.contextPath});
assert.ok(Math.abs(startCueRendered.media.durationMs - 600) <= 80);
checks.push('v2 start cue is recorded, independently matched to unique source-bound word timing, and rendered');

const secondReview = await reviewFixture('review-round-2', firstReview.context.output_path,
  {kind: 'managed_run', run_id: firstReview.input.binding.run_id,
    artifact_id: 'offline-review-1-artifact', delivery_id: 'offline-review-1-delivery'},
  '0:00-0:00.50');
assert.equal((await secondReview.run('plan')).status, 'ready');
assert.equal((await secondReview.run('render')).status, 'rendered');
const secondRendered = await validateVmPmoRender({contextPath: secondReview.contextPath});
assert.ok(Math.abs(secondRendered.media.durationMs - 500) <= 80);
checks.push('a second v2 review round uses the first review MP4 as its exact parent');

for (const [name, words] of [
  ['ambiguous-review', [
    {text: '上一章', start: 0.05, end: 0.15}, {text: '正文', start: 0.15, end: 0.3},
    {text: '上一章', start: 0.4, end: 0.5},
  ]],
  ['stale-alignment', [
    {text: '上一章', start: 0.2, end: 0.4},
  ]],
]) {
  const blocked = await reviewFixture(name, happy.context.output_path, initialParent,
    '剪掉“上一章”三个字', words);
  if (name === 'stale-alignment') {
    const alignmentPath = path.join(path.dirname(blocked.contextPath), 'alignment.words.json');
    const alignment = await json(alignmentPath);
    alignment.source_sha256 = '0'.repeat(64);
    await writeFile(alignmentPath, JSON.stringify(alignment));
  }
  const outcome = await blocked.run('plan');
  assert.equal(outcome.status, 'blocked');
  const receipt = await json(blocked.context.plan_result_path);
  assert.equal(receipt.instruction_results[0].raw_text, blocked.input.instructions[0].raw_text);
  assert.ok(!await readFile(blocked.context.output_path).then(() => true, () => false));
  assert.ok(!await readFile(blocked.context.plan_path).then(() => true, () => false));
  checks.push(`${name} blocks before producing a plan or MP4`);
}

for (const [name, opinion, edit] of [
  ['semantic', '0:00-0:00.20，把开头字幕去掉', null],
  ['multiple', '0:00-0:00.20', input => input.instructions.push({
    ...input.instructions[0], instruction_id: 'instruction-2', raw_text: '0:00.40-0:00.60'})],
  ['review', '0:00-0:00.20', input => { input.binding.stage_id = 'first_review'; }],
]) {
  const test = await fixture(name, opinion, edit);
  const outcome = await test.run('plan');
  assert.equal(outcome.status, 'blocked');
  const receipt = await json(test.context.plan_result_path);
  assert.deepEqual(receipt.instruction_results.map(item => item.raw_text), test.input.instructions.map(item => item.raw_text));
  checks.push(`${name} is blocked with all original instructions retained`);
}

const changedInput = await fixture('changed-input');
await appendFile(changedInput.inputPath, ' ');
await assert.rejects(changedInput.run('plan'), {code: 'RUN_BINDING_MISMATCH'});
checks.push('changed input bytes rejected before package launch');
const changedPlan = await fixture('changed-plan');
await changedPlan.run('plan');
await appendFile(changedPlan.context.plan_path, ' ');
await assert.rejects(changedPlan.run('render'), {code: 'PLAN_BINDING_MISMATCH'});
checks.push('changed plan bytes rejected before render');
const listPath = path.join(root, 'disguised-source.mp4');
await writeFile(listPath, "ffconcat version 1.0\nfile 'source.mp4'\nduration 2.0\n", {flag: 'wx'});
const list = await fixture('referenced-source', '0:00-0:00.40', null, listPath);
assert.equal((await list.run('plan')).status, 'blocked');
checks.push('media list disguised as MP4 is blocked');
const shortAudioPath = path.join(root, 'short-audio.mp4');
await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
  'color=c=blue:size=1920x1080:rate=25:duration=0.8', '-f', 'lavfi', '-i',
  'sine=frequency=700:sample_rate=48000:duration=0.02', '-c:v', 'libx264',
  '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', shortAudioPath],
  {env: safeEnv, windowsHide: true, timeout: 30000});
const originalOutput = await readFile(happy.context.output_path);
const originalResult = await readFile(happy.context.result_path);
const shortAudioBytes = await readFile(shortAudioPath);
const shortAudioReceipt = JSON.parse(originalResult);
shortAudioReceipt.artifacts[0].sha256 = sha256(shortAudioBytes);
shortAudioReceipt.artifacts[0].bytes = shortAudioBytes.length;
await writeFile(happy.context.output_path, shortAudioBytes);
await writeFile(happy.context.result_path, JSON.stringify(shortAudioReceipt));
await assert.rejects(validateVmPmoRender({contextPath: happy.contextPath}), {code: 'MEDIA_VALIDATION_FAILED'});
await writeFile(happy.context.output_path, originalOutput);
await writeFile(happy.context.result_path, originalResult);
checks.push('almost empty audio track is rejected despite valid container duration and decode');
const receiptBytes = await readFile(happy.context.result_path);
const forged = JSON.parse(receiptBytes);
forged.binding.run_id = 'offline-other-run';
await writeFile(happy.context.result_path, JSON.stringify(forged));
await assert.rejects(validateVmPmoRender({contextPath: happy.contextPath}), {code: 'RUN_BINDING_MISMATCH'});
await writeFile(happy.context.result_path, receiptBytes);
checks.push('receipt from a different run rejected');
const outputBytes = await readFile(happy.context.output_path);
await appendFile(happy.context.output_path, 'corrupt');
await assert.rejects(validateVmPmoRender({contextPath: happy.contextPath}), {code: 'MEDIA_VALIDATION_FAILED'});
await writeFile(happy.context.output_path, outputBytes);
await validateVmPmoRender({contextPath: happy.contextPath});
checks.push('changed output bytes rejected');

const report = {checked_at: new Date().toISOString(), scope: 'offline synthetic media only',
  package: {name: 'auto-cut-slicing', version: '0.3.0', manifest_sha256: manifestSha256},
  source_duration_ms: durationMs, output_duration_ms: rendered.media.durationMs,
  checks, production_enabled: false};
await save(path.join(root, 'verification.json'), report);
console.log(JSON.stringify({root, ...report}, null, 2));
