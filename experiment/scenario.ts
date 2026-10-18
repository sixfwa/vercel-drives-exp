// The real-case scenario: a coding agent picks up a task on one repo. It needs a ready workspace
// (code + node_modules), runs the tests, edits a file, runs them again, and finishes.
//
// Everything below is shared by all arms so that only the way the workspace is persisted differs.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Sandbox } from '@vercel/sandbox';
import { log } from '../shared.js';

export const SCENARIO = {
  repo: 'https://github.com/jellyfin/jellyfin-web', // ~1,770 packages, ~1.1 GB of node_modules
  dir: 'app', // the checkout lives at <workspace>/app
  // Install: identical in every arm.
  install: { cmd: 'npm', args: ['install', '--loglevel', 'error', '--no-update-notifier', '--no-audit', '--no-fund'] },
  // The agent's first command. Time to its first byte of output is "time to useful".
  task: { cmd: 'npx', args: ['vitest', 'run', '--config', 'vite.config.ts'] },
  // The agent's edit: add a test file, then run the task again.
  edit: {
    path: 'src/utils/agent-edit.test.ts',
    content: [
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('agent edit', () => {",
      "  it('runs in the restored workspace', () => {",
      '    expect(1 + 1).toBe(2);',
      '  });',
      '});',
      '',
    ].join('\n'),
  },
  // The "dependency bump" applied in the refresh phase: a real lockfile change, kept tiny on purpose.
  refresh: { cmd: 'npm', args: ['install', '--save-dev', 'is-odd@3.0.1', '--loglevel', 'error', '--no-update-notifier', '--no-audit', '--no-fund'] },
};

export const REGION = 'iad1';

// Persisted between CLI invocations so that later phases (refresh, day2) reuse the same base.
export const STATE_FILE = 'experiment/state.json';
export type State = { snapshotId?: string; driveName?: string; refreshed?: boolean; preparedAt?: string };

export function loadState(): State {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : {};
}

export function saveState(state: State) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// One row per sandbox. Times in seconds, measured from just before Sandbox.create():
//   create_s     SDK reports the sandbox ready (for cold this is before clone+install)
//   ready_s      first byte of output from the task command ("time to useful")
//   task_s       duration of the first task command
//   edit_task_s  duration of the task command after the edit
//   total_s      stop() resolved
//   active_cpu_s billed active CPU reported by the platform after stop, when available
export const RESULTS_FILE = 'experiment/results.csv';
const HEADER = 'timestamp,arm,phase,run,concurrency,create_s,ready_s,task_s,edit_task_s,total_s,active_cpu_s,sandbox,notes\n';

export type Row = {
  arm: string;
  phase: string;
  run: number;
  concurrency: number;
  createMs?: number;
  readyMs?: number;
  taskMs?: number;
  editTaskMs?: number;
  totalMs: number;
  activeCpuMs?: number;
  sandbox: string;
  notes?: string;
};

export function recordRow(row: Row) {
  if (!existsSync(RESULTS_FILE)) appendFileSync(RESULTS_FILE, HEADER);
  const s = (ms?: number) => (ms === undefined ? '' : (ms / 1000).toFixed(1));
  const line = [
    new Date().toISOString(), row.arm, row.phase, row.run, row.concurrency,
    s(row.createMs), s(row.readyMs), s(row.taskMs), s(row.editTaskMs), s(row.totalMs), s(row.activeCpuMs),
    row.sandbox, JSON.stringify(row.notes ?? ''),
  ];
  appendFileSync(RESULTS_FILE, line.join(',') + '\n');
}

// Run a command in the sandbox, streaming output with a label prefix, and report when the first byte arrived.
export async function run(
  sandbox: Sandbox,
  label: string,
  { cmd, args }: { cmd: string; args: string[] },
  opts: { cwd?: string; sudo?: boolean; quiet?: boolean } = {},
): Promise<{ ms: number; firstOutputAt?: number }> {
  const started = Date.now();
  let firstOutputAt: number | undefined;
  const tail: string[] = []; // last lines, shown only if the command fails while quiet
  const { Writable } = await import('node:stream');
  const sink = (target: NodeJS.WritableStream) =>
    new Writable({
      write(chunk, _enc, cb) {
        firstOutputAt ??= Date.now();
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          if (opts.quiet) tail.push(line), tail.length > 25 && tail.shift();
          else target.write(`  [${label}] ${line}\n`);
        }
        cb();
      },
    });
  const result = await sandbox.runCommand({ cmd, args, cwd: opts.cwd, sudo: opts.sudo, stdout: sink(process.stdout), stderr: sink(process.stderr) });
  if (result.exitCode !== 0) {
    throw new Error(`[${label}] "${cmd} ${args.join(' ')}" exited with code ${result.exitCode}${tail.length ? '\n' + tail.join('\n') : ''}`);
  }
  return { ms: Date.now() - started, firstOutputAt };
}

// Clone + install into <workspace>/app. Used by every arm's prepare and by the cold arm's start.
export async function cloneAndInstall(sandbox: Sandbox, label: string, workspace: string, refreshed: boolean) {
  const dir = `${workspace}/${SCENARIO.dir}`;
  log(`${label}: cloning ${SCENARIO.repo}`);
  await run(sandbox, label, { cmd: 'git', args: ['clone', '--depth', '1', SCENARIO.repo, dir] }, { quiet: true });
  log(`${label}: npm install`);
  await run(sandbox, label, SCENARIO.install, { cwd: dir });
  if (refreshed) {
    // The project's lockfile has moved on since the bases were built; cold always installs the latest.
    log(`${label}: applying dependency bump`);
    await run(sandbox, label, SCENARIO.refresh, { cwd: dir });
  }
  return dir;
}
