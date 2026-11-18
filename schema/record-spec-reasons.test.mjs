// Contract 1 (schema/record-spec-1.json) documents every failure reason the runner writes and the raw extras reasons
// the exporter reads: the record deadline (record_timeout, exit 5, deadline_epoch_s and elapsed_s; published as the
// record's status_reason timeout), the deadline refusals and foreign work (exit 3), and the extras' extra_timeout,
// no_setup_span and timed_out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSchema } from "../tools/t3cp/lib/repo.mjs";

const spec = loadSchema("record-spec-1.json");
const prose = JSON.stringify(spec.$defs);

test("Contract 1 documents the record deadline and its public reason", () => {
  for (const word of ["record_timeout", "deadline_epoch_s", "elapsed_s", "T3CP_RECORD_DEADLINE"]) assert.ok(prose.includes(word), word);
  assert.match(prose, /5 [^"]*record_timeout/, "exit code 5 is record_timeout");
  assert.match(prose, /record_timeout[^"]*status_reason timeout/, "merge publishes it as the record's status_reason timeout");
});

test("Contract 1 documents the refusals before any attempt", () => {
  for (const word of ["deadline_missing", "deadline_invalid", "foreign_attempts"]) assert.ok(prose.includes(word), word);
});

test("Contract 1 documents the raw extras reasons and which are public", () => {
  for (const word of ["extra_timeout", "no_setup_span", "timed_out"]) assert.ok(prose.includes(word), word);
  assert.match(prose, /public[^"]*extra_timeout[^"]*no_setup_span|public[^"]*no_setup_span[^"]*extra_timeout/, "names the public extras reasons");
});
