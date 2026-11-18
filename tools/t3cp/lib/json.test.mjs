// The strict JSON parser every t3cp reader uses: duplicate keys and prototype keys are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrict, JsonError } from "./json.mjs";

test("json: parses what JSON.parse parses, to the same value", () => {
  for (const text of ['{"a":1,"b":[1,2.5,-3e2,true,false,null],"c":{"d":"x\\u00e9\\n"}}', "[]", '"s"', "0", "-0.5", " \n{ } "]) {
    assert.deepEqual(parseStrict(text), JSON.parse(text), text);
  }
  assert.equal(parseStrict("1e999"), Number.POSITIVE_INFINITY, "out-of-range numbers parse; finiteness is the caller's check");
});

test("json: a duplicate key anywhere is refused, naming the path, never the value", () => {
  assert.throws(() => parseStrict('{"a":1,"a":2}'), (e) => e instanceof JsonError && /duplicate key/.test(e.message) && /\$/.test(e.message));
  assert.throws(() => parseStrict('{"x":{"ref":"ok","ref":"secret-value"}}'), (e) => e instanceof JsonError && !e.message.includes("secret-value"));
  assert.throws(() => parseStrict('[{"k":1},{"k":1,"k":1}]'), JsonError);
});

test("json: prototype keys are refused", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.throws(() => parseStrict(`{"${key}":{"x":1}}`), (e) => e instanceof JsonError && /key not allowed/.test(e.message), key);
  }
});

test("json: malformed text and trailing content are refused", () => {
  for (const text of ["{", '{"a":}', "[1,]", '{"a":1} x', "NaN", "'a'", '{"a":01}', ""]) {
    assert.throws(() => parseStrict(text), JsonError, JSON.stringify(text));
  }
});
