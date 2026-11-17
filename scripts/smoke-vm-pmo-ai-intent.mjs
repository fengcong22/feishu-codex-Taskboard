import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createV3Fixture } from './vm-pmo-offline-v3-checks.mjs';
import { runVmPmoDriver } from '../taskboard/server/vm-pmo-v3-driver.mjs';
import { readVmPmoRunReview } from '../taskboard/server/vm-pmo-run-review.mjs';
import { createVmPmoAiIntentRunner } from '../taskboard/server/vm-pmo-ai-intent.mjs';
import { resolveCodexExecutable } from '../taskboard/shared/codex-executable.mjs';

/** Opt-in smoke test of step 2 with a REAL unattended Codex session (one model call, billed).
 * Everything else is synthetic: generated media, pre-written word timing, no ASR, no Feishu, no upload.
 * It answers whether the headless sandbox can read the package, run evidence commands and write
 * edit-intent.json in time; it does not judge intent quality on real feedback. */
const { values } = parseArgs({ options: {
  'package-root': { type: 'string' }, python: { type: 'string' }, model: { type: 'string' },
  'timeout-minutes': { type: 'string', default: '15' }, render: { type: 'boolean', default: false },
  'tool-dir': { type: 'string' },
} });
if (![values['package-root'], values.python].every(value => typeof value === 'string' && path.isAbsolute(value))
  || typeof values.model !== 'string') {
  throw new Error('Provide absolute --package-root and --python, and --model. This starts one billed Codex session.');
}
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verificationRoot = path.join(workspace, '.runtime/vm-pmo-ai-smoke');
await mkdir(verificationRoot, {recursive: true});
const root = await mkdtemp(path.join(verificationRoot, 'run-'));
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase())));
const fixture = await createV3Fixture({root, packageRoot: values['package-root'], pythonPath: values.python,
  safeEnv, model: values.model});
const run = await fixture.prepare('ai-smoke');
const aiIntent = createVmPmoAiIntentRunner({codexExecutable: resolveCodexExecutable(), model: values.model,
  timeoutMs: Math.round(Number(values['timeout-minutes']) * 60_000), toolDir: values['tool-dir'] ?? null});
const startedAt = Date.now();
let planned;
try { planned = await runVmPmoDriver({...run.options, mode: 'plan', aiIntent}); }
catch (error) { planned = {status: 'error', errorCode: error?.code ?? String(error)}; }
const seconds = Math.round((Date.now() - startedAt) / 1000);
const sessions = path.join(path.dirname(run.context.run_dir), 'ai-sessions');
const sessionNames = await readdir(sessions).catch(() => []);
const session = sessionNames.length ? path.join(sessions, sessionNames.at(-1)) : null;
const outcome = session ? JSON.parse(await readFile(path.join(session, 'outcome.json'), 'utf8').catch(() => 'null')) : null;
let rendered = null;
if (values.render && planned.status === 'ready') {
  rendered = await runVmPmoDriver({...run.options, mode: 'render', aiIntent, reverseAsr: false})
    .catch(error => ({status: 'error', errorCode: error?.code ?? String(error)}));
}
const review = await readVmPmoRunReview(run.context);
const events = session ? (await readFile(path.join(session, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)
  .map(line => JSON.parse(line)) : [];
const commands = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution')
  .map(event => ({command: String(event.item.command ?? '').slice(0, 300), exit_code: event.item.exit_code ?? null}));
const usage = events.filter(event => event.type === 'turn.completed').map(event => event.usage ?? null);
// The session may only write its run directory; anything newer in the package copy is a boundary breach.
async function changedSince(directory, since) {
  const changed = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.name === '__pycache__') continue;
    if (entry.isDirectory()) changed.push(...await changedSince(file, since));
    else if ((await stat(file)).mtimeMs >= since) changed.push(path.relative(fixture.v3Root, file));
  }
  return changed;
}
const packageChanges = await changedSince(fixture.v3Root, startedAt);
console.log(JSON.stringify({root, run_dir: run.context.run_dir, session_dir: session, seconds,
  plan: {status: planned.status, error_code: planned.errorCode ?? null},
  ai: outcome, rendered: rendered && {status: rendered.status, error_code: rendered.errorCode ?? null,
    qa: rendered.qa ? {overall: rendered.qa.overall, counts: rendered.qa.counts} : null},
  coverage: review?.coverage ?? [], blockers: review?.blockers ?? [], commands, usage,
  package_copy_changes: packageChanges}, null, 2));
