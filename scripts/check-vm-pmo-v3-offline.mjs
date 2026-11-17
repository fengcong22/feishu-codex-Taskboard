#!/usr/bin/env node
// Offline VM/PMO v3 check: the real package's analyze/plan/render/qa receipts against Taskboard's
// input preparation, validators and AI planning boundary. Synthetic media, synthetic ASR and a
// scripted stand-in for Codex only; no AI call, no ASR call, no Feishu, no upload.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { prepareVmPmoRunInput } from '../taskboard/server/vm-pmo-run-input.mjs';
import { runVmPmoOffline } from '../taskboard/server/vm-pmo-offline-runner.mjs';
import { runVmPmoAiPlanning } from '../taskboard/server/vm-pmo-ai-planner.mjs';
import { validateVmPmoInput } from '../taskboard/server/vm-pmo-result-validator.mjs';

const exec = promisify(execFile);
const { values } = parseArgs({ options: { 'package-root': { type: 'string' }, python: { type: 'string' } } });
if (![values['package-root'], values.python].every((value) => typeof value === 'string' && path.isAbsolute(value)))
  throw new Error('Provide absolute --package-root and --python paths. This check only uses synthetic media.');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verificationRoot = path.join(repoRoot, '.runtime', 'vm-pmo-v3-offline');
await mkdir(verificationRoot, { recursive: true });
const root = await realpath(await mkdtemp(path.join(verificationRoot, 'run-')));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => readFile(file, 'utf8').then(JSON.parse);
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase())));

// A private copy that declares contract v3, so the real package and its manifest hash agree.
const packageRoot = path.join(root, 'package');
await mkdir(packageRoot);
for (const entry of ['auto_cut_slicing', 'docs', 'schemas'])
  await cp(path.join(values['package-root'], entry), path.join(packageRoot, entry), { recursive: true,
    filter: (source) => !source.includes('__pycache__') });
const manifest = await json(path.join(values['package-root'], 'PACKAGE-MANIFEST.json'));
manifest.interface.contract = { id: 'vm_pmo_review_video', version: 3 };
manifest.interface.driverId = 'vm_pmo_review_video_v3';
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(packageRoot, 'PACKAGE-MANIFEST.json'), manifestBytes);

const RAW = '0:00-0:05.60，删掉第二遍的“我们再看一下”';
const UTTERANCES = [
  ['我们开始。', [['我们', 0.2, 0.5], ['开始', 0.5, 0.9]]],
  ['我们再看一下这个实验。', [['我们', 1.2, 1.4], ['再看一下', 1.4, 1.9], ['这个', 1.9, 2.1], ['实验', 2.1, 2.5]]],
  ['然后我们再看一下结果。', [['然后', 3.0, 3.3], ['我们', 3.3, 3.5], ['再看一下', 3.5, 4.0], ['结果', 4.0, 4.4]]],
  ['最后总结。', [['最后', 4.9, 5.2], ['总结', 5.2, 5.6]]],
];
const tone = `0.5*sin(2*PI*500*t)*(${UTTERANCES.flatMap(([, rows]) => rows.map(([, a, b]) => `between(t,${a},${b})`)).join('+')})`;
const sourcePath = path.join(root, 'source.mp4');
await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=6',
  '-f', 'lavfi', '-i', `aevalsrc='${tone}':s=48000:d=6`, '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath], { env: safeEnv, windowsHide: true, timeout: 60000 });
const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', sourcePath],
  { env: safeEnv, windowsHide: true, timeout: 30000 });
const sourceBytes = await readFile(sourcePath);
const acquisition = { path: sourcePath, sha256: sha256(sourceBytes), bytes: sourceBytes.length,
  duration_ms: Math.round(Number(JSON.parse(stdout).format.duration) * 1000), vmid_binding: 'vm_api_verified', vmid: 'vmid-offline' };

const prepared = await prepareVmPmoRunInput({ runRoot: path.join(root, 'runs'), runId: 'run-v3', taskId: 'task-v3',
  pythonPath: values.python,
  origin: { source: 'feishu-base', packageSource: 'subject-config', eventId: 'event-v3', baseToken: 'base-offline',
    tableId: 'table-offline', recordId: 'record-offline', subjectKey: 'base-offline:table-offline', configVersion: 1,
    stageId: 'initial', packageAlias: 'slicing-offline',
    stageSnapshot: { vmContext: { vmid: 'vmid-offline', title: '离线v3', instruction: RAW } } },
  profile: { fields: { namingFieldId: 'fld-name', outputAttachmentFieldId: 'fld-output' },
    stages: { initial: { instructionFieldId: 'fld-instruction' } } },
  packageSnapshot: { packageAlias: 'slicing-offline', workspacePath: packageRoot, model: 'offline-model',
    workflowTemplate: { id: 'vm_pmo_review_video', version: 1 } },
  packageIdentity: { name: manifest.name, version: manifest.version, manifestSha256: sha256(manifestBytes),
    contractVersion: 3, driverId: 'vm_pmo_review_video_v3' },
  acquisition });
const { context, input } = await validateVmPmoInput({ contextPath: prepared.contextPath });
assert.equal(input.planning_mode, 'ai_intent');
// Synthetic ASR stands in for the live service; analyze reuses and re-verifies it.
await writeFile(path.join(context.run_dir, 'alignment.words.json'), JSON.stringify({ schema_version: 1,
  source_sha256: acquisition.sha256, provider: 'synthetic-offline-fixture', model: 'synthetic-offline-fixture',
  adapter: 'synthetic-offline-fixture',
  words: UTTERANCES.flatMap(([, rows]) => rows.map(([text, start, end]) => ({ text, start, end }))),
  utterances: UTTERANCES.map(([text, rows]) => ({ text, words: rows.map(([word, start, end]) => ({ text: word, start, end })) })),
}, null, 2) + '\n', { flag: 'wx' });

const checks = [];
const run = (mode, extra = {}) => runVmPmoOffline({ mode, pythonPath: values.python, packageRoot, contextPath: prepared.contextPath,
  timeoutMs: 120000, environment: { ...safeEnv, FEISHU_APP_SECRET: 'synthetic-must-be-stripped' }, ...extra });

const analyzed = await run('analyze');
assert.equal(analyzed.status, 'ready');
checks.push('analyze receipt binds ASR, intent context and evidence');

const span = (text, start = 0) => { const index = RAW.indexOf(text, start); return { instruction_id: 'instruction-1', start: index, end: index + text.length }; };
const intentFor = async () => {
  const alignmentSha = sha256(await readFile(path.join(context.run_dir, 'alignment.words.json')));
  const clipSpan = span('0:00-0:05.60'), deleteSpan = span('删掉第二遍的“我们再看一下”');
  const durationUs = Math.round(Number(JSON.parse(stdout).format.duration) * 1_000_000);
  return { schema: 'auto-cut-slicing/edit-intent', schema_version: 1, status: 'proposed',
    author: { kind: 'ai', agent: 'codex', model: input.ai_session.model, session_id: input.ai_session.session_id },
    bindings: { timeline_basis: 'vm_original',
      sources: [{ source_id: 'source-1', sha256: acquisition.sha256, duration_us: durationUs, alignment_sha256: alignmentSha }],
      evidence_manifest_sha256: sha256(await readFile(path.join(context.evidence_dir, 'manifest.json'))) },
    instructions: [{ instruction_id: 'instruction-1', raw_text: RAW, raw_text_sha256: sha256(Buffer.from(RAW)) }],
    coverage: [
      { span: clipSpan, quote: '0:00-0:05.60', disposition: 'operation', intent_ids: ['clip-1'], reason: '保留范围' },
      { span: deleteSpan, quote: '删掉第二遍的“我们再看一下”', disposition: 'operation', intent_ids: ['del-1'], reason: '第二次出现，音画同删' }],
    outputs: [{ output_id: 'review', clips: [{ intent_id: 'clip-1', source_id: 'source-1', covers: [clipSpan],
      start: { mode: 'time', at: { ref: 'user_anchor', value_us: 0, span: span('0:00') } },
      end: { mode: 'time', at: { ref: 'user_anchor', value_us: 5_600_000, span: span('0:05.60') } },
      operations: [{ intent_id: 'del-1', kind: 'delete_phrase', covers: [deleteSpan], rationale: '第二遍',
        phrase: { source_id: 'source-1', alignment_sha256: alignmentSha, first_index: 7, last_index: 8, text: '我们再看一下',
          selection: { method: 'user_ordinal', scope_start_us: 0, scope_end_us: 5_600_000,
            candidates: [{ first_index: 2, last_index: 3, start_us: 1_200_000, end_us: 1_900_000 },
              { first_index: 7, last_index: 8, start_us: 3_300_000, end_us: 4_000_000 }],
            evidence_id: null, ordinal: 2, ordinal_span: span('第二遍') } } }],
      must_keep: [], rationale: 'offline' }] }],
    blockers: [] };
};

// The scripted stand-in writes what Codex would write; the planner still enforces its boundary.
const scripted = (write) => ({ onRawEvent }) => {
  const child = new EventEmitter();
  child.pid = process.pid;
  const completion = (async () => {
    onRawEvent({ type: 'thread.started', thread_id: 'offline-thread' });
    await write();
    onRawEvent({ type: 'item.completed', item: { type: 'agent_message', id: 'm', text: '离线替身：删除第二次出现。' } });
    return { exitCode: 0, signal: null };
  })();
  return { child, completion };
};
const ai = await runVmPmoAiPlanning({ codexExecutable: 'offline-stand-in', packageRoot, pythonPath: values.python, context,
  model: 'offline-model', transcriptPath: path.join(path.dirname(context.run_dir), 'attempt-1.ai-session.jsonl'),
  spawnTurn: scripted(async () => writeFile(context.intent_path, JSON.stringify(await intentFor(), null, 2) + '\n')) });
assert.equal(ai.status, 'ready');
checks.push('AI planning boundary accepts an intent-only turn');

const planned = await run('plan');
assert.equal(planned.status, 'ready', JSON.stringify(planned.blockers ?? planned.errorCode));
assert.equal(planned.plan.planning_mode, 'ai_intent');
assert.equal(planned.plan.intent_sha256, ai.intentSha256);
const deletion = planned.plan.operations.find((row) => row.kind === 'word');
assert.deepEqual([deletion.intent_id, deletion.source_start_us, deletion.source_end_us], ['del-1', 3_300_000, 4_000_000]);
checks.push('Taskboard validator accepts the real v3 plan and receipt');

const rendered = await run('render');
assert.equal(rendered.status, 'rendered');
assert.equal(rendered.artifact.duration_ms, 4_900);
checks.push('render receipt and MP4 pass Taskboard media validation');

const qa = await run('qa', { planSha256: planned.planSha256, reverseAsr: false });
assert.equal(qa.status, 'checked');
assert.ok(['ready_for_review', 'failed'].includes(qa.overall));
checks.push(`QA receipt validated (overall=${qa.overall})`);

// A second attempt whose AI step only writes outside the intent is blocked before planning.
const scope = await prepareVmPmoRunInput({ runRoot: path.join(root, 'runs'), runId: 'run-v3', taskId: 'task-v3',
  pythonPath: values.python, origin: { source: 'feishu-base', packageSource: 'subject-config', eventId: 'event-v3',
    baseToken: 'base-offline', tableId: 'table-offline', recordId: 'record-offline', subjectKey: 'base-offline:table-offline',
    configVersion: 1, stageId: 'initial', packageAlias: 'slicing-offline',
    stageSnapshot: { vmContext: { vmid: 'vmid-offline', title: '离线v3', instruction: RAW } } },
  profile: { fields: { namingFieldId: 'fld-name', outputAttachmentFieldId: 'fld-output' },
    stages: { initial: { instructionFieldId: 'fld-instruction' } } },
  packageSnapshot: { packageAlias: 'slicing-offline', workspacePath: packageRoot, model: 'offline-model',
    workflowTemplate: { id: 'vm_pmo_review_video', version: 1 } },
  packageIdentity: { name: manifest.name, version: manifest.version, manifestSha256: sha256(manifestBytes),
    contractVersion: 3, driverId: 'vm_pmo_review_video_v3' }, acquisition, planAttempt: 2 });
const secondDir = path.dirname(scope.contextPath);
assert.equal(sha256(await readFile(path.join(secondDir, 'alignment.words.json'))),
  sha256(await readFile(path.join(context.run_dir, 'alignment.words.json'))));
const secondAnalyze = await runVmPmoOffline({ mode: 'analyze', pythonPath: values.python, packageRoot,
  contextPath: scope.contextPath, timeoutMs: 120000, environment: safeEnv });
assert.equal(secondAnalyze.status, 'ready');
const secondContext = (await validateVmPmoInput({ contextPath: scope.contextPath })).context;
const violation = await runVmPmoAiPlanning({ codexExecutable: 'offline-stand-in', packageRoot, pythonPath: values.python,
  context: secondContext, transcriptPath: path.join(path.dirname(secondDir), 'attempt-2.ai-session.jsonl'),
  spawnTurn: scripted(async () => {
    await writeFile(secondContext.intent_path, '{}\n');
    await writeFile(secondContext.plan_path, '{}\n');
  }) });
assert.deepEqual([violation.status, violation.errorCode], ['blocked', 'VM_PMO_AI_SCOPE_VIOLATION']);
checks.push('attempt 2 reuses ASR; an AI turn that writes a plan is blocked');

const report = { checked_at: new Date().toISOString(), scope: 'offline synthetic media, synthetic ASR, scripted AI stand-in',
  root, checks };
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
