// The four ways a workspace reaches a fresh sandbox. Every arm must deliver the same thing: a sandbox with
// <workspace>/app containing the repo and its node_modules, ready for the agent's task.
import { Drive, Sandbox, Snapshot } from '@vercel/sandbox';
import { SANDBOX_ENV, SANDBOX_TIMEOUT, log, seconds, stopQuietly } from '../shared.js';
import { REGION, SCENARIO, cloneAndInstall, loadState, run, saveState } from './scenario.js';

export type Started = {
  sandbox: Sandbox;
  workspace: string;
  sdkReadyAt: number; // Date.now() when Sandbox.create() resolved
  notes?: string;
  cleanup?: () => Promise<void>; // per-run resources (e.g. a fork) to delete after stop
};

export interface Arm {
  name: string;
  /** Build the reusable base (no-op for cold). Returns a note for the CSV. */
  prepare(): Promise<string>;
  /** Create a sandbox whose workspace is ready to use. For cold this includes clone + install. */
  start(label: string): Promise<Started>;
  /** Apply the dependency bump to the base so later starts see it. Returns a note. */
  refresh(label: string): Promise<string>;
  /** Delete whatever prepare created. */
  teardown(): Promise<void>;
}

const base = { region: REGION, timeout: SANDBOX_TIMEOUT, env: SANDBOX_ENV, persistent: false } as const;
const DRIVE_NAME = 'exp-workspace';
const SNAPSHOT_TTL = 7 * 24 * 60 * 60 * 1000; // long enough for a day-two check

// ---------------------------------------------------------------- cold: nothing persisted
export const cold: Arm = {
  name: 'cold',
  async prepare() {
    return 'nothing to prepare';
  },
  async start(label) {
    const sandbox = await Sandbox.create(base);
    const sdkReadyAt = Date.now();
    try {
      await cloneAndInstall(sandbox, label, '/vercel/work', loadState().refreshed ?? false);
    } catch (error) {
      await stopQuietly(sandbox);
      throw error;
    }
    return { sandbox, workspace: '/vercel/work', sdkReadyAt };
  },
  async refresh() {
    return 'n/a: cold installs the current lockfile every time';
  },
  async teardown() {},
};

// ---------------------------------------------------------------- sandbox snapshot: whole filesystem
async function buildSnapshot(label: string, from?: { snapshotId: string }) {
  const sandbox = await Sandbox.create(from ? { ...base, source: { type: 'snapshot', snapshotId: from.snapshotId } } : base);
  try {
    const dir = from ? `/vercel/work/${SCENARIO.dir}` : await cloneAndInstall(sandbox, label, '/vercel/work', false);
    if (from) {
      log(`${label}: applying dependency bump inside the restored sandbox`);
      await run(sandbox, label, SCENARIO.refresh, { cwd: dir });
    }
  } catch (error) {
    await stopQuietly(sandbox);
    throw error;
  }
  log(`${label}: snapshotting the sandbox (this also stops it)`);
  const t = Date.now();
  const snapshot = await sandbox.snapshot({ expiration: SNAPSHOT_TTL });
  log(`${label}: snapshot ${snapshot.snapshotId} created in ${seconds(Date.now() - t)}, ${(snapshot.sizeBytes / 1e9).toFixed(2)} GB`);
  return snapshot;
}

export const snapshot: Arm = {
  name: 'snapshot',
  async prepare() {
    const snap = await buildSnapshot('snapshot/prepare');
    saveState({ ...loadState(), snapshotId: snap.snapshotId });
    return `snapshot ${snap.snapshotId}, ${(snap.sizeBytes / 1e9).toFixed(2)} GB`;
  },
  async start() {
    const { snapshotId } = loadState();
    if (!snapshotId) throw new Error('snapshot arm has no base; run with --prepare');
    const sandbox = await Sandbox.create({ ...base, source: { type: 'snapshot', snapshotId } });
    return { sandbox, workspace: '/vercel/work', sdkReadyAt: Date.now() };
  },
  async refresh(label) {
    const state = loadState();
    if (!state.snapshotId) throw new Error('snapshot arm has no base; run with --prepare');
    const next = await buildSnapshot(label, { snapshotId: state.snapshotId });
    await Snapshot.get({ snapshotId: state.snapshotId }).then((s) => s.delete()).catch(() => {});
    saveState({ ...loadState(), snapshotId: next.snapshotId });
    return `re-snapshotted as ${next.snapshotId}, ${(next.sizeBytes / 1e9).toFixed(2)} GB`;
  },
  async teardown() {
    const { snapshotId } = loadState();
    if (snapshotId) await Snapshot.get({ snapshotId }).then((s) => s.delete()).catch(() => {});
  },
};

// ---------------------------------------------------------------- drive, read-only: one shared copy
// prepare: clone + install straight onto a Drive mounted read-write at /work.
// start:   mount drive.snapshot() read-only at /work-ro and layer a local overlay at /work so the agent can
//          write (test output, edits, npm temp files) without touching the shared copy.
async function getBaseDrive() {
  return Drive.getOrCreate({ name: DRIVE_NAME, region: REGION });
}

async function populateDrive(label: string, drive: Drive, bumpOnly: boolean) {
  const sandbox = await Sandbox.create({ ...base, mounts: { '/work': drive } });
  try {
    if (bumpOnly) {
      log(`${label}: applying dependency bump on the read-write drive`);
      await run(sandbox, label, SCENARIO.refresh, { cwd: `/work/${SCENARIO.dir}` });
    } else {
      await cloneAndInstall(sandbox, label, '/work', false);
    }
    const du = await sandbox.runCommand({ cmd: 'du', args: ['-sh', '/work'] });
    return (await du.stdout()).trim().split('\t')[0];
  } finally {
    await stopQuietly(sandbox);
  }
}

export const driveRo: Arm = {
  name: 'drive-ro',
  async prepare() {
    const drive = await getBaseDrive();
    const size = await populateDrive('drive-ro/prepare', drive, false);
    saveState({ ...loadState(), driveName: DRIVE_NAME });
    return `drive ${DRIVE_NAME} holds ${size}`;
  },
  async start(label) {
    const drive = await Drive.get({ name: DRIVE_NAME });
    const sandbox = await Sandbox.create({ ...base, mounts: { '/work-ro': drive.snapshot() } });
    const sdkReadyAt = Date.now();
    try {
      await run(sandbox, label, { cmd: 'mkdir', args: ['-p', '/work', '/tmp/work-upper', '/tmp/work-work'] }, { quiet: true });
      await run(sandbox, label, { cmd: 'mount', args: ['-t', 'overlay', 'overlay', '-o', 'lowerdir=/work-ro,upperdir=/tmp/work-upper,workdir=/tmp/work-work', '/work'] }, { sudo: true, quiet: true });
    } catch (error) {
      await stopQuietly(sandbox);
      throw error;
    }
    return { sandbox, workspace: '/work', sdkReadyAt };
  },
  async refresh(label) {
    const drive = await Drive.get({ name: DRIVE_NAME });
    const size = await populateDrive(label, drive, true);
    return `bumped in place on ${DRIVE_NAME}, now ${size}; new snapshot mounts see it`;
  },
  async teardown() {
    await Drive.get({ name: DRIVE_NAME }).then((d) => d.delete()).catch(() => {});
  },
};

// ---------------------------------------------------------------- drive, fork: a writable copy per agent
// Shares the base drive with drive-ro. Each start forks it and mounts the fork read-write at /work.
// Forks are a private-beta feature; if the API refuses, the arm reports that and is skipped.
const FORK_PREFIX = 'exp-fork-';

export const driveFork: Arm = {
  name: 'drive-fork',
  async prepare() {
    const state = loadState();
    if (!state.driveName) {
      const size = await populateDrive('drive-fork/prepare', await getBaseDrive(), false);
      saveState({ ...loadState(), driveName: DRIVE_NAME });
      return `drive ${DRIVE_NAME} holds ${size}`;
    }
    return `shares drive ${DRIVE_NAME} with drive-ro`;
  },
  async start(label) {
    const drive = await Drive.get({ name: DRIVE_NAME });
    const t = Date.now();
    const fork = await drive.fork({ name: `${FORK_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` });
    const forkMs = Date.now() - t;
    log(`${label}: forked ${DRIVE_NAME} as ${fork.name} in ${seconds(forkMs)}`);
    const sandbox = await Sandbox.create({ ...base, mounts: { '/work': fork } });
    return {
      sandbox,
      workspace: '/work',
      sdkReadyAt: Date.now(),
      notes: `fork in ${seconds(forkMs)}`,
      cleanup: () => fork.delete().catch((e: Error) => log(`${label}: could not delete fork ${fork.name}: ${e.message}`)),
    };
  },
  async refresh() {
    return 'n/a: forks inherit the base drive, refreshed by drive-ro';
  },
  async teardown() {
    const forks = await Drive.list({ namePrefix: FORK_PREFIX, sortBy: 'name' });
    for await (const d of forks) await Drive.get({ name: d.name }).then((f) => f.delete()).catch(() => {});
  },
};

export const ARMS: Record<string, Arm> = { cold, snapshot, 'drive-ro': driveRo, 'drive-fork': driveFork };
