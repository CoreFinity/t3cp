// The one JSON parser every t3cp reader uses (exporter, merge, bands, aggregator). It accepts exactly RFC 8259
// JSON and refuses what JSON.parse silently allows: a duplicate key (the last one would win, so a second
// "contaminated" or a second identity field could replace the first after it was checked), and the keys
// __proto__, constructor and prototype. Errors name a JSON path, never a value.

export class JsonError extends Error {}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

const childPath = (path, key) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key).slice(0, 64)}]`);

/** Parses JSON text strictly. Throws JsonError on malformed text, a duplicate key or a prototype key. */
export function parseStrict(text) {
  const s = String(text);
  let i = 0;
  const fail = (what, path) => {
    throw new JsonError(`${what} at ${path} (offset ${i})`);
  };
  const skip = () => {
    while (i < s.length && WS.has(s[i])) i++;
  };
  const string = (path) => {
    // s[i] is the opening quote
    i++;
    let out = "";
    let start = i;
    for (;;) {
      if (i >= s.length) fail("unterminated string", path);
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        out += s.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) fail("control character in a string", path);
      if (c === 0x5c) {
        out += s.slice(start, i);
        const e = s[i + 1];
        if (e === "u") {
          const hex = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad unicode escape", path);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
        } else if (Object.hasOwn(ESCAPES, e)) {
          out += ESCAPES[e];
          i += 2;
        } else fail("bad escape", path);
        start = i;
        continue;
      }
      i++;
    }
  };
  const value = (path, depth) => {
    if (depth > 512) fail("nesting too deep", path);
    skip();
    const c = s[i];
    if (c === "{") {
      i++;
      const obj = {};
      const seen = new Set();
      skip();
      if (s[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skip();
        if (s[i] !== '"') fail("expected a key", path);
        const key = string(path);
        const at = childPath(path, key);
        if (FORBIDDEN_KEYS.has(key)) fail("key not allowed", at);
        if (seen.has(key)) fail("duplicate key", at);
        seen.add(key);
        skip();
        if (s[i] !== ":") fail("expected ':'", at);
        i++;
        obj[key] = value(at, depth + 1);
        skip();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'", path);
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      skip();
      if (s[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(`${path}[${arr.length}]`, depth + 1));
        skip();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'", path);
      }
    }
    if (c === '"') return string(path);
    if (s.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (s.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (s.startsWith("null", i)) {
      i += 4;
      return null;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (m === null || m[0].length === 0) fail("unexpected character", path);
    i += m[0].length;
    if (/^[0-9.eE+-]$/.test(s[i] ?? "")) fail("bad number", path);
    return Number(m[0]);
  };
  const result = value("$", 0);
  skip();
  if (i !== s.length) fail("trailing content", "$");
  return result;
}

/**
 * Parses newline-delimited JSON strictly. An unparseable FINAL line (a torn write by a killed sampler) is
 * dropped; any other unparseable line throws, naming its line number.
 */
export function parseNdjsonStrict(text, what = "ndjson") {
  const lines = String(text).split("\n");
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
  const out = [];
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      out.push(parseStrict(line));
    } catch (error) {
      if (index === lines.length - 1 && !/duplicate key|key not allowed/.test(error.message)) return; // torn final line
      throw new JsonError(`${what} line ${index + 1}: ${error.message}`);
    }
  });
  return out;
}
