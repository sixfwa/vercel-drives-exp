// Runner for the real-case experiment.
//
//   tsx experiment/run.ts sequential  [--arms cold,snapshot,drive-ro,drive-fork] [--runs 5] [--prepare]
//   tsx experiment/run.ts concurrent  [--arms ...] [--runs 10]        # all runs of an arm start at once
//   tsx experiment/run.ts refresh     [--arms ...]                    # bump a dependency, rebuild bases, 1 run each
//   tsx experiment/run.ts day2        [--arms ...] [--runs 1]         # same as sequential, labelled day2
//   tsx experiment/run.ts teardown                                     # delete snapshot, drives, forks, state
//
// Bases (snapshot, drive) are built once and remembered in experiment/state.json; pass --prepare to rebuild.
import { parseArgs } from 'node:util';
import { rmSync } from 'node:fs';
import { APIError, Sandbox } from '@vercel/sandbox';
import { log, seconds, stopQuietly, withRetry } from '../shared.js';
import { ARMS, type Arm } from './arms.js';
import { RESULTS_FILE, SCENARIO, STATE_FILE, loadState, recordRow, run, saveState } from './scenario.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    arms: { type: 'string', default: Object.keys(ARMS).join(',') },
    runs: { type: 'string' },
    prepare: { type: 'boolean', default: false },
  },
});
const PHASE = positionals[0];
if (!['sequential', 'concurrent', 'refresh', 'day2', 'teardown'].includes(PHASE ?? '')) {
  console.error('usage: run.ts <sequential|concurrent|refresh|day2|teardown> [--arms a,b] [--runs N] [--prepare]');
  process.exit(1);
}
const RUNS = Number(values.runs ?? (PHASE === 'concurrent' ? 10 : PHASE === 'day2' || PHASE === 'refresh' ? 1 : 5));
const arms = values.arms!.split(',').map((name) => {
  const arm = ARMS[name.trim()];
  if (!arm) {
    console.error(`unknown arm "${name}"; choose from ${Object.keys(ARMS).join(', ')}`);
    process.exit(1);
  }
  return arm;
});

// One agent task: start a sandbox the arm's way, run the tests, edit a file, run them again, stop.
async function agentRun(arm: Arm, phase: string, runNumber: number, concurrency: number) {
  const label = `${arm.name} #${runNumber}`;
  const t0 = Date.now();
  const started = await arm.start(label);
  const { sandbox, workspace } = started;
  const createMs = started.sdkReadyAt - t0;
  log(`${label}: sandbox "${sandbox.name}" ready after ${seconds(createMs)}`);
  const dir = `${workspace}/${SCENARIO.dir}`;

  let readyMs: number | undefined;
  let taskMs: number | undefined;
  let editTaskMs: number | undefined;
  try {
    log(`${label}: running task (${SCENARIO.task.cmd} ${SCENARIO.task.args.join(' ')})`);
    const first = await run(sandbox, label, SCENARIO.task, { cwd: dir, quiet: true });
    readyMs = (first.firstOutputAt ?? Date.now()) - t0;
    taskMs = first.ms;
    log(`${label}: first output after ${seconds(readyMs)}, task done in ${seconds(taskMs)}`);

    await sandbox.writeFiles([{ path: `${dir}/${SCENARIO.edit.path}`, content: SCENARIO.edit.content }]);
    const second = await run(sandbox, label, SCENARIO.task, { cwd: dir, quiet: true });
    editTaskMs = second.ms;
    log(`${label}: task after edit done in ${seconds(editTaskMs)}`);
  } catch (error) {
    await stopQuietly(sandbox);
    await started.cleanup?.();
    throw error;
  }

  await stopQuietly(sandbox);
  const totalMs = Date.now() - t0;
  await started.cleanup?.();

  // Billing metrics are reported by the platform after the fact; take them if they are there.
  const meta = await Sandbox.get({ name: sandbox.name }).catch(() => undefined);
  const activeCpuMs = meta?.totalActiveCpuDurationMs;

  log(`${label}: ${seconds(totalMs)} end to end`);
  recordRow({ arm: arm.name, phase, run: runNumber, concurrency, createMs, readyMs, taskMs, editTaskMs, totalMs, activeCpuMs, sandbox: sandbox.name, notes: started.notes });
}

function isPrepared(arm: Arm) {
  const state = loadState();
  if (arm.name === 'cold') return true;
  if (arm.name === 'snapshot') return Boolean(state.snapshotId);
  return Boolean(state.driveName);
}

async function ensurePrepared(arm: Arm) {
  if (isPrepared(arm) && !values.prepare) return;
  log(`${arm.name}: preparing base`);
  const t = Date.now();
  const notes = await arm.prepare();
  const totalMs = Date.now() - t;
  log(`${arm.name}: base ready in ${seconds(totalMs)} (${notes})`);
  recordRow({ arm: arm.name, phase: 'prepare', run: 0, concurrency: 1, totalMs, sandbox: '', notes });
}

// drive.fork() is a private-beta feature. If the API refuses it, skip the arm instead of aborting the series.
function isForkUnavailable(arm: Arm, error: unknown) {
  return arm.name === 'drive-fork' && error instanceof APIError && [400, 402, 403, 404].includes(error.response.status);
}

async function forEachArm(fn: (arm: Arm) => Promise<void>) {
  for (const arm of arms) {
    try {
      await fn(arm);
    } catch (error) {
      if (!isForkUnavailable(arm, error)) throw error;
      log(`${arm.name}: drive forks are not available on this account (${(error as Error).message}); skipping arm`);
      recordRow({ arm: arm.name, phase: PHASE!, run: 0, concurrency: 1, totalMs: 0, sandbox: '', notes: `skipped: ${(error as Error).message}` });
    }
    console.log();
  }
}

log(`=== ${PHASE} | arms: ${arms.map((a) => a.name).join(', ')} | repo: ${SCENARIO.repo} ===`);

if (PHASE === 'teardown') {
  for (const arm of Object.values(ARMS)) {
    await arm.teardown();
    log(`${arm.name}: torn down`);
  }
  rmSync(STATE_FILE, { force: true });
  log(`state cleared (${STATE_FILE}); results kept in ${RESULTS_FILE}`);
} else if (PHASE === 'sequential' || PHASE === 'day2') {
  await forEachArm(async (arm) => {
    await ensurePrepared(arm);
    for (let i = 1; i <= RUNS; i++) await withRetry(`${arm.name} #${i}`, () => agentRun(arm, PHASE, i, 1));
  });
} else if (PHASE === 'concurrent') {
  await forEachArm(async (arm) => {
    await ensurePrepared(arm);
    log(`${arm.name}: starting ${RUNS} sandboxes at once`);
    const burstStarted = Date.now();
    await Promise.all(Array.from({ length: RUNS }, (_, i) => withRetry(`${arm.name} #${i + 1}`, () => agentRun(arm, PHASE, i + 1, RUNS))));
    log(`${arm.name}: burst of ${RUNS} finished in ${seconds(Date.now() - burstStarted)} wall-clock`);
  });
} else if (PHASE === 'refresh') {
  // 1. Apply the dependency bump to every base. 2. Mark the lockfile as moved on (cold applies it too).
  // 3. One agent run per arm against the refreshed base.
  await forEachArm(async (arm) => {
    await ensurePrepared(arm);
    const t = Date.now();
    const notes = await arm.refresh(`${arm.name}/refresh`);
    const totalMs = Date.now() - t;
    log(`${arm.name}: refresh took ${seconds(totalMs)} (${notes})`);
    recordRow({ arm: arm.name, phase: 'refresh', run: 0, concurrency: 1, totalMs, sandbox: '', notes });
  });
  saveState({ ...loadState(), refreshed: true });
  await forEachArm(async (arm) => {
    for (let i = 1; i <= RUNS; i++) await withRetry(`${arm.name} #${i}`, () => agentRun(arm, 'refresh', i, 1));
  });
}

log(`results in ${RESULTS_FILE}`);
