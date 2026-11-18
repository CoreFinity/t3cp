// The site-output schemas' fields that live outside the VM's exporter closure. export.mjs and merge.mjs never import
// this module, so a change here moves no image pin (tools/t3cp/image-pin.json); lib/schemas.mjs is in the closure.
// buildAllSchemas() is lib/schemas.mjs's buildSchemas() with these fields added: it is what
// tools/t3cp/dev/build-schemas.mjs writes and schema/schemas.test.mjs checks. The fields here are the compare page's
// rule inputs (final review M4): the browser judges two records with the aggregator's own capability and gates.
import { buildSchemas, PLATFORM_IDS, SERIES_LEVELS } from "./schemas.mjs";

/** The schema files this module extends; every other file is exactly lib/schemas.mjs's. */
export const SITE_EXTENDED = ["index-1.json", "records-index-1.json", "series-1.json", "compare-1.json"];

/** capability()'s notes: the reasons a metric has no verdict at a level whatever the pair. */
export const CAP_NOTES = ["context", "no_band", "wide_band"];
/** The validity gates' result at a level (see records-index-1.json's gates). */
export const GATE_STATES = ["pass", "client", "fail"];

const capLevel = {
  type: "object",
  additionalProperties: false,
  required: ["threshold", "note"],
  properties: {
    threshold: { type: ["number", "null"], description: "The verdict threshold in percent (the band plus 5 points); null where the metric has none." },
    note: { type: ["string", "null"], enum: [...CAP_NOTES, null], description: "Why no comparison at this level has a verdict, whatever the pair; null when one can." },
  },
};

const catalogueFields = {
  cap: {
    type: "object",
    additionalProperties: false,
    required: PLATFORM_IDS,
    description:
      "Per platform and per level the metric has, the aggregator's capability: the threshold a comparison uses and the note that stops every verdict there (context, no_band, wide_band), a level's own band overriding the metric's. A counter needs no band: threshold and note are null. A pair also loses its band when either record is not banded (records-index.json): then a non-counter has threshold null and note no_band, unless a note here applies. These rule inputs serve the compare page's nightly pairs; a fork release's verdicts come through the aggregator's own compare files.",
    properties: Object.fromEntries(
      PLATFORM_IDS.map((p) => [p, { type: "object", additionalProperties: false, properties: Object.fromEntries(SERIES_LEVELS.map((L) => [L, capLevel])) }]),
    ),
  },
  gate_exempt: {
    type: "boolean",
    description: "true for the client-call gate's own metrics (client errors, unfinished calls): a level whose gates are client still judges them.",
  },
  throughput: {
    type: "boolean",
    description: "true for the measures a saturated level keeps a verdict on (turns completed, agents served); every other metric there is context.",
  },
};

const gates = {
  type: "object",
  additionalProperties: false,
  required: ["once"],
  description:
    "Per level, the validity gates' result: pass (every metric there passes), client (the cell had client errors or unfinished calls: only the gate_exempt metrics pass), fail (no metric passes: the CPU is not the platform's pinned model, the cell has a contaminated valid attempt, or there is no cell). once is the CPU pin alone; a once-per-record metric reads once at either of its levels (once and 1e). The keys are segment's. A missing key fails. Published for nightlies, the records this file lists; a fork release's verdicts come through the aggregator's own compare files.",
  properties: Object.fromEntries(SERIES_LEVELS.map((L) => [L, { type: "string", enum: GATE_STATES }])),
};

/** A copy of an obj() schema with properties added (and required). */
const withProps = (schema, props) => ({ ...schema, required: [...schema.required, ...Object.keys(props)], properties: { ...schema.properties, ...props } });

export function buildAllSchemas(catalogue) {
  const schemas = buildSchemas(catalogue);
  const index = schemas["index-1.json"];
  const items = index.properties.catalogue.items;
  schemas["index-1.json"] = { ...index, properties: { ...index.properties, catalogue: { ...index.properties.catalogue, items: withProps(items, catalogueFields) } } };
  const ri = schemas["records-index-1.json"];
  const entry = ri.properties.records.items;
  const platforms = entry.properties.platforms;
  schemas["records-index-1.json"] = {
    ...ri,
    properties: {
      ...ri.properties,
      records: {
        ...ri.properties.records,
        items: {
          ...entry,
          properties: {
            ...entry.properties,
            platforms: { ...platforms, properties: Object.fromEntries(Object.entries(platforms.properties).map(([p, rec]) => [p, withProps(rec, { gates })])) },
          },
        },
      },
    },
  };
  return withForkHeads(schemas);
}

// The nightly fork-head records (fork-nightly/<platform>/<date>.<tag>.json: the fork's latest release measured on the
// night of an upstream nightly, paired with it). Every key here is optional and appears only when such records exist.
function withForkHeads(schemas) {
  const series = schemas["series-1.json"], forkTag = series.$defs.fork_tag.pattern, fork = series.properties.fork, fl = series.$defs.fork_level;
  schemas["series-1.json"] = {
    ...series,
    properties: {
      ...series.properties,
      fork: {
        ...fork,
        properties: {
          ...fork.properties,
          head_tags: {
            type: "array",
            items: { type: ["string", "null"], pattern: forkTag },
            description: "Aligned with dates: the fork release measured on that night (a fork-head record), null where none was; present only when the platform has fork-head records.",
          },
        },
      },
    },
    $defs: {
      ...series.$defs,
      fork_level: {
        ...fl,
        properties: {
          ...fl.properties,
          head_note: {
            type: "array",
            items: { $ref: "#/$defs/note" },
            description: "Aligned with dates: on a fork-head night without a value at this level, why (hollow: no valid attempt; saturated: not measured; no_data: not run); null elsewhere. With fork-head records, step is the measured value on their nights and the held release value on the others.",
          },
        },
      },
    },
  };
  const ri = schemas["records-index-1.json"];
  const headRecord = {
    type: "object",
    additionalProperties: false,
    required: ["record_id", "status", "path"],
    properties: {
      record_id: { $ref: "#/$defs/record_id" },
      status: { type: "string", enum: ["complete", "partial", "missing"] },
      path: { type: "string", pattern: "^fork-nightly/(linux-x64|darwin-arm64)/20\\d{2}-\\d{2}-\\d{2}\\.v[0-9A-Za-z.-]+\\.json$" },
    },
  };
  schemas["records-index-1.json"] = {
    ...ri,
    properties: {
      ...ri.properties,
      fork_heads: {
        type: "array",
        description: "The nightly fork-head records, by night: the fork release measured that night (tag, sha) and the upstream nightly it was paired with (paired_tag); present only when there are any.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["date", "tag", "sha", "paired_tag", "platforms"],
          properties: {
            date: { $ref: "#/$defs/date" },
            tag: { type: "string", pattern: forkTag },
            sha: { $ref: "#/$defs/sha" },
            paired_tag: { $ref: "#/$defs/nightly_tag" },
            platforms: { type: "object", additionalProperties: false, properties: Object.fromEntries(PLATFORM_IDS.map((p) => [p, headRecord])) },
          },
        },
      },
    },
  };
  const compare = schemas["compare-1.json"];
  schemas["compare-1.json"] = {
    ...compare,
    properties: { ...compare.properties, kind: { ...compare.properties.kind, enum: [...compare.properties.kind.enum, "fork-head-vs-nightly"] } },
  };
  return schemas;
}
