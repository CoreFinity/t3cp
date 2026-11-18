// yaml-lite: the YAML subset GitHub workflow files use, parsed without a dependency.
//
// Block mappings and sequences, single-line flow collections, plain/quoted scalars, block
// scalars (| and >) and comments. Everything else (anchors, aliases, tags, complex keys, tab
// indentation, duplicate keys, multi-line flow collections or plain scalars, several documents)
// throws: a check that cannot read a file must fail, never pass. Plain scalars stay strings
// except null and booleans, so `fetch-depth: 0` reads as "0".

const SCALAR_START = new Set([":", "-", "[", "{", ","]);
const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_$./][A-Za-z0-9_$./ -]*?))\s*:(?:\s+(.*))?$/;
const BLOCK_SCALAR = /^([|>])([+-]?)([1-9]?)$/;

const fail = (lineIndex, message) => {
  throw new Error(`yaml-lite: line ${lineIndex + 1}: ${message}`);
};

/** Drops a comment (`#` at the start or after whitespace, outside a quoted scalar). */
const stripComment = (text) => {
  let quote = null;
  let last = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === '"') {
      if (char === "\\") index++;
      else if (char === '"') quote = null;
    } else if (quote === "'") {
      if (char === "'" && text[index + 1] === "'") index++;
      else if (char === "'") quote = null;
    } else if ((char === '"' || char === "'") && (last === "" || SCALAR_START.has(last))) {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
    if (!/\s/.test(char)) last = char;
  }
  return text.trimEnd();
};

/** Splits flow-collection content on top-level commas, outside quotes and nested brackets. */
const splitFlow = (body, lineIndex) => {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) fail(lineIndex, "unbalanced flow collection");
  const tail = body.slice(start).trim();
  if (tail !== "" || parts.length > 0) parts.push(tail);
  if (parts.some((part) => part === "")) fail(lineIndex, "empty flow entry");
  return parts;
};

const decodeDouble = (body, lineIndex) =>
  body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, code) => {
    if (code[0] === "u" && code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16));
    const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", 0: "\0", " ": " " };
    if (!(code in map)) fail(lineIndex, `unsupported escape \\${code}`);
    return map[code];
  });

const setKey = (object, key, value, lineIndex) => {
  if (key === "__proto__" || key === "constructor" || key === "prototype") fail(lineIndex, `refused key ${key}`);
  if (Object.prototype.hasOwnProperty.call(object, key)) fail(lineIndex, `duplicate key ${key}`);
  object[key] = value;
};

const parseScalar = (text, lineIndex) => {
  const value = text.trim();
  if (value === "") return null;
  const first = value[0];
  if (first === "&" || first === "*") fail(lineIndex, "anchors and aliases are not supported");
  if (first === "!") fail(lineIndex, "tags are not supported");
  if (first === "?") fail(lineIndex, "complex keys are not supported");
  if (first === "{") {
    if (!value.endsWith("}")) fail(lineIndex, "multi-line flow mappings are not supported");
    const object = {};
    for (const part of splitFlow(value.slice(1, -1), lineIndex)) {
      const match = KEY.exec(part);
      if (!match) fail(lineIndex, `not a flow mapping entry: ${part}`);
      const key = match[1] !== undefined ? decodeDouble(match[1], lineIndex) : match[2] !== undefined ? match[2].replace(/''/g, "'") : match[3].trim();
      setKey(object, key, parseScalar(match[4] ?? "", lineIndex), lineIndex);
    }
    return object;
  }
  if (first === "[") {
    if (!value.endsWith("]")) fail(lineIndex, "multi-line flow sequences are not supported");
    return splitFlow(value.slice(1, -1), lineIndex).map((part) => parseScalar(part, lineIndex));
  }
  if (first === '"') {
    const match = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
    if (!match) fail(lineIndex, "unterminated or trailing text after a double-quoted scalar");
    return decodeDouble(match[1], lineIndex);
  }
  if (first === "'") {
    const match = /^'((?:[^']|'')*)'$/.exec(value);
    if (!match) fail(lineIndex, "unterminated or trailing text after a single-quoted scalar");
    return match[1].replace(/''/g, "'");
  }
  if (/^(?:~|null|Null|NULL)$/.test(value)) return null;
  if (/^(?:true|True|TRUE)$/.test(value)) return true;
  if (/^(?:false|False|FALSE)$/.test(value)) return false;
  return value;
};

class Parser {
  constructor(text) {
    this.lines = text.replace(/\r\n?/g, "\n").split("\n");
    this.index = 0;
    let first = this.lines.findIndex((line) => stripComment(line).trim() !== "");
    if (first >= 0 && /^---\s*$/.test(stripComment(this.lines[first]))) {
      this.lines[first] = "";
      first++;
    }
    this.lines.forEach((line, lineIndex) => {
      if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) fail(lineIndex, "several documents are not supported");
    });
  }

  indentOf(lineIndex) {
    const line = this.lines[lineIndex];
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.includes("\t") && stripComment(line).trim() !== "") fail(lineIndex, "tab indentation");
    return lead.length;
  }

  /** The next non-blank line index from `this.index`, or -1. */
  peek() {
    for (let lineIndex = this.index; lineIndex < this.lines.length; lineIndex++) {
      if (stripComment(this.lines[lineIndex]).trim() !== "") return lineIndex;
    }
    return -1;
  }

  content(lineIndex) {
    return stripComment(this.lines[lineIndex]).trim();
  }

  isSeqItem(text) {
    return text === "-" || text.startsWith("- ");
  }

  /** A node whose lines are indented at least `minIndent`, or null when there is none. */
  parseNode(minIndent) {
    const next = this.peek();
    if (next < 0 || this.indentOf(next) < minIndent) return null;
    const indent = this.indentOf(next);
    return this.isSeqItem(this.content(next)) ? this.parseSeq(indent) : this.parseMap(indent);
  }

  /** Refuses a more-indented line right after a scalar (a multi-line plain scalar). */
  noContinuation(indent) {
    const next = this.peek();
    if (next >= 0 && this.indentOf(next) > indent) fail(next, "multi-line plain scalars are not supported");
  }

  parseBlockScalar(indent, header, lineIndex) {
    const [, style, chomp, explicit] = BLOCK_SCALAR.exec(header);
    const body = [];
    let contentIndent = explicit ? indent + Number(explicit) : -1;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line.trim() === "") {
        body.push("");
        this.index++;
        continue;
      }
      const lead = /^ */.exec(line)[0].length;
      if (lead <= indent) break;
      if (contentIndent < 0) contentIndent = lead;
      if (lead < contentIndent) fail(this.index, "block scalar line less indented than its first line");
      body.push(line.slice(contentIndent));
      this.index++;
    }
    if (contentIndent < 0 && body.length === 0) fail(lineIndex, "empty block scalar");
    let trailing = 0;
    while (body.length > 0 && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    let text = style === "|" ? body.join("\n") : body.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
    if (chomp === "+") text += "\n".repeat(trailing + 1);
    else if (chomp !== "-" && body.length > 0) text += "\n";
    return text;
  }

  /** The value after `key:` on line `lineIndex` (already consumed). */
  parseValue(rest, indent, lineIndex) {
    if (rest === undefined || rest === "") {
      const next = this.peek();
      if (next < 0) return null;
      const nextIndent = this.indentOf(next);
      if (nextIndent > indent) return this.parseNode(indent + 1);
      if (nextIndent === indent && this.isSeqItem(this.content(next))) return this.parseSeq(indent);
      return null;
    }
    if (BLOCK_SCALAR.test(rest)) return this.parseBlockScalar(indent, rest, lineIndex);
    const value = parseScalar(rest, lineIndex);
    this.noContinuation(indent);
    return value;
  }

  parseMap(indent) {
    const object = {};
    for (;;) {
      const lineIndex = this.peek();
      if (lineIndex < 0) break;
      const lineIndent = this.indentOf(lineIndex);
      if (lineIndent < indent) break;
      if (lineIndent > indent) fail(lineIndex, "unexpected indentation");
      const text = this.content(lineIndex);
      if (this.isSeqItem(text)) break;
      const match = KEY.exec(text);
      if (!match) fail(lineIndex, "not a mapping entry");
      const key = match[1] !== undefined ? decodeDouble(match[1], lineIndex) : match[2] !== undefined ? match[2].replace(/''/g, "'") : match[3].trim();
      this.index = lineIndex + 1;
      setKey(object, key, this.parseValue(match[4]?.trim(), indent, lineIndex), lineIndex);
    }
    return object;
  }

  parseSeq(indent) {
    const items = [];
    for (;;) {
      const lineIndex = this.peek();
      if (lineIndex < 0) break;
      const lineIndent = this.indentOf(lineIndex);
      if (lineIndent < indent) break;
      if (lineIndent > indent) fail(lineIndex, "unexpected indentation");
      const text = this.content(lineIndex);
      if (!this.isSeqItem(text)) break;
      const raw = stripComment(this.lines[lineIndex]).slice(indent + 1);
      const rest = raw.trimStart();
      const itemIndent = indent + 1 + (raw.length - rest.length);
      if (rest === "") {
        this.index = lineIndex + 1;
        items.push(this.parseNode(indent + 1));
      } else if (this.isSeqItem(rest) || (KEY.test(rest) && !/^["'[{]/.test(rest))) {
        this.lines[lineIndex] = " ".repeat(itemIndent) + rest;
        this.index = lineIndex;
        items.push(this.isSeqItem(rest) ? this.parseSeq(itemIndent) : this.parseMap(itemIndent));
      } else if (/^["']/.test(rest) && KEY.test(rest) && !/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')$/.test(rest)) {
        this.lines[lineIndex] = " ".repeat(itemIndent) + rest;
        this.index = lineIndex;
        items.push(this.parseMap(itemIndent));
      } else {
        this.index = lineIndex + 1;
        items.push(parseScalar(rest, lineIndex));
        this.noContinuation(indent);
      }
    }
    return items;
  }
}

/** Parses one YAML document of the supported subset; throws on anything else. */
export const parseYaml = (text) => {
  const parser = new Parser(text);
  const value = parser.parseNode(0);
  const rest = parser.peek();
  if (rest >= 0) fail(rest, "unexpected content");
  return value;
};
