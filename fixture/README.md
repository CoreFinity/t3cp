# The public large fixture

Every t3cp.io record boots T3 Code's server on the same large synthetic database, so that start-up, migration
and load numbers are measured on a realistic history rather than an empty one. The database is generated from a
hand-written shape with round numbers. It is not measured from, or derived from, anyone's real data.

The shape writes through the server's own code, and a server cannot safely open a database from a newer
schema. So each schema era in the series has its own fixture, built from the same shape and seed by the fixture
tool ported to that era's tree:

| Fixture | Serves nightlies | Built at migration | Builder (tree) |
|---|---|---|---|
| `large-63-v1` | 2026-10-17 to 2026-10-30 (heads 63 to 74) | 63 | tag `t3cp-fixture/large-63-v1`: the 2026-10-17 nightly's tree `13aa882c22d5` plus the fixture tool |
| `large-76-v1` | 2026-10-31 onward (heads 76 to 95 and later) | 76 | tag `t3cp-fixture/large-76-v1`: the 2026-10-31 nightly's tree `54c5f2524996` plus the fixture tool |

Each record copies its era's fixture and lets the nightly under test migrate it forward on first boot. That
migration is measured too.

## Files

| File | What it is |
|---|---|
| `public-large.shape.json` | The input shape (`t3-server-bench-shape` v1), hand-written, the same for both fixtures. |
| `large-63-v1.shape.json`, `large-76-v1.shape.json` | Each built fixture measured with `fixture.ts shape`: counts and sizes only, no content. |
| `fixtures.json` | One entry per fixture: era, migration, file names, byte sizes, sha256, the recipe and its flags. |
| `SHA256SUMS` | `sha256sum` lines for every file above and for each `.sqlite` and `.sqlite.zst`. |
| `SIZES` | `<bytes>  <name>` for the same files. |

The databases themselves are at `https://files.t3cp.io/fixtures/<fixture>.sqlite.zst`. Decompress them with
`zstd -d --long=31` (they were compressed with `zstd -19 --long=31`, a 2 GiB window), then check the result
against `SHA256SUMS`.

## The recipe

Both fixtures come from the same command, run on their builder tag from the public fork
(`https://github.com/navidnadali/t3code`). Building needs Node 26.12.1 (SQLite 3.54.0):

```sh
git clone https://github.com/navidnadali/t3code.git && cd t3code
git checkout t3cp-fixture/large-76-v1        # or t3cp-fixture/large-63-v1
npx pnpm@"$(node -p 'require("./package.json").packageManager.split("@")[1]')" install --frozen-lockfile
node tools/server-bench/fixture-public.ts build \
  --shape <path to this repository>/fixture/public-large.shape.json --out large-76-v1.sqlite
```

`fixture-public.ts build` accepts only `fixture/public-large.shape.json` with the public label and round
numbers, and it exits 2 before writing anything otherwise. It then runs exactly these two commands and prints
the sha256, the size and the migration head:

```sh
node tools/server-bench/fixture.ts synth --like fixture/public-large.shape.json --scale 1 --seed 20261017 \
  --now 2026-10-17T00:00:00Z --workspace-root /t3-bench-synthetic large-76-v1.sqlite
node tools/server-bench/fixture.ts scan --keep-content large-76-v1.sqlite
```

`synth` plans every row from the shape with a fixed-seed generator and writes it through the server's event
sink and projections on a database created by the server's own migrations. It then compacts the result with
`VACUUM INTO`. Generated text comes from a fixed word list. The same shape, seed and flags give the same bytes
on any machine with Node 26.12.1 (SQLite 3.54.0). The file header records the SQLite that wrote it, so another
SQLite gives other bytes (Node 26.13.1's SQLite 3.54.1 differs in one header byte), and `fixture-public.ts
build` refuses to run under any SQLite but 3.54.0. This pin is for building a fixture only. Reading one is not
tied to it: each record boots the nightly's own server, which opens the copy with whatever Node and SQLite that
release ships and migrates it forward on first boot.

`scan --keep-content` exits 1 unless the database holds no credential-shaped string and no work a server would
start on boot. `--keep-content` is right for generated text. Plain `scan` expects the blank filler of a
sanitised copy, so it rejects every synthetic database.

## The shape

The shape gives a long-history workload in round numbers:

- 50 projects and 3,000 threads: 2,000 roots, 300 forks, 500 subagent children with runs, 100 run-less
  children and 100 imported v1 threads;
- 60,000 runs, 62,000 attempts and 800,000 execution nodes;
- 1,800,000 turn items, spread over threads with a long tail (median about 30, 90th percentile about 300, 99th
  percentile about 5,000, largest about 100,000), so a handful of threads are very large;
- an item mix of 10 % user messages, 20 % assistant messages, 15 % reasoning, 25 % commands, 10 % file changes,
  about 8 % each of tools and checkpoints, and 4 % other kinds;
- about 4.7 million events: one per entity, plus earlier in-progress updates for a share of the turn items,
  messages, nodes and runs.

The counts were tuned, within round numbers, until each fixture landed between 24 and 28 GB after
`VACUUM INTO`. The measured counts and sizes of each built fixture are in its `.shape.json`.

## Checked

| Fixture | `.sqlite` bytes | `.sqlite.zst` bytes | First boot |
|---|---:|---:|---|
| `large-63-v1` | 26,358,898,688 | 932,922,503 | the 2026-10-17 nightly runs no migration; the 2026-10-30 nightly runs migrations 64 to 74; neither writes an event |
| `large-76-v1` | 26,917,883,904 | 1,095,865,981 | the 2026-10-31 nightly runs no migration; the 2026-11-15 nightly runs migrations 77 to 95; neither writes an event |

Both pass `scan --keep-content`. A copy with one planted token-shaped string fails it. Built with Node 26.12.1
(SQLite 3.54.0), the recipe gives the same bytes on macOS (arm64) and Linux (x64).

## Booting a fixture

Boot it with its own `--base-dir` and `HOME`. Set `"enableProviderUpdateChecks": false`,
`"sidebarAutoSettleAfterDays": null` and `"sidebarAutoSettleOnMerge": false` in
`<base-dir>/userdata/settings.json`, and `T3CODE_TELEMETRY_ENABLED=false`. A first boot writes no event. A newer
server runs its newer migrations and may add the prune mark and its derived count rows, but it writes no event.
