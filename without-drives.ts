// Baseline: every sandbox starts cold, so `npm install` downloads everything again.
import { Sandbox } from '@vercel/sandbox';
import { SIZES, RESULTS_FILE, SANDBOX_ENV, SANDBOX_TIMEOUT, average, log, pickRuns, pickSize, recordResult, seconds, stopQuietly, withRetry } from './shared.js';

const SIZE = pickSize();
const RUNS = pickRuns();
const { repos: REPOS, about: ABOUT } = SIZES[SIZE];
const REGION = 'iad1';
const WORKDIR = '/vercel/app';

type Timing = { installMs: number; totalMs: number };

async function run(sandbox: Sandbox, cmd: string, args: string[], cwd?: string) {
  const result = await sandbox.runCommand({ cmd, args, cwd, stdout: process.stdout, stderr: process.stderr });
  if (result.exitCode !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" exited with code ${result.exitCode}`);
  }
}

async function coldRun(runNumber: number): Promise<Timing> {
  const label = `run ${runNumber}`;
  const runStarted = Date.now();

  log(`${label}: creating sandbox in ${REGION}`);
  const sandbox = await Sandbox.create({
    region: REGION,
    timeout: SANDBOX_TIMEOUT,
    env: SANDBOX_ENV,
    persistent: false, // throwaway sandbox, no need to snapshot its filesystem on stop
  });
  log(`${label}: sandbox "${sandbox.name}" ready after ${seconds(Date.now() - runStarted)}`);

  let installMs = 0;
  try {
    for (const repo of REPOS) {
      const dir = `${WORKDIR}/${repo.split('/').pop()}`;
      log(`${label}: cloning ${repo}`);
      await run(sandbox, 'git', ['clone', '--depth', '1', repo, dir]);

      log(`${label}: npm install in ${dir} (cold, nothing cached)`);
      const started = Date.now();
      await run(sandbox, 'npm', ['install', '--loglevel', 'error', '--no-update-notifier', '--no-audit', '--no-fund'], dir);
      installMs += Date.now() - started;
    }
  } catch (error) {
    await stopQuietly(sandbox); // never leave a sandbox running after a failed run
    throw error;
  }
  log(`${label}: npm install took ${seconds(installMs)} in total`);

  await stopQuietly(sandbox);
  const totalMs = Date.now() - runStarted;
  log(`${label}: sandbox stopped, ${seconds(totalMs)} end to end`);
  recordResult({ mode: 'without-drives', size: SIZE, run: runNumber, phase: 'cold', installMs, totalMs, sandbox: sandbox.name });
  return { installMs, totalMs };
}

log(`=== Without Drives (${SIZE}: ${ABOUT}, ${RUNS} runs) ===`);
const timings: Timing[] = [];
for (let i = 1; i <= RUNS; i++) {
  timings.push(await withRetry(`run ${i}`, () => coldRun(i)));
  console.log();
}

log(`Summary for ${SIZE} (no cache survives between sandboxes):`);
timings.forEach((t, i) => log(`  run ${i + 1}: install ${seconds(t.installMs)}, end to end ${seconds(t.totalMs)}`));
log(`  average: install ${seconds(average(timings.map((t) => t.installMs)))}, end to end ${seconds(average(timings.map((t) => t.totalMs)))}`);
log(`results appended to ${RESULTS_FILE}`);
