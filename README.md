# Vercel Sandbox: with vs. without Drives

Two small scripts that clone public repos and `npm install` them inside Vercel Sandboxes, with and
without a [Drive](https://vercel.com/docs/sandbox/concepts/drives) holding the npm cache.
Pick a size with a `small`, `medium`, `large` or `mega` argument (default `large`):

Sizes are measured `node_modules` on disk after a clean install. Tiers nest: `large` is `medium` plus more
repos, `mega` is `large` plus more. Every repo is a distinct public project that was screened to install cleanly
in the sandbox image.

| Size     | Repos                                                                                                                                                   | `node_modules` | Cold install |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ |
| `small`  | `tj/commander.js`                                                                                                                                       | ~0.1 GB        | ~4s          |
| `medium` | `WordPress/gutenberg`, `pixijs/pixijs`                                                                                                                  | ~2 GB          | ~1.5 min     |
| `large`  | medium + `amplication/amplication`, `documenso/documenso`, `bitwarden/clients`, `jellyfin/jellyfin-web`, `openlayers/openlayers`, `mapbox/mapbox-gl-js` | ~10 GB         | ~5 min       |
| `mega`   | large + 16 more: `BabylonJS/Babylon.js`, four `openedx/frontend-app-*` apps, `WordPress/wordpress-develop`, `openstreetmap/iD`, `nextcloud/spreed`, `nextcloud/calendar`, `twbs/bootstrap`, `apollographql/apollo-client`, `swagger-api/swagger-ui`, `puppeteer/puppeteer`, `microsoft/playwright`, `mozilla/pdf.js`, `OpenZeppelin/openzeppelin-contracts` | ~20 GB | ~10 min |

The timed figure for a multi-repo size is the sum of its installs in one sandbox. All sandboxes get env vars
that stop Electron/Puppeteer/Cypress/Playwright from downloading browser binaries during `npm install`, so the
timings are npm only. Repos whose install compiles or downloads a native binding through `prebuild-install` or
`node-pre-gyp` (`canvas`, old `sharp`, `sqlite3`...) are excluded: they fail under the Drive arm's offline cache
and the image has no `make` to fall back to. The full list with per-repo sizes is in `shared.ts`.

## Setup

```bash
npm install
npx vercel link      # link this folder to a Vercel project (creates .vercel/)
npx vercel env pull  # writes VERCEL_OIDC_TOKEN to .env.local
```

The npm scripts load `.env.local` with `--env-file`, so `VERCEL_OIDC_TOKEN` is all the SDK needs.
OIDC tokens are short-lived (about 12 hours); rerun `npx vercel env pull` before the demo if you see an auth error.

## Scripts

| Command                                   | What it does                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run demo:without -- <size> [runs]`   | `runs` fresh sandboxes (default 2), each produces the data cold. Every run takes the full time.                              |
| `npm run demo:with -- <size> [runs]`      | Run 1 mounts the `demo-cache-<size>` drive read-write at `/cache` and populates it. Runs 2..N each mount `drive.snapshot()`. |
| `npm run demo:snapshot -- <size> [runs]`  | Run 1 installs cold, then `sandbox.snapshot()`s the whole filesystem. Runs 2..N are created from that snapshot, so `node_modules` is already there. The snapshot is deleted at the end. |
| `npm run demo:all`                        | Runs all three scripts for every size with 5 runs each (60 sandboxes, roughly 3 hours; `large` and `mega` are most of it).  |
| `npm run cleanup`                         | Deletes all `demo-cache-*` drives. (Sandbox snapshots delete themselves at the end of `demo:snapshot`, and expire after 24h if that is skipped.) |

Examples: `npm run demo:with -- small`, `npm run demo:without -- medium 5`, `npm run demo:snapshot -- large 3`.

### Drives vs. Sandbox snapshots

The two "with" scripts reuse different things. `demo:with` reuses npm's **download cache** on a Drive: a shared
directory any number of sandboxes can read; the install still has to extract and link every package.
`demo:snapshot` reuses the **whole filesystem** via a Sandbox snapshot: each new sandbox gets its own copy with
`node_modules` already in place, so the install is a no-op, but the snapshot is a frozen copy that goes stale when
the lockfile changes and expires after 30 days by default.

[`FINDINGS.md`](./FINDINGS.md) has the write-up: Part 1 is the real-case experiment in `experiment/`
(data in `experiment/results.csv`), Part 2 condenses the earlier strategy comparison run with the scripts above.
[`FINDINGS-SIMPLIFIED.md`](./FINDINGS-SIMPLIFIED.md) is the plain-language version. Two early precursor series
are kept as `results-2026-10-14*.csv`.

## The real-case experiment (`experiment/`)

The scripts above compare *strategies* (cache the downloads vs. snapshot the install). The experiment in
`experiment/` compares the *products* on equal terms: every arm delivers the same finished workspace
(`jellyfin/jellyfin-web` cloned and installed, ~1.1 GB) to a fresh sandbox, and the sandbox then does what a
coding agent does: run the tests, edit a file, run them again, stop.

| Arm | How the workspace reaches the sandbox |
| --- | --- |
| `cold` | clone + `npm install` every time (baseline) |
| `snapshot` | restored from a Sandbox snapshot taken after the install |
| `drive-ro` | repo + `node_modules` live on a Drive; each sandbox mounts `drive.snapshot()` read-only with a local overlay for writes |
| `drive-fork` | each sandbox gets its own `drive.fork()` of that Drive, mounted read-write (private beta; skipped if unavailable) |

Phases, each appending to `experiment/results.csv`:

```bash
npm run exp:sequential              # 5 runs per arm, one at a time (builds the bases on first use)
npm run exp:concurrent              # 10 sandboxes per arm started at once
npm run exp:refresh                 # bump a dependency, rebuild each base, 1 run per arm
npm run exp:day2                    # next morning: 1 run per arm against yesterday's bases
npm run exp:all                     # sequential + concurrent + refresh
npm run exp:teardown                # delete the snapshot, drive, forks and experiment/state.json
```

Options: `-- --arms cold,snapshot`, `-- --runs N`, `-- --prepare` (force rebuilding the bases).

Per sandbox the CSV records `create_s` (SDK says ready), `ready_s` (first byte of test output, "time to
useful"), `task_s`, `edit_task_s`, `total_s` (create → stop), `active_cpu_s` (billed CPU as reported by the
platform), plus `concurrency` and `phase`. Base builds and refreshes are rows with `run=0`.

## Results CSV (demo scripts)

Every timed run is appended to `results.csv`:

```csv
timestamp,mode,size,run,phase,install_seconds,total_seconds,sandbox
2026-10-14T09:00:00.000Z,without-drives,small,1,cold,3.4,8.1,amber-forthcoming-flea-BC5Pf2
2026-10-14T09:01:00.000Z,with-drives,small,1,populate,3.1,10.2,plum-upper-partridge-Q4toMo
2026-10-14T09:01:20.000Z,with-drives,small,2,snapshot,2.0,9.7,aquamarine-sharp-slug-zKJ1Gv
```

- `mode` is `without-drives`, `with-drives` or `with-snapshot`.
- `phase` is `cold` (no drive), `populate` (run 1: drive mounted read-write, or install + sandbox snapshot),
  `snapshot` (fresh sandbox reading a drive snapshot) or `restore` (fresh sandbox created from a sandbox snapshot).
- `install_seconds` is `npm install` only. `total_seconds` is end to end: from just before `Sandbox.create()` until
  `stop()` resolves, so it includes sandbox boot, drive mount, `git clone`, the install and the stop.
  The logs also print how long create → ready took, which is where the mount cost shows up.

Delete the file to start a new series.

## Demo notes

- Run `npm run cleanup` before `npm run demo:with` so run 1 really starts from an empty cache.
- Each size uses its own drive (`demo-cache-small`, `-medium`, `-large`) so a small-repo cache never warms a bigger run.
- Drive and sandbox are both pinned to `iad1`; a sandbox can only mount drives in its own region.
- `drive.snapshot()` only works after the drive has been written to at least once; run 1 handles that.
- Only one sandbox can mount a drive read-write at a time. Snapshots can be mounted by many sandboxes concurrently.
- Snapshot runs layer a local overlayfs scratch dir over the read-only `/cache` (`/tmp/cache`), because npm needs a
  writable cache dir for temp files and the occasional miss. Hits are read from the drive; the script prints how much
  had to be written locally (typically a few MB).
