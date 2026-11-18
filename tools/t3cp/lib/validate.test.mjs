// The in-repo JSON Schema subset validator: types, enum, const, pattern, required, properties,
// additionalProperties, propertyNames, items, sizes, bounds, local $ref, and number finiteness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, assertValid } from "./validate.mjs";

const paths = (errors) => errors.map((e) => e.path);

test("validate: types, including integer, null unions and finiteness", () => {
  assert.deepEqual(validate({ type: "string" }, "x"), []);
  assert.equal(validate({ type: "string" }, 1).length, 1);
  assert.deepEqual(validate({ type: "integer" }, 3), []);
  assert.equal(validate({ type: "integer" }, 3.5).length, 1);
  assert.deepEqual(validate({ type: ["number", "null"] }, null), []);
  assert.deepEqual(validate({ type: ["number", "null"] }, 2.5), []);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(validate({ type: "number" }, bad).length, 1, `non-finite ${bad}`);
    assert.equal(validate({ type: ["number", "null"] }, bad).length, 1, `non-finite ${bad} in a union`);
  }
  assert.equal(validate({ type: "object" }, []).length, 1, "an array is not an object");
  assert.equal(validate({ type: "object" }, null).length, 1, "null is not an object");
  assert.equal(validate({ type: "array" }, {}).length, 1);
  assert.deepEqual(validate({ type: "boolean" }, false), []);
});

test("validate: enum, const, pattern and string lengths", () => {
  assert.deepEqual(validate({ enum: ["a", "b"] }, "a"), []);
  assert.equal(validate({ enum: ["a", "b"] }, "c").length, 1);
  assert.deepEqual(validate({ const: true }, true), []);
  assert.equal(validate({ const: true }, false).length, 1);
  assert.deepEqual(validate({ type: "string", pattern: "^[0-9a-f]{4}$" }, "beef"), []);
  assert.equal(validate({ type: "string", pattern: "^[0-9a-f]{4}$" }, "/mnt").length, 1);
  assert.equal(validate({ type: "string", minLength: 2 }, "a").length, 1);
  assert.equal(validate({ type: "string", maxLength: 2 }, "abc").length, 1);
});

test("validate: numeric bounds", () => {
  assert.deepEqual(validate({ type: "number", minimum: 0, maximum: 10 }, 10), []);
  assert.equal(validate({ type: "number", minimum: 0 }, -1).length, 1);
  assert.equal(validate({ type: "number", maximum: 10 }, 11).length, 1);
});

test("validate: objects with required, properties and additionalProperties false", () => {
  const schema = {
    type: "object",
    required: ["a"],
    additionalProperties: false,
    properties: { a: { type: "string" }, b: { type: "integer" } },
  };
  assert.deepEqual(validate(schema, { a: "x", b: 1 }), []);
  assert.deepEqual(paths(validate(schema, { b: 1 })), ["$"]);
  assert.deepEqual(paths(validate(schema, { a: "x", c: 1 })), ["$.c"]);
  assert.deepEqual(paths(validate(schema, { a: 1 })), ["$.a"]);
});

test("validate: map objects through additionalProperties schemas and propertyNames", () => {
  const schema = {
    type: "object",
    propertyNames: { pattern: "^[a-z]+$" },
    additionalProperties: { type: "number" },
  };
  assert.deepEqual(validate(schema, { a: 1, b: 2 }), []);
  assert.deepEqual(paths(validate(schema, { a: "x" })), ["$.a"]);
  assert.equal(validate(schema, { A1: 1 }).length, 1);
});

test("validate: arrays with items, minItems, maxItems and uniqueItems", () => {
  const schema = { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 3, uniqueItems: true };
  assert.deepEqual(validate(schema, [1, 2]), []);
  assert.deepEqual(paths(validate(schema, [1, "x"])), ["$[1]"]);
  assert.equal(validate(schema, []).length, 1);
  assert.equal(validate(schema, [1, 2, 3, 4]).length, 1);
  assert.equal(validate(schema, [1, 1]).length, 1);
});

test("validate: local $ref into $defs", () => {
  const schema = {
    $defs: { sha: { type: "string", pattern: "^[0-9a-f]{40}$" } },
    type: "object",
    additionalProperties: false,
    properties: { sha: { $ref: "#/$defs/sha" } },
  };
  assert.deepEqual(validate(schema, { sha: "a".repeat(40) }), []);
  assert.deepEqual(paths(validate(schema, { sha: "nope" })), ["$.sha"]);
});

test("validate: a schema keyword outside the supported subset is refused, not ignored", () => {
  assert.throws(() => validate({ type: "string", format: "email" }, "x"), /unsupported schema keyword: format/);
  assert.throws(() => validate({ oneOf: [] }, "x"), /unsupported schema keyword: oneOf/);
  assert.throws(() => validate({ $ref: "other.json#/x" }, "x"), /only local/);
});

test("validate: error messages name the path and rule, never the value", () => {
  const secret = ["/ho", "me/secret"].join("");
  const errors = validate({ type: "string", pattern: "^a$" }, secret);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].message.includes(secret));
});

test("assertValid throws with every error path listed", () => {
  assert.throws(
    () => assertValid({ type: "object", additionalProperties: false, properties: {} }, { x: 1, y: 2 }, "thing"),
    /thing: .*\$\.x.*\$\.y/s,
  );
});
