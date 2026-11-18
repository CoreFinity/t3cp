# t3cp.io

An independent, community-run performance record of [T3 Code](https://github.com/pingdotgg/t3code): one
benchmark record per upstream nightly, with the performance fork's releases overlaid on the same charts.

t3cp.io is not T3 Code and is not affiliated with it. T3 Code is its owners' brand and copyright.
Run and funded by [Corefinity](https://corefinity.com).

## Layout

| Path | What it holds |
|---|---|
| `catalogue/` | The metric catalogue: ids, units, direction, eras, lanes. The single source for every page. |
| `schema/` | JSON Schemas for the published files (`t3cp/record/1` and the rest). |
| `tools/t3cp/` | The record runner, the allow-list exporter and the merge step. |
| `fixture/` | The public fixture shape and its recipe. |
| `site/` | The static site: templates, stylesheet, script, the aggregator and the build. |
| `news/` | The release-post checker and its prompt. |
| `data/v1/` | The published data, written only by the pipeline. |

## Licences

- Code: MIT (`LICENSE`). Harness code derived from T3 Code keeps its upstream MIT notice.
- Data under `data/`: CC BY 4.0, attribution "t3cp.io" (`data/LICENSE`).
