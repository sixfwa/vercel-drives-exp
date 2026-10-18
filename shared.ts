// Shared bits for the demo scripts: workload sizes, CLI args, retry helpers, and the results CSV.
import { appendFileSync, existsSync } from 'node:fs';
import type { Sandbox } from '@vercel/sandbox';

// Pick a size with: npm run demo:with -- medium
// Each size is a list of distinct public repos to clone and `npm install`. Sizes are the measured
// node_modules on disk after a clean install (sandbox image, 2026-10-15). Tiers nest: large = medium + more.
// Every repo was screened to install cleanly in the sandbox with the SANDBOX_ENV below.
const MEDIUM = [
  'https://github.com/WordPress/gutenberg', // 1.6 GB
  'https://github.com/pixijs/pixijs', // 0.4 GB
];
const LARGE = [
  ...MEDIUM,
  'https://github.com/amplication/amplication', // 2.3 GB
  'https://github.com/documenso/documenso', // 2.2 GB
  'https://github.com/bitwarden/clients', // 1.8 GB
  'https://github.com/jellyfin/jellyfin-web', // 1.1 GB
  'https://github.com/openlayers/openlayers', // 0.3 GB
  'https://github.com/mapbox/mapbox-gl-js', // 0.3 GB
];
// Excluded on purpose: repos whose install compiles or downloads a native binding via prebuild-install /
// node-pre-gyp (canvas, sharp <= 0.32, sqlite3, better-sqlite3, bcrypt via node-libcurl...). Those fail
// under the Drive arm's offline cache and fall back to node-gyp, which the image cannot run (no make).
// e.g. plotly.js, chatbot-ui, bruno, loopback-next, feathers, insomnia, uptime-kuma, maplibre-gl-js.
const MEGA = [
  ...LARGE,
  'https://github.com/BabylonJS/Babylon.js', // 1.2 GB
  'https://github.com/openedx/frontend-app-learning', // 0.95 GB
  'https://github.com/WordPress/wordpress-develop', // 0.8 GB
  'https://github.com/openedx/frontend-app-discussions', // 0.75 GB
  'https://github.com/openstreetmap/iD', // 0.7 GB
  'https://github.com/openedx/frontend-app-account', // 0.7 GB
  'https://github.com/nextcloud/spreed', // 0.7 GB
  'https://github.com/nextcloud/calendar', // 0.65 GB
  'https://github.com/openedx/frontend-app-authn', // 0.6 GB
  'https://github.com/twbs/bootstrap', // 0.55 GB
  'https://github.com/apollographql/apollo-client', // 0.55 GB
  'https://github.com/swagger-api/swagger-ui', // 0.55 GB
  'https://github.com/puppeteer/puppeteer', // 0.45 GB
  'https://github.com/microsoft/playwright', // 0.45 GB
  'https://github.com/mozilla/pdf.js', // 0.3 GB
  'https://github.com/OpenZeppelin/openzeppelin-contracts', // 0.25 GB
];

export const SIZES = {
  small: { repos: ['https://github.com/tj/commander.js'], about: '1 repo, ~0.1 GB of node_modules' },
  medium: { repos: MEDIUM, about: '2 repos, ~2 GB of node_modules' },
  large: { repos: LARGE, about: '8 repos, ~10 GB of node_modules' },
  mega: { repos: MEGA, about: '24 repos, ~20 GB of node_modules' },
} as const;

// Some repos depend on Electron/Puppeteer/Cypress/Playwright, whose postinstall downloads a browser or
// Electron binary that is not an npm package. Skip those downloads in every arm so the timings are npm only.
export const SANDBOX_ENV = {
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  PUPPETEER_SKIP_DOWNLOAD: '1',
  CYPRESS_INSTALL_BINARY: '0',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
};

// Sandbox session timeout. mega installs ~20 GB per run, which takes around 10 minutes cold.
export const SANDBOX_TIMEOUT = 45 * 60 * 1000;

export type Size = keyof typeof SIZES;

// argv[2] = size, argv[3] = number of runs (default 2). Example: npm run demo:with -- large 5
export function pickSize(): Size {
  const arg = process.argv[2] ?? 'large';
  if (!(arg in SIZES)) {
    console.error(`Unknown size "${arg}". Use one of: ${Object.keys(SIZES).join(', ')}`);
    process.exit(1);
  }
  return arg as Size;
}

export function pickRuns(): number {
  const runs = Number(process.argv[3] ?? 2);
  if (!Number.isInteger(runs) || runs < 2) {
    console.error(`Number of runs must be an integer >= 2, got "${process.argv[3]}"`);
    process.exit(1);
  }
  return runs;
}

export function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

export function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The SDK talks to vercel.com over HTTPS for every command. On a multi-hour run the laptop's connection
// will occasionally drop (ECONNRESET, "fetch failed", ...). Those are not sandbox failures, so treat them
// differently from a failing npm install.
export function isTransientNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = error as { code?: string; message?: string; cause?: unknown } | undefined; e && !seen.has(e); e = e.cause as typeof e) {
    seen.add(e);
    if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|socket hang up|UND_ERR|network/i.test(`${e.code ?? ''} ${e.message ?? ''}`)) {
      return true;
    }
  }
  return false;
}

// Stop a sandbox, retrying through network blips. A sandbox left running keeps its drive attached
// read-write, which blocks every later run, so this is worth being stubborn about.
export async function stopQuietly(sandbox: Pick<Sandbox, 'stop' | 'name'>) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await sandbox.stop();
      return;
    } catch (error) {
      log(`could not stop sandbox "${sandbox.name}" (attempt ${attempt}/6): ${(error as Error).message}`);
      await sleep(10_000);
    }
  }
}

// Redo a whole run (fresh sandbox, fresh timing) if it died from a network error. A failed npm install
// is not retried: that is a real result and should surface.
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      log(`${label}: attempt ${attempt} died from a network error (${(error as Error).message}); redoing the run in 30s`);
      await sleep(30_000);
    }
  }
}

// Every timed run is appended as one row to results.csv (header written on first use).
// install_seconds: wall-clock of `npm install` only.
// total_seconds:   end to end, from just before Sandbox.create() until stop() resolves
//                  (includes sandbox boot, drive mount, git clone, install and stop).
export const RESULTS_FILE = 'results.csv';

// phase: cold      = no drive, nothing reused
//        populate  = run 1 of a Drive or Sandbox-snapshot series, builds the thing that is reused
//        snapshot  = fresh sandbox reading a Drive snapshot
//        restore   = fresh sandbox created from a Sandbox snapshot
export function recordResult(row: {
  mode: 'without-drives' | 'with-drives' | 'with-snapshot';
  size: Size;
  run: number;
  phase: 'cold' | 'populate' | 'snapshot' | 'restore';
  installMs: number;
  totalMs: number;
  sandbox: string;
}) {
  if (!existsSync(RESULTS_FILE)) {
    appendFileSync(RESULTS_FILE, 'timestamp,mode,size,run,phase,install_seconds,total_seconds,sandbox\n');
  }
  const line = [
    new Date().toISOString(),
    row.mode,
    row.size,
    row.run,
    row.phase,
    (row.installMs / 1000).toFixed(1),
    (row.totalMs / 1000).toFixed(1),
    row.sandbox,
  ];
  appendFileSync(RESULTS_FILE, line.join(',') + '\n');
}
