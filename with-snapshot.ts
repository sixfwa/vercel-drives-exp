// With Sandbox snapshots: install once, snapshot the whole sandbox filesystem, and create later
// sandboxes from that snapshot so node_modules is already in place.
import { Sandbox, type Snapshot } from '@vercel/sandbox';
import { SIZES, RESULTS_FILE, SANDBOX_ENV, SANDBOX_TIMEOUT, average, log, pickRuns, pickSize, recordResult, seconds, stopQuietly, withRetry } from './shared.js';

const SIZE = pickSize();
const RUNS = pickRuns();
const { repos: REPOS, about: ABOUT } = SIZES[SIZE];
const REGION = 'iad1';
const WORKDIR = '/vercel/app';
const NPM_ARGS = ['install', '--loglevel', 'error', '--no-update-notifier', '--no-audit', '--no-fund'];

type Timing = { installMs: number; totalMs: number };

async function run(sandbox: Sandbox, cmd: string, args: string[], cwd?: string) {
  const result = await sandbox.runCommand({ cmd, args, cwd, stdout: process.stdout, stderr: process.stderr });
  if (result.exitCode !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" exited with code ${result.exitCode}`);
  }
}

// Run 1: cold install, then snapshot the sandbox. snapshot() stops the sandbox as part of the process,
// so the snapshot creation time is included in the end-to-end figure (it is the cost of building the cache).
async function populateRun(): Promise<{ timing: Timing; snapshot: Snapshot }> {
  const label = 'run 1 (install + snapshot)';
  const runStarted = Date.now();

  log(`${label}: creating sandbox in ${REGION}`);
  const sandbox = await Sandbox.create({
    region: REGION,
    timeout: SANDBOX_TIMEOUT,
    env: SANDBOX_ENV,
    persistent: false, // we take one explicit snapshot below instead of auto-snapshotting on stop
  });
  log(`${label}: sandbox "${sandbox.name}" ready after ${seconds(Date.now() - runStarted)}`);

  let installMs = 0;
  let snapshotStarted = 0;
  let snapshot: Snapshot;
  try {
    for (const repo of REPOS) {
      const dir = `${WORKDIR}/${repo.split('/').pop()}`;
      log(`${label}: cloning ${repo}`);
      await run(sandbox, 'git', ['clone', '--depth', '1', repo, dir]);

      log(`${label}: npm install in ${dir} (cold, nothing cached)`);
      const started = Date.now();
      await run(sandbox, 'npm', NPM_ARGS, dir);
      installMs += Date.now() - started;
    }
    log(`${label}: npm install took ${seconds(installMs)} in total`);

    log(`${label}: snapshotting the sandbox filesystem (this also stops the sandbox)`);
    snapshotStarted = Date.now();
    snapshot = await sandbox.snapshot({ expiration: 24 * 60 * 60 * 1000 }); // safety net if cleanup never runs
  } catch (error) {
    await stopQuietly(sandbox); // never leave a sandbox running after a failed run
    throw error;
  }
  log(`${label}: snapshot ${snapshot.snapshotId} created in ${seconds(Date.now() - snapshotStarted)}, ${(snapshot.sizeBytes / 1e9).toFixed(2)} GB`);

  const totalMs = Date.now() - runStarted;
  log(`${label}: ${seconds(totalMs)} end to end`);
  recordResult({ mode: 'with-snapshot', size: SIZE, run: 1, phase: 'populate', installMs, totalMs, sandbox: sandbox.name });
  return { timing: { installMs, totalMs }, snapshot };
}

// Runs 2..N: a brand-new sandbox restored from the snapshot. The repos and node_modules are already
// there, so the same npm install should have nothing to do.
async function restoreRun(runNumber: number, snapshot: Snapshot): Promise<Timing> {
  const label = `run ${runNumber} (from snapshot)`;
  const runStarted = Date.now();

  log(`${label}: creating sandbox in ${REGION} from snapshot ${snapshot.snapshotId}`);
  const sandbox = await Sandbox.create({
    source: { type: 'snapshot', snapshotId: snapshot.snapshotId },
    region: REGION,
    timeout: SANDBOX_TIMEOUT,
    env: SANDBOX_ENV,
    persistent: false,
  });
  log(`${label}: sandbox "${sandbox.name}" ready after ${seconds(Date.now() - runStarted)} (node_modules already present)`);

  let installMs = 0;
  try {
    for (const repo of REPOS) {
      const dir = `${WORKDIR}/${repo.split('/').pop()}`;
      log(`${label}: npm install in ${dir} (restored, should be a no-op)`);
      const started = Date.now();
      await run(sandbox, 'npm', NPM_ARGS, dir);
      installMs += Date.now() - started;
    }
  } catch (error) {
    await stopQuietly(sandbox);
    throw error;
  }
  log(`${label}: npm install took ${seconds(installMs)} in total`);

  await stopQuietly(sandbox);
  const totalMs = Date.now() - runStarted;
  log(`${label}: sandbox stopped, ${seconds(totalMs)} end to end`);
  recordResult({ mode: 'with-snapshot', size: SIZE, run: runNumber, phase: 'restore', installMs, totalMs, sandbox: sandbox.name });
  return { installMs, totalMs };
}

log(`=== With Sandbox snapshots (${SIZE}: ${ABOUT}, ${RUNS} runs) ===`);
const { timing: populate, snapshot } = await withRetry('run 1', populateRun);
console.log();

const restores: Timing[] = [];
try {
  for (let i = 2; i <= RUNS; i++) {
    restores.push(await withRetry(`run ${i}`, () => restoreRun(i, snapshot)));
    console.log();
  }
} finally {
  await snapshot.delete();
  log(`snapshot ${snapshot.snapshotId} deleted`);
}

const installAvg = average(restores.map((t) => t.installMs));
const totalAvg = average(restores.map((t) => t.totalMs));
log(`Comparison for ${SIZE}:`);
log(`  run 1 (install + snapshot):  install ${seconds(populate.installMs)}, end to end ${seconds(populate.totalMs)}`);
restores.forEach((t, i) => log(`  run ${i + 2} (from snapshot):      install ${seconds(t.installMs)}, end to end ${seconds(t.totalMs)}`));
log(`  restore average: install ${seconds(installAvg)} (${(populate.installMs / installAvg).toFixed(1)}x vs run 1), end to end ${seconds(totalAvg)}`);
log(`results appended to ${RESULTS_FILE}`);
