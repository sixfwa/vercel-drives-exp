// With Drives: the npm cache lives on a Drive, so a fresh sandbox can reuse it.
import { Drive, Sandbox, type SandboxMounts } from '@vercel/sandbox';
import { SIZES, RESULTS_FILE, SANDBOX_ENV, SANDBOX_TIMEOUT, average, log, pickRuns, pickSize, recordResult, seconds, stopQuietly, withRetry } from './shared.js';

const SIZE = pickSize();
const RUNS = pickRuns();
const { repos: REPOS, about: ABOUT } = SIZES[SIZE];
const REGION = 'iad1'; // drive and sandbox must be in the same region
const WORKDIR = '/vercel/app';
const DRIVE_NAME = `demo-cache-${SIZE}`; // one drive per size so caches don't mix
const CACHE_DIR = '/cache';
const SCRATCH_DIR = '/tmp/cache'; // writable view of the read-only snapshot (see below)

async function run(sandbox: Sandbox, cmd: string, args: string[], cwd?: string, sudo = false) {
  const result = await sandbox.runCommand({ cmd, args, cwd, sudo, stdout: process.stdout, stderr: process.stderr });
  if (result.exitCode !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" exited with code ${result.exitCode}`);
  }
}

type Timing = { installMs: number; totalMs: number };

async function driveRun(runNumber: number, mounts: SandboxMounts, phase: 'populate' | 'snapshot'): Promise<Timing> {
  const label = `run ${runNumber} (${phase === 'populate' ? 'drive read-write' : 'drive snapshot'})`;
  const runStarted = Date.now();

  log(`${label}: creating sandbox in ${REGION} with ${CACHE_DIR} mounted`);
  const sandbox = await Sandbox.create({
    region: REGION,
    timeout: SANDBOX_TIMEOUT,
    env: SANDBOX_ENV,
    persistent: false, // throwaway sandbox, no need to snapshot its filesystem on stop
    mounts,
  });
  log(`${label}: sandbox "${sandbox.name}" ready after ${seconds(Date.now() - runStarted)}`);

  // A snapshot mount is read-only, but npm insists on a writable cache dir for temp files and the
  // odd miss. Layer a local scratch dir on top of it with overlayfs: every hit is read from the
  // drive, anything new stays in the sandbox and is thrown away with it.
  let cacheDir = CACHE_DIR;
  let installMs = 0;
  let diagnosticsMs = 0;
  try {
    if (phase === 'snapshot') {
      log(`${label}: layering a writable scratch dir over the read-only snapshot at ${SCRATCH_DIR}`);
      await run(sandbox, 'mkdir', ['-p', SCRATCH_DIR, `${SCRATCH_DIR}-upper`, `${SCRATCH_DIR}-work`]);
      await run(sandbox, 'mount', ['-t', 'overlay', 'overlay', '-o', `lowerdir=${CACHE_DIR},upperdir=${SCRATCH_DIR}-upper,workdir=${SCRATCH_DIR}-work`, SCRATCH_DIR], undefined, true);
      cacheDir = SCRATCH_DIR;
    }

    // Same npm command in every run; only the cache behind it differs.
    for (const repo of REPOS) {
      const dir = `${WORKDIR}/${repo.split('/').pop()}`;
      log(`${label}: cloning ${repo}`);
      await run(sandbox, 'git', ['clone', '--depth', '1', repo, dir]);

      log(`${label}: npm install --cache ${cacheDir} in ${dir}`);
      const started = Date.now();
      await run(
        sandbox,
        'npm',
        [
          'install',
          '--cache', cacheDir, // tarballs and metadata come from the Drive
          '--prefer-offline', // trust cached metadata, skip registry round-trips on hits (use --offline to forbid them)
          '--logs-dir', '/tmp/npm-logs', // keep npm's debug logs off the (possibly read-only) mount
          '--loglevel', 'error', // hide deprecation/peer warnings so the timing lines stay readable
          '--no-update-notifier',
          '--no-audit',
          '--no-fund',
        ],
        dir,
      );
      installMs += Date.now() - started;
    }
    log(`${label}: npm install took ${seconds(installMs)} in total`);

    // Diagnostics only: excluded from the end-to-end figure so both arms time the same work.
    const diagnosticsStarted = Date.now();
    log(`${label}: size of the drive cache at ${CACHE_DIR}:`);
    await run(sandbox, 'du', ['-sh', CACHE_DIR]);
    if (phase === 'snapshot') {
      log(`${label}: cache misses that had to be written locally:`);
      await run(sandbox, 'du', ['-sh', `${SCRATCH_DIR}-upper`]);
    }
    diagnosticsMs = Date.now() - diagnosticsStarted;
  } catch (error) {
    await stopQuietly(sandbox); // never leave a sandbox running (and the drive attached) after a failed run
    throw error;
  }

  await stopQuietly(sandbox);
  const totalMs = Date.now() - runStarted - diagnosticsMs;
  log(`${label}: sandbox stopped, ${seconds(totalMs)} end to end`);
  recordResult({ mode: 'with-drives', size: SIZE, run: runNumber, phase, installMs, totalMs, sandbox: sandbox.name });
  return { installMs, totalMs };
}

log(`=== With Drives (${SIZE}: ${ABOUT}, ${RUNS} runs) ===`);
const drive = await Drive.getOrCreate({ name: DRIVE_NAME, region: REGION });
log(`drive "${drive.name}" ready in ${drive.region} (created ${drive.createdAt.toISOString()})`);
console.log();

// Run 1: mount the drive read-write and let npm populate the cache on it.
const populate = await withRetry('run 1', () => driveRun(1, { [CACHE_DIR]: drive }, 'populate'));
console.log();

// Runs 2..N: each is a brand-new sandbox mounting a fresh read-only snapshot of the drive.
// The snapshot reflects everything run 1 wrote, so npm finds every package already cached.
const snapshots: Timing[] = [];
for (let i = 2; i <= RUNS; i++) {
  snapshots.push(await withRetry(`run ${i}`, () => driveRun(i, { [CACHE_DIR]: drive.snapshot() }, 'snapshot')));
  console.log();
}

const installAvg = average(snapshots.map((t) => t.installMs));
const totalAvg = average(snapshots.map((t) => t.totalMs));
log(`Comparison for ${SIZE}:`);
log(`  run 1 (populating the drive):      install ${seconds(populate.installMs)}, end to end ${seconds(populate.totalMs)}`);
snapshots.forEach((t, i) => log(`  run ${i + 2} (reading drive snapshot): install ${seconds(t.installMs)}, end to end ${seconds(t.totalMs)}`));
log(`  snapshot average: install ${seconds(installAvg)} (${(populate.installMs / installAvg).toFixed(1)}x vs run 1), end to end ${seconds(totalAvg)}`);
log(`results appended to ${RESULTS_FILE}`);
