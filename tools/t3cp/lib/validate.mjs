// A small JSON Schema validator for the subset the t3cp schemas use. No dependencies.
//
// Supported keywords: type (string or list; "integer" and "number" reject NaN and infinities),
// enum, const, pattern, minLength, maxLength, minimum, maximum, required, properties,
// additionalProperties (false or a schema), propertyNames, items, minItems, maxItems, uniqueItems,
// and $ref to "#/$defs/<name>" in the root schema. Annotations ($schema, $id, $comment, title,
// description, $defs) are ignored. Any other keyword throws: a schema that relies on something
// this validator does not check must fail loudly, never pass silently.
//
// Error messages name the JSON path and the rule, never the offending value, so a refused
// record never copies a private string into a log.

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "$defs", "examples"]);
const KEYWORDS = new Set([
  "type", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "required",
  "properties", "additionalProperties", "propertyNames", "items", "minItems", "maxItems",
  "uniqueItems", "$ref",
]);

const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const matchesType = (type, value) => {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "object":
      return typeOf(value) === "object";
    case "array":
      return Array.isArray(value);
    default:
      throw new Error(`unsupported schema type: ${type}`);
  }
};

const childPath = (path, key) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );

const patternCache = new Map();
const compile = (source) => {
  let re = patternCache.get(source);
  if (re === undefined) {
    re = new RegExp(source, "u");
    patternCache.set(source, re);
  }
  return re;
};

function resolveRef(root, ref) {
  const match = /^#\/\$defs\/([A-Za-z0-9_.-]+)$/.exec(ref);
  if (match === null) throw new Error(`$ref ${ref}: only local "#/$defs/<name>" references are supported`);
  const target = root.$defs?.[match[1]];
  if (target === undefined) throw new Error(`$ref ${ref}: no such definition`);
  return target;
}

function check(schema, value, path, root, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: "not allowed here" });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported schema keyword: ${key}`);
  }
  if (schema.$ref !== undefined) {
    check(resolveRef(root, schema.$ref), value, path, root, errors);
    return;
  }

  // Numbers that are not finite are never valid, whatever the schema says.
  if (typeof value === "number" && !Number.isFinite(value)) {
    errors.push({ path, message: "number is not finite" });
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      errors.push({ path, message: `expected ${types.join(" or ")}, got ${typeOf(value)}` });
      return;
    }
  }
  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) {
    errors.push({ path, message: "does not equal the required constant" });
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => canonical(option) === canonical(value))) {
    errors.push({ path, message: "not one of the allowed values" });
  }

  if (typeof value === "string") {
    if (schema.pattern !== undefined && !compile(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match pattern ${schema.pattern}` });
    }
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push({ path, message: `shorter than ${schema.minLength}` });
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push({ path, message: `longer than ${schema.maxLength}` });
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `below the minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `above the maximum ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `fewer than ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `more than ${schema.maxItems} items` });
    if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) {
      errors.push({ path, message: "items are not unique" });
    }
    if (schema.items !== undefined) value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, root, errors));
  }

  if (typeOf(value) === "object") {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path, message: `missing required property ${JSON.stringify(key)}` });
    }
    const properties = schema.properties ?? {};
    for (const [key, inner] of Object.entries(value)) {
      const at = childPath(path, key);
      if (schema.propertyNames !== undefined) {
        const before = errors.length;
        check(schema.propertyNames, key, at, root, errors);
        if (errors.length > before) {
          errors.splice(before, errors.length - before, { path: at, message: "property name not allowed" });
          continue;
        }
      }
      if (Object.hasOwn(properties, key)) check(properties[key], inner, at, root, errors);
      else if (schema.additionalProperties === false) errors.push({ path: at, message: "unknown property" });
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        check(schema.additionalProperties, inner, at, root, errors);
      }
    }
  }
}

/** Validates `value` against `schema`; returns a list of {path, message}, empty when valid. */
export function validate(schema, value, root = schema) {
  const errors = [];
  check(schema, value, "$", root, errors);
  return errors;
}

/** Throws an Error listing every problem (path and rule, never the value) when `value` is invalid. */
export function assertValid(schema, value, what = "value") {
  const errors = validate(schema, value);
  if (errors.length > 0) {
    const lines = errors.slice(0, 50).map((e) => `  ${e.path}: ${e.message}`);
    if (errors.length > 50) lines.push(`  ... and ${errors.length - 50} more`);
    const error = new Error(`${what}: schema validation failed:\n${lines.join("\n")}`);
    error.errors = errors;
    throw error;
  }
}
