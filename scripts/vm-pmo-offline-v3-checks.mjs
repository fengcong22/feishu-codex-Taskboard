import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareVmPmoRunInput } from '../taskboard/server/vm-pmo-run-input.mjs';
import { runVmPmoOffline } from '../taskboard/server/vm-pmo-offline-runner.mjs';
import { runVmPmoDriver } from '../taskboard/server/vm-pmo-v3-driver.mjs';
import { readVmPmoRunReview } from '../taskboard/server/vm-pmo-run-review.mjs';
import { validateVmPmoInput, validateVmPmoRender } from '../taskboard/server/vm-pmo-result-validator.mjs';

/** VM/PMO v3 offline checks: synthetic media, synthetic word timing and pre-written edit intents stand
 * in for the live ASR service and the AI session. They verify Taskboard's v3 driver mechanics only,
 * not recognition, AI judgement, listening or Feishu delivery. */
const exec = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => readFile(file, 'utf8').then(JSON.parse);
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const exists = file => lstat(file).then(() => true, () => false);
const RANGE = '0:00-0:05.60';
const RAW = `${RANGE}，删掉第二遍的“我们再看一下”`;
const UTTERANCES = [
  ['我们开始。', [['我们', 0.2, 0.5], ['开始', 0.5, 0.9]]],
  ['我们再看一下这个实验。', [['我们', 1.2, 1.4], ['再看一下', 1.4, 1.9], ['这个', 1.9, 2.1], ['实验', 2.1, 2.5]]],
  ['然后我们再看一下结果。', [['然后', 3.0, 3.3], ['我们', 3.3, 3.5], ['再看一下', 3.5, 4.0], ['结果', 4.0, 4.4]]],
  ['最后总结。', [['最后', 4.9, 5.2], ['总结', 5.2, 5.6]]],
];
// What the second sentence's deletion leaves in the rendered MP4, for the synthetic reverse ASR.
const KEPT = [['我们', 0.2, 0.5], ['开始', 0.5, 0.9], ['我们', 1.2, 1.4], ['再看一下', 1.4, 1.9], ['这个', 1.9, 2.1],
  ['实验', 2.1, 2.5], ['然后', 3.0, 3.3], ['结果', 3.3, 3.7], ['最后', 4.2, 4.5], ['总结', 4.5, 4.9]];
const MODEL = 'offline-fixture-model';

function alignment(sourceSha256, rows = UTTERANCES) {
  const words = rows.flatMap(([, list]) => list).map(([text, start, end]) => ({text, start, end}));
  return {schema_version: 1, source_sha256: sourceSha256, provider: 'synthetic-offline-fixture',
    model: 'synthetic-offline-fixture', adapter: 'synthetic-offline-fixture', words,
    utterances: rows.map(([text, list]) => ({text, words: list.map(([word, start, end]) => ({text: word, start, end}))}))};
}

function span(raw, text) {
  const start = raw.indexOf(text);
  assert.ok(start >= 0);
  return {instruction_id: 'instruction-1', start, end: start + text.length};
}

/** The intent an AI session would write for RAW: keep 0–5.6 s and delete the second repetition. */
async function intentFor(context, descriptor, {blocked = false} = {}) {
  const alignmentSha256 = sha256(await readFile(path.join(context.run_dir, 'alignment.words.json')));
  const clipSpan = span(RAW, RANGE);
  const deleteText = '删掉第二遍的“我们再看一下”';
  const deleteSpan = span(RAW, deleteText);
  const coverage = [
    {span: clipSpan, quote: RANGE, disposition: 'operation', intent_ids: ['clip-1'], reason: '保留范围'},
    blocked
      ? {span: deleteSpan, quote: deleteText, disposition: 'ambiguous', intent_ids: [], reason: '两处都可能'}
      : {span: deleteSpan, quote: deleteText, disposition: 'operation', intent_ids: ['del-1'], reason: '第二次出现，音画同删'},
  ];
  const operations = blocked ? [] : [{intent_id: 'del-1', kind: 'delete_phrase', covers: [deleteSpan], rationale: '第二遍',
    phrase: {source_id: 'source-1', alignment_sha256: alignmentSha256, first_index: 7, last_index: 8, text: '我们再看一下',
      selection: {method: 'user_ordinal', scope_start_us: 0, scope_end_us: 5_600_000,
        candidates: [{first_index: 2, last_index: 3, start_us: 1_200_000, end_us: 1_900_000},
          {first_index: 7, last_index: 8, start_us: 3_300_000, end_us: 4_000_000}],
        evidence_id: null, ordinal: 2, ordinal_span: span(RAW, '第二遍')}}}];
  const anchor = (text, us) => ({ref: 'user_anchor', value_us: us, span: span(RAW, text)});
  return {
    schema: 'auto-cut-slicing/edit-intent', schema_version: 1, status: blocked ? 'blocked' : 'proposed',
    author: {kind: 'ai', agent: 'codex', model: MODEL, session_id: 'offline-fixture-session'},
    bindings: {timeline_basis: 'vm_original',
      sources: [{source_id: 'source-1', sha256: descriptor.sha256, duration_us: descriptor.duration_us,
        alignment_sha256: alignmentSha256}],
      evidence_manifest_sha256: sha256(await readFile(path.join(context.evidence_dir, 'manifest.json')))},
    instructions: [{instruction_id: 'instruction-1', raw_text: RAW, raw_text_sha256: sha256(Buffer.from(RAW))}],
    coverage,
    outputs: [{output_id: 'review', clips: [{intent_id: 'clip-1', source_id: 'source-1', covers: [clipSpan],
      start: {mode: 'time', at: anchor('0:00', 0)}, end: {mode: 'time', at: anchor('0:05.60', 5_600_000)},
      operations, must_keep: [], rationale: 'offline fixture'}]}],
    blockers: blocked ? [{code: 'INTENT_NEEDS_USER_DECISION', spans: [deleteSpan], message: '两处都可能是要删的那一遍',
      missing_evidence: [], candidates: []}] : [],
  };
}

/** Stand-in for the unattended Codex session: same contract (writes only intent_path), no model call. */
function fakeAi(behaviour, descriptor) {
  const calls = [];
  return {calls, session: Object.freeze({agent: 'codex', model: MODEL}), async run({context, sessionDir, onSpawn}) {
    calls.push({sessionDir});
    if (onSpawn) await onSpawn({pid: process.pid, startedAt: new Date().toISOString()});
    if (behaviour === 'timeout-partial') {
      await writeFile(context.intent_path, '{"schema": "auto-cut-slicing/edit-intent", "status"', {flag: 'wx'});
      return {outcome: 'timeout', threadId: null};
    }
    if (behaviour === 'missing') return {outcome: 'completed', threadId: 'offline-thread'};
    if (behaviour === 'failed') return {outcome: 'failed', threadId: null};
    if (behaviour === 'tamper-context') {
      await save(context.intent_path, await intentFor(context, descriptor));
      await writeFile(context.intent_context_path, '{"tampered": true}\n');
      return {outcome: 'completed', threadId: 'offline-thread'};
    }
    if (behaviour === 'early-plan') {
      await save(context.intent_path, await intentFor(context, descriptor));
      await writeFile(context.plan_result_path, '{}\n', {flag: 'wx'});
      return {outcome: 'timeout', threadId: null};
    }
    await save(context.intent_path, await intentFor(context, descriptor, {blocked: behaviour === 'blocked'}));
    return {outcome: 'completed', threadId: 'offline-thread'};
  }};
}

/** Synthetic v3 run directories bound to a v3-manifest copy of the package, with word timing
 * pre-written so analyze never calls ASR. Shared by the offline checks and the opt-in AI smoke test. */
export async function createV3Fixture({root, packageRoot, pythonPath, safeEnv, model = MODEL}) {
  // Deployment preview: the same package code with the manifest the v3 switch will publish.
  const v3Root = path.join(root, 'package-v3');
  await mkdir(v3Root);
  // docs and AGENTS.md are what a real AI session is told to read first.
  for (const name of ['auto_cut_slicing', 'schemas', 'docs', 'AGENTS.md']) {
    await cp(path.join(packageRoot, name), path.join(v3Root, name), {recursive: true,
      filter: source => !source.split(path.sep).includes('__pycache__')});
  }
  const manifest = await json(path.join(packageRoot, 'PACKAGE-MANIFEST.json'));
  manifest.interface.contract.version = 3;
  manifest.interface.driverId = 'vm_pmo_review_video_v3';
  await save(path.join(v3Root, 'PACKAGE-MANIFEST.json'), manifest);
  const manifestSha256 = sha256(await readFile(path.join(v3Root, 'PACKAGE-MANIFEST.json')));

  const sourcePath = path.join(root, 'v3-source.mp4');
  const tone = `0.5*sin(2*PI*500*t)*(${UTTERANCES.flatMap(([, rows]) => rows)
    .map(([, a, b]) => `between(t,${a},${b})`).join('+')})`;
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=6',
    '-f', 'lavfi', '-i', `aevalsrc='${tone}':s=48000:d=6`, '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath], {env: safeEnv, windowsHide: true, timeout: 60000});
  const {stdout} = await exec(pythonPath, ['-c', 'import json,sys; from auto_cut_slicing.media import describe_source; '
    + 'print(json.dumps(describe_source(sys.argv[1])))', sourcePath], {cwd: v3Root, env: safeEnv, windowsHide: true, timeout: 60000});
  const descriptor = JSON.parse(stdout);
  const sourceBytes = await readFile(sourcePath);
  const identity = {name: manifest.name, version: manifest.version, manifestSha256,
    contractVersion: 3, driverId: 'vm_pmo_review_video_v3'};
  const environment = {...safeEnv, FEISHU_APP_SECRET: 'synthetic-must-be-stripped'};

  async function prepare(name, {manualRevision, instruction = RAW, review = null} = {}) {
    const acquisition = {path: sourcePath, sha256: descriptor.sha256, bytes: sourceBytes.length,
      duration_ms: Math.round(descriptor.duration_us / 1000), vmid_binding: 'vm_api_verified', vmid: 'offline-vmid'};
    const prepared = await prepareVmPmoRunInput({runRoot: path.join(root, 'v3-runs'), runId: `offline-v3-${name}`,
      taskId: `offline-v3-task-${name}`, pythonPath,
      origin: {source: 'feishu-base', packageSource: 'subject-config', eventId: `offline-v3-event-${name}`,
        baseToken: 'offline-base', tableId: 'offline-table', recordId: `offline-record-${name}`,
        subjectKey: 'offline-base:offline-table', configVersion: 1, stageId: review ? 'review' : 'initial',
        packageAlias: 'slicing-offline',
        stageSnapshot: {vmContext: {vmid: 'offline-vmid', title: `offline ${name}`, instruction},
          ...(review ? {reviewRound: 1, reviewParent: review.parent,
            reviewSource: {basis: 'vm_original', rootRunId: review.parent.runId, acquisition}} : {})}},
      ...(review ? {rebase: review.rebase} : {}),
      profile: {fields: {namingFieldId: 'fld-name', outputAttachmentFieldId: 'fld-output'},
        stages: {initial: {instructionFieldId: 'fld-instruction'}, review: {instructionFieldId: 'fld-review'}}},
      packageSnapshot: {packageAlias: 'slicing-offline', workspacePath: v3Root,
        workflowTemplate: {id: 'vm_pmo_review_video', version: 1}},
      packageIdentity: identity, manualRevision,
      acquisition,
      aiSession: manualRevision ? undefined : {agent: 'codex', model}});
    const bound = await validateVmPmoInput({contextPath: prepared.contextPath});
    const {context, input} = bound;
    if (!manualRevision) await save(path.join(context.run_dir, 'alignment.words.json'), alignment(descriptor.sha256));
    const options = {pythonPath, packageRoot: v3Root, contextPath: prepared.contextPath, timeoutMs: 120000, environment};
    return {prepared, context, input, options};
  }

  return {prepare, descriptor, manifestSha256, v3Root, raw: RAW};
}

export async function runV3Checks({root, packageRoot, pythonPath, safeEnv, checks}) {
  const {prepare, descriptor, manifestSha256} = await createV3Fixture({root, packageRoot, pythonPath, safeEnv});

  // 1. Taskboard-generated v3 input, analyze -> AI intent -> plan, render, QA with reverse ASR.
  const happy = await prepare('ai-intent');
  assert.equal(happy.input.schema_version, 3);
  assert.equal(happy.input.planning_mode, 'ai_intent');
  assert.deepEqual(happy.input.ai_session, {agent: 'codex', model: MODEL, session_id: 'taskboard-offline-v3-ai-intent-p1'});
  for (const key of ['evidence_dir', 'intent_context_path', 'intent_path', 'analyze_result_path', 'qa_path', 'qa_review_path'])
    assert.equal(path.dirname(happy.context[key]), happy.context.run_dir);
  checks.push('v3 input/context are generated by Taskboard with ai_intent, ai_session and six run-local paths');
  const happyAi = fakeAi('intent', descriptor);
  const started = [];
  const planned = await runVmPmoDriver({...happy.options, mode: 'plan', aiIntent: happyAi,
    onStarted: evidence => { started.push(evidence); }});
  assert.equal(planned.status, 'ready', planned.errorCode);
  assert.equal(started.length, 1);
  assert.equal(started[0].mode, 'plan');
  assert.equal(happyAi.calls.length, 1);
  assert.equal((await json(happy.context.analyze_result_path)).status, 'ready');
  const receipt = await json(happy.context.plan_result_path);
  assert.equal(receipt.planning_mode, 'ai_intent');
  assert.deepEqual(receipt.blockers, []);
  assert.deepEqual(receipt.coverage.map(row => row.disposition), ['operation', 'operation']);
  const deletion = planned.plan.operations.find(row => row.kind === 'word');
  assert.deepEqual([deletion.intent_id, deletion.source_start_us, deletion.source_end_us], ['del-1', 3_300_000, 4_000_000]);
  assert.equal(planned.plan.expected_duration_ms, 4_900);
  checks.push('v3 driver runs analyze, one AI session and plan in order; start evidence is reported once');

  const render = await runVmPmoOffline({...happy.options, mode: 'render', qa: 'skip'});
  assert.equal(render.status, 'rendered');
  await assert.rejects(validateVmPmoRender({contextPath: happy.prepared.contextPath}), {code: 'QA_REQUIRED'});
  const outputSha256 = sha256(await readFile(happy.context.output_path));
  await save(path.join(happy.context.run_dir, 'output.words.json'), {...alignment(outputSha256, [['成片', KEPT]]),
    utterances: undefined});
  const checked = await runVmPmoOffline({...happy.options, mode: 'qa', reverseAsr: true});
  assert.equal(checked.status, 'rendered', checked.errorCode);
  assert.equal(checked.qa.overall, 'ready_for_review');
  assert.equal(checked.qa.reverseAsr, true);
  const delivered = await validateVmPmoRender({contextPath: happy.prepared.contextPath});
  assert.equal(delivered.status, 'rendered');
  assert.ok(Math.abs(delivered.media.durationMs - 4_900) <= 80);
  checks.push('v3 render is not deliverable until qa.json exists; QA with --reverse-asr binds the rendered MP4');

  const review = await readVmPmoRunReview(happy.context);
  assert.equal(review.planningMode, 'ai_intent');
  assert.equal(review.coverage.length, 2);
  assert.equal(review.qa.overall, 'ready_for_review');
  assert.ok(review.qa.needsHuman.length > 0);
  assert.ok(review.qa.needsHuman.every(row => row.status === 'needs_human'));
  checks.push('approval summary exposes coverage and the QA needs_human items');

  // Tampering helpers rewrite qa.json and, where stated, re-sign qa-result.json so the check reaches
  // the binding under test instead of stopping at the receipt hash.
  const qaResultPath = path.join(happy.context.run_dir, 'qa-result.json');
  const qaBytes = await readFile(happy.context.qa_path);
  const receiptBytes = await readFile(qaResultPath);
  const qaReceipt = JSON.parse(receiptBytes);
  assert.deepEqual([qaReceipt.status, qaReceipt.overall, qaReceipt.reverse_asr], ['checked', 'ready_for_review', true]);
  assert.equal(qaReceipt.plan_sha256, sha256(await readFile(happy.context.plan_path)));
  assert.equal(JSON.parse(qaBytes).bindings.plan_sha256, qaReceipt.plan_sha256);
  const counts = report => report.checks.reduce((all, row) => ({...all, [row.status]: (all[row.status] ?? 0) + 1}), {});
  async function forge(report, {sign = true, receipt = {}} = {}) {
    const bytes = Buffer.from(JSON.stringify(report));
    await writeFile(happy.context.qa_path, bytes);
    await writeFile(qaResultPath, JSON.stringify(sign ? {...qaReceipt, qa_sha256: sha256(bytes),
      overall: report.overall, counts: counts(report), ...receipt} : qaReceipt));
  }
  async function restore() { await writeFile(happy.context.qa_path, qaBytes); await writeFile(qaResultPath, receiptBytes); }
  const contextPath = happy.prepared.contextPath;
  const failedReport = JSON.parse(qaBytes);
  failedReport.checks[0].status = 'failed';
  failedReport.overall = 'failed';
  await forge(failedReport);
  const qaFailed = await validateVmPmoRender({contextPath});
  assert.deepEqual([qaFailed.status, qaFailed.errorCode], ['failed', 'VM_PMO_QA_FAILED']);
  await forge(failedReport, {sign: false});
  await assert.rejects(validateVmPmoRender({contextPath}), {code: 'QA_RESULT_INVALID'});
  const otherOutput = JSON.parse(qaBytes);
  otherOutput.bindings.output_sha256 = '0'.repeat(64);
  await forge(otherOutput);
  await assert.rejects(validateVmPmoRender({contextPath}), {code: 'QA_REPORT_INVALID'});
  const otherPlan = JSON.parse(qaBytes);
  otherPlan.bindings.plan_sha256 = '0'.repeat(64);
  await forge(otherPlan);
  await assert.rejects(validateVmPmoRender({contextPath}), {code: 'QA_REPORT_INVALID'});
  const unlabelled = JSON.parse(qaBytes);
  unlabelled.checks[0].status = 'failed';
  await forge(unlabelled, {receipt: {overall: 'ready_for_review'}});
  await assert.rejects(validateVmPmoRender({contextPath}), {code: 'QA_REPORT_INVALID'});
  await restore();
  await writeFile(qaResultPath, JSON.stringify({...qaReceipt, status: 'blocked', qa_sha256: null, overall: null,
    counts: null, error: {code: 'WORD_ALIGNMENT_UNRESOLVED', message: 'Output transcription is unavailable'}}));
  const qaBlocked = await validateVmPmoRender({contextPath});
  assert.deepEqual([qaBlocked.status, qaBlocked.errorCode], ['blocked', 'VM_PMO_QA_BLOCKED']);
  await restore();
  assert.equal((await validateVmPmoRender({contextPath})).status, 'rendered');
  checks.push('qa-result.json binds plan.json and qa.json; failed or blocked QA never delivers; forged reports are rejected');

  // 2. A timed-out session blocks; a manual rerun reuses the attempt's ASR and evidence.
  const timeout = await prepare('ai-timeout');
  const timedOut = await runVmPmoDriver({...timeout.options, mode: 'plan', aiIntent: fakeAi('timeout-partial', descriptor)});
  assert.deepEqual(timedOut, {status: 'blocked', errorCode: 'AI_INTENT_TIMEOUT'});
  assert.equal(await exists(timeout.context.plan_result_path), false);
  const analyzeBytes = await readFile(timeout.context.analyze_result_path);
  const rerunAi = fakeAi('intent', descriptor);
  const rerun = await runVmPmoDriver({...timeout.options, mode: 'plan', aiIntent: rerunAi});
  assert.equal(rerun.status, 'ready', rerun.errorCode);
  assert.deepEqual(await readFile(timeout.context.analyze_result_path), analyzeBytes);
  const sessions = path.join(path.dirname(timeout.context.run_dir), 'ai-sessions');
  assert.equal(path.basename(rerunAi.calls[0].sessionDir), 'attempt-1-session-2');
  assert.ok((await readFile(path.join(sessions, 'attempt-1-session-2', 'superseded-edit-intent.json'), 'utf8'))
    .startsWith('{"schema"'));
  const timeoutRendered = await runVmPmoDriver({...timeout.options, mode: 'render', reverseAsr: false});
  assert.equal(timeoutRendered.status, 'rendered', timeoutRendered.errorCode);
  assert.equal(timeoutRendered.qa.reverseAsr, false);
  checks.push('AI timeout blocks without a plan receipt; rerun reuses analyze and keeps the partial intent as evidence');

  // 3. No intent / failed session / AI-declared block.
  for (const [name, behaviour, code] of [['ai-missing', 'missing', 'AI_INTENT_MISSING'],
    ['ai-failed', 'failed', 'AI_INTENT_FAILED']]) {
    const run = await prepare(name);
    assert.deepEqual(await runVmPmoDriver({...run.options, mode: 'plan', aiIntent: fakeAi(behaviour, descriptor)}),
      {status: 'blocked', errorCode: code});
    assert.equal(await exists(run.context.plan_result_path), false);
    checks.push(`${code} blocks without a plan and never falls back to fixed patterns`);
  }
  // 3b. An AI session that rewrites a protected file or writes a planning output is blocked
  // before the package plans, even when the session itself timed out.
  for (const [name, behaviour] of [['ai-tamper', 'tamper-context'], ['ai-early-plan', 'early-plan']]) {
    const run = await prepare(name);
    assert.deepEqual(await runVmPmoDriver({...run.options, mode: 'plan', aiIntent: fakeAi(behaviour, descriptor)}),
      {status: 'blocked', errorCode: 'AI_INTENT_SCOPE_VIOLATION'});
    assert.equal(await exists(run.context.plan_path), false);
  }
  checks.push('AI_INTENT_SCOPE_VIOLATION blocks an AI session that edits protected files or writes planning output');
  const blocked = await prepare('ai-blocked');
  const blockedPlan = await runVmPmoDriver({...blocked.options, mode: 'plan', aiIntent: fakeAi('blocked', descriptor)});
  assert.deepEqual([blockedPlan.status, blockedPlan.errorCode], ['blocked', 'INTENT_BLOCKED']);
  const blockedReview = await readVmPmoRunReview(blocked.context);
  assert.equal(blockedReview.blockers[0].code, 'INTENT_NEEDS_USER_DECISION');
  assert.equal(await exists(blocked.context.plan_path), false);
  checks.push('an AI-declared block reaches the approval summary with its blockers and no plan');

  // 4. v3 rule path (structured manual revision) behaves like v2 and needs no AI or QA.
  const rule = await prepare('rule', {manualRevision: {sourceSha256: descriptor.sha256, note: 'offline manual revision',
    clips: [{startMs: 0, endMs: 1200}]}});
  assert.equal(rule.input.planning_mode, 'rule');
  assert.equal(rule.input.ai_session, undefined);
  const noAi = {session: {agent: 'codex', model: MODEL}, run: () => assert.fail('rule planning must not start AI')};
  assert.equal((await runVmPmoDriver({...rule.options, mode: 'plan', aiIntent: noAi})).status, 'ready');
  const ruleRendered = await runVmPmoDriver({...rule.options, mode: 'render', aiIntent: noAi});
  assert.equal(ruleRendered.status, 'rendered');
  assert.equal(await exists(rule.context.qa_path), false);
  checks.push('v3 rule planning with a manual revision runs without AI and without QA, like v2');

  // 4b. A review on the original source: the reviewer's time on the draft maps back through the
  // draft's own plan, earlier feedback is re-applied, and content the draft dropped is reachable again.
  const draftPlan = JSON.parse(await readFile(happy.context.plan_path, 'utf8'));
  const REVIEW = '结尾截到0:04.40';
  const rebasedRun = await prepare('rebased-review', {instruction: REVIEW, review: {
    parent: {runId: 'offline-v3-ai-intent', artifactId: 'offline-artifact', deliveryId: 'offline-delivery',
      localPath: delivered.artifact?.path ?? happy.context.output_path, sha256: delivered.artifact?.sha256 ?? 'e'.repeat(64),
      bytes: delivered.artifact?.bytes ?? 1, durationMs: draftPlan.expected_duration_ms, reviewRound: 0},
    rebase: {rounds: [{instructionId: 'round-0', sourceFieldId: 'fld-instruction', rawText: RAW}],
      timeMaps: [{time_map_id: 'cut-0', plan_sha256: sha256(await readFile(happy.context.plan_path)),
        segments: draftPlan.segments.map(({source_start_us, duration_us, target_start_us}) =>
          ({source_start_us, duration_us, target_start_us}))}]}}});
  assert.equal(rebasedRun.input.source.timeline_basis, 'vm_original');
  assert.deepEqual(rebasedRun.input.instructions.map(item => item.instruction_id), ['round-0', 'round-1']);
  const rebasedAi = {session: {agent: 'codex', model: MODEL}, async run({context, onSpawn}) {
    if (onSpawn) await onSpawn({pid: process.pid, startedAt: new Date().toISOString()});
    const value = JSON.parse(JSON.stringify(await intentFor(context, descriptor)).replaceAll('"instruction-1"', '"round-0"'));
    const reviewSpan = {instruction_id: 'round-1', start: REVIEW.indexOf('0:04.40'), end: REVIEW.indexOf('0:04.40') + 7};
    value.instructions.push({instruction_id: 'round-1', raw_text: REVIEW, raw_text_sha256: sha256(Buffer.from(REVIEW))});
    const clip = value.outputs[0].clips[0];
    clip.covers.push(reviewSpan);
    // 0:04.40 on the draft (kept 0-3.3 s and 4.0-5.6 s) is 5.1 s in the original.
    clip.end = {mode: 'time', at: {ref: 'user_anchor', value_us: 5_100_000, span: reviewSpan}};
    clip.operations[0].phrase.selection.scope_end_us = 5_100_000;
    value.coverage[0].reason = '起点保留；终点由第 2 轮意见取代';
    value.coverage.push({span: {instruction_id: 'round-1', start: 0, end: REVIEW.length}, quote: REVIEW,
      disposition: 'operation', intent_ids: ['clip-1'], reason: '审核稿 0:04.40 换算到原片 5.10s'});
    await save(context.intent_path, value);
    return {outcome: 'completed', threadId: 'offline-thread'};
  }};
  const rebasedPlan = await runVmPmoDriver({...rebasedRun.options, mode: 'plan', aiIntent: rebasedAi});
  assert.equal(rebasedPlan.status, 'ready', JSON.stringify(rebasedPlan.blockers ?? rebasedPlan.errorCode));
  assert.equal(rebasedPlan.plan.expected_duration_ms, 4_400);
  assert.equal(rebasedPlan.plan.rule_cross_check, 'not_applicable');
  checks.push('a review on the original source maps the draft time back, re-applies earlier feedback and plans on the original');

  // 5. Tampered v3 bindings are refused before any package launch.
  const tampered = path.join(root, 'v3-tampered');
  await mkdir(tampered);
  const tamperedContext = Object.fromEntries(Object.entries(happy.context).map(([key, value]) =>
    [key, typeof value === 'string' && value.startsWith(happy.context.run_dir + path.sep)
      ? path.join(tampered, path.relative(happy.context.run_dir, value)) : value]));
  tamperedContext.run_dir = tampered;
  tamperedContext.intent_path = path.join(root, 'outside-edit-intent.json');
  await cp(path.join(happy.context.run_dir, 'input.json'), path.join(tampered, 'input.json'));
  await save(path.join(tampered, 'execution-context.json'), tamperedContext);
  await assert.rejects(validateVmPmoInput({contextPath: path.join(tampered, 'execution-context.json')}),
    {code: 'RUN_BINDING_MISMATCH'});
  checks.push('v3 context paths outside the run directory are refused');
  return {manifest_sha256: manifestSha256, output_duration_ms: delivered.media.durationMs};
}

