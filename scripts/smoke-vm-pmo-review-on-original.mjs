import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createV3Fixture, intentFor } from './vm-pmo-offline-v3-checks.mjs';
import { runVmPmoDriver } from '../taskboard/server/vm-pmo-v3-driver.mjs';
import { readVmPmoRunReview } from '../taskboard/server/vm-pmo-run-review.mjs';
import { createVmPmoAiIntentRunner } from '../taskboard/server/vm-pmo-ai-intent.mjs';
import { resolveCodexExecutable } from '../taskboard/shared/codex-executable.mjs';

/** Opt-in check of a review round that goes back to the original source, with ONE real (billed)
 * unattended Codex session. Round 1 is a fixed intent that stops mid-sentence (keeps 0:00-0:05.20, so the
 * last sentence 最后总结 loses 总结); round 2 is real reviewer wording on that draft. The question is
 * whether the AI recovers the cut word from the original. Synthetic media and word timing, no ASR, no Feishu. */
const { values } = parseArgs({ options: {
  'package-root': { type: 'string' }, python: { type: 'string' }, model: { type: 'string' },
  'tool-dir': { type: 'string' }, 'timeout-minutes': { type: 'string', default: '15' },
} });
if (![values['package-root'], values.python].every(value => typeof value === 'string' && path.isAbsolute(value))
  || typeof values.model !== 'string') throw new Error('Provide absolute --package-root and --python, and --model.');
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(workspace, '.runtime/vm-pmo-ai-smoke'), {recursive: true});
const root = await mkdtemp(path.join(workspace, '.runtime/vm-pmo-ai-smoke', 'review-original-'));
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase())));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const model = values.model;
const fixture = await createV3Fixture({root, packageRoot: values['package-root'], pythonPath: values.python, safeEnv, model});
const INITIAL = '0:00-0:05.20，删掉第二遍的“我们再看一下”';
const REVIEW = '视频结尾的最后一句话没说完';

// Round 1: the draft, from a fixed intent (no model call).
const initial = await fixture.prepare('initial', {instruction: INITIAL});
const fixed = {session: {agent: 'codex', model}, async run({context, onSpawn}) {
  if (onSpawn) await onSpawn({pid: process.pid, startedAt: new Date().toISOString()});
  const {writeFile} = await import('node:fs/promises');
  await writeFile(context.intent_path, JSON.stringify(await intentFor(context, fixture.descriptor,
    {end: '0:05.20', endUs: 5_200_000, model}), null, 2) + '\n', {flag: 'wx'});
  return {outcome: 'completed', threadId: null};
}};
const draftPlan = await runVmPmoDriver({...initial.options, mode: 'plan', aiIntent: fixed});
if (draftPlan.status !== 'ready') throw new Error(`draft plan ${JSON.stringify(draftPlan)}`);
// The draft deliberately cuts a sentence, so its own QA may fail; only the rendered MP4's identity is needed here.
const draftRun = await runVmPmoDriver({...initial.options, mode: 'render', aiIntent: fixed, reverseAsr: false});
const draftResult = JSON.parse(await readFile(initial.context.result_path, 'utf8'));
if (draftResult.status !== 'rendered') throw new Error(`draft render ${JSON.stringify(draftRun.errorCode)}`);
const draft = {artifact: draftResult.artifacts[0], qa: draftRun.status};
const plan = JSON.parse(await readFile(initial.context.plan_path, 'utf8'));

// Round 2: real reviewer wording, re-planned on the original by a real AI session.
const review = await fixture.prepare('review', {instruction: REVIEW, review: {
  parent: {runId: 'offline-v3-initial', artifactId: 'draft-artifact', deliveryId: 'draft-delivery',
    localPath: draft.artifact.path, sha256: draft.artifact.sha256, bytes: draft.artifact.bytes,
    durationMs: draft.artifact.duration_ms, reviewRound: 0},
  rebase: {rounds: [{instructionId: 'round-0', sourceFieldId: 'fld-instruction', rawText: INITIAL}],
    timeMaps: [{time_map_id: 'cut-0', plan_sha256: sha256(await readFile(initial.context.plan_path)),
      segments: plan.segments.map(({source_start_us, duration_us, target_start_us}) =>
        ({source_start_us, duration_us, target_start_us}))}]}}});
const aiIntent = createVmPmoAiIntentRunner({codexExecutable: resolveCodexExecutable(), model,
  timeoutMs: Math.round(Number(values['timeout-minutes']) * 60_000), toolDir: values['tool-dir'] ?? null});
const started = Date.now();
let planned;
try {
  planned = await runVmPmoDriver({...review.options, mode: 'plan', aiIntent,
    aiHistory: {parentRunDir: initial.context.run_dir, resumeThreadId: null, imagePaths: [], rebased: true}});
} catch (error) { planned = {status: 'error', errorCode: error?.code ?? String(error)}; }
const seconds = Math.round((Date.now() - started) / 1000);
let rendered = null;
if (planned.status === 'ready') rendered = await runVmPmoDriver({...review.options, mode: 'render', aiIntent, reverseAsr: false})
  .catch(error => ({status: 'error', errorCode: error?.code ?? String(error)}));
const sessions = path.join(path.dirname(review.context.run_dir), 'ai-sessions');
const names = await readdir(sessions).catch(() => []);
const session = names.length ? path.join(sessions, names.at(-1)) : null;
const events = session ? (await readFile(path.join(session, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse) : [];
const reviewView = await readVmPmoRunReview(review.context);
const reviewPlan = planned.status === 'ready' ? JSON.parse(await readFile(review.context.plan_path, 'utf8')) : null;
console.log(JSON.stringify({root, seconds,
  draft: {qa: draft.qa, duration_ms: draft.artifact.duration_ms, segments: plan.segments.map(row => [row.source_start_us, row.source_start_us + row.duration_us])},
  review: {plan: {status: planned.status, error_code: planned.errorCode ?? null},
    segments: reviewPlan?.segments.map(row => [row.source_start_us, row.source_start_us + row.duration_us]) ?? null,
    duration_ms: reviewPlan?.expected_duration_ms ?? null,
    rendered: rendered && {status: rendered.status, duration_ms: rendered.artifact?.duration_ms ?? null,
      qa: rendered.qa ? {overall: rendered.qa.overall, counts: rendered.qa.counts} : null}},
  coverage: reviewView?.coverage ?? [], blockers: reviewView?.blockers ?? [],
  usage: events.filter(event => event.type === 'turn.completed').map(event => event.usage ?? null),
  report: session ? await readFile(path.join(session, 'report.txt'), 'utf8').catch(() => null) : null}, null, 2));
