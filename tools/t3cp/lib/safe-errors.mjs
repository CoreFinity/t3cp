// The only door from news/ and site/build/ to the validator (validate.mjs) and the strict JSON parser (json.mjs):
// their errors carry the checked document's keys in their paths, so everything here returns text that never names
// a key or a value from the document, for anything that prints it (a terminal, a CI log, a refusal message).
//   Schema errors: a path keeps only the schema's own property names and array indices; every key the validator
//   wrote in brackets ($["…"]), and every other unknown name, reads <key>; a path that does not start at $ reads
//   <path>. The validator's messages never carry a value.
//   JSON errors: "not valid JSON (<kind>, offset <n>)", the kind from the strict parser's fixed list, never its path.
// news/safe-imports.test.mjs fails when any other file in news/ or site/build/ imports validate.mjs or json.mjs.

import { readFileSync } from 'node:fs';
import { parseStrict } from './json.mjs';
import { validate } from './validate.mjs';

const KEYS = new WeakMap();

/** Every property name the schema defines, at any depth ($defs, items, oneOf and the like included). */
export function schemaKeys(schema) {
  if (schema && typeof schema === 'object' && KEYS.has(schema)) return KEYS.get(schema);
  const keys = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.properties && typeof v.properties === 'object' && !Array.isArray(v.properties)) for (const k of Object.keys(v.properties)) keys.add(k);
      Object.values(v).forEach(walk);
    }
  };
  walk(schema);
  if (schema && typeof schema === 'object') KEYS.set(schema, keys);
  return keys;
}

/** A validator path reduced to the schema's own property names and array indices. */
export function safePath(p, keys) {
  const masked = String(p).replace(/\["(?:[^"\\]|\\.)*"\]/g, '.<key>');
  const segs = masked.split('.');
  if (segs[0] !== '$' && !/^\$(?:\[\d+\])+$/.test(segs[0])) return '<path>';
  return segs.map((seg, i) => {
    if (i === 0 || seg === '<key>') return seg;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\d+\])*)$/.exec(seg);
    return m && keys.has(m[1]) ? seg : '<key>';
  }).join('.');
}

/** The first n errors as "path message" pairs with safe paths, and how many more there are. */
export function formatSafeErrors(errors, schema, n = 5, sep = ' ') {
  const keys = schemaKeys(schema);
  const shown = errors.slice(0, n).map((e) => `${safePath(e.path, keys)}${sep}${e.message}`).join('; ');
  return `${shown}${errors.length > n ? ` (and ${errors.length - n} more)` : ''}`;
}

/** The schema's errors for a value, each with a safe path: [{path, message}]. */
export function schemaErrors(schema, value) {
  const keys = schemaKeys(schema);
  return validate(schema, value).map((e) => ({ path: safePath(e.path, keys), message: e.message }));
}

/** The schema's errors for a value as "path<sep>message" lines (safe paths). */
export const schemaErrorLines = (schema, value, sep = ' ') => schemaErrors(schema, value).map((e) => `${e.path}${sep}${e.message}`);

// The strict parser's error kinds (json.mjs): its message is "<kind> at <path> (offset <n>)".
const JSON_KINDS = new Set(['unterminated string', 'control character in a string', 'bad unicode escape', 'bad escape', 'nesting too deep',
  'expected a key', 'key not allowed', 'duplicate key', "expected ':'", "expected ',' or '}'", "expected ',' or ']'", 'unexpected character',
  'bad number', 'trailing content']);

/** A strict-JSON error as "not valid JSON (<kind>, offset <n>)": never the path (it names the document's keys). */
export function jsonErrorText(error) {
  const msg = String(error?.message ?? '');
  const at = msg.indexOf(' at ');
  const kind = at > 0 && JSON_KINDS.has(msg.slice(0, at)) ? msg.slice(0, at) : null;
  const off = /\(offset (\d+)\)$/.exec(msg);
  if (kind && off) return `not valid JSON (${kind}, offset ${off[1]})`;
  if (off) return `not valid JSON (offset ${off[1]})`;
  return 'not valid JSON';
}

/** The strict parser (json.mjs parseStrict): the value, or an Error whose message is jsonErrorText's. */
export function parseJsonStrict(text) {
  try {
    return parseStrict(text);
  } catch (error) {
    throw new Error(jsonErrorText(error));
  }
}

/**
 * A JSON input of a command line (a post, a bundle, a source file). A failure names the input and, for bad JSON,
 * the offset of the first error only: never the file's text, a key or a path in it.
 */
export function readJsonInput(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${what} cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    let at = null;
    try { parseStrict(text); } catch (e) { const m = /\(offset (\d+)\)$/.exec(String(e?.message)); if (m) at = Number(m[1]); }
    throw new Error(`${what} is not valid JSON${at === null ? '' : ` (offset ${at})`}`);
  }
}
