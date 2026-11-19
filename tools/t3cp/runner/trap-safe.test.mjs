// The runner's traps (the record deadline's USR1, TERM, INT) can fire in any command substitution. bash 5.2 then
// fails to parse the trap ("trap: line 2: unexpected EOF while looking for matching `)'", exit 2) when another
// substitution is still to expand in the same simple command: the deadline then ends the record as a syntax error,
// not record_timeout. A substitution nested in another, or in $(( )), is safe; two side by side are not. So no simple
// command in run-record.sh holds two side by side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The simple commands of a bash script that hold two or more command substitutions side by side (not nested in one
 * another, not inside $(( ))), as [line, count]. Continuation lines join; ; && || | and newlines end a command;
 * single quotes and comments hold none.
 */
export function siblingSubstitutions(script) {
  const out = [];
  let line = 1;
  let start = 1;
  let count = 0;
  const stack = []; // open constructs: "$(", "(", "$((", '"', "`"
  const end = () => {
    if (count >= 2) out.push([start, count]);
    count = 0;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    const top = stack.at(-1);
    if (c === "\n") {
      line++;
      if (script[i - 1] === "\\") continue;
      if (stack.length === 0) {
        end();
        start = line;
      }
      continue;
    }
    if (top === "'") {
      if (c === "'") stack.pop();
      continue;
    }
    if (c === "\\") {
      if (script[i + 1] === "\n") line++;
      i++;
      continue;
    }
    if (top === '"') {
      if (c === '"') stack.pop();
      else if (c === "$" && script[i + 1] === "(") {
        if (script[i + 2] === "(") {
          stack.push("$((");
          i += 2;
        } else {
          if (!stack.some((s) => s === "$(")) count++;
          stack.push("$(");
          i++;
        }
      }
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(script[i - 1])) && stack.every((s) => s === "$(" || s === "(")) {
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "'") stack.push("'");
    else if (c === '"') stack.push('"');
    else if (c === "$" && script[i + 1] === "(") {
      if (script[i + 2] === "(") {
        stack.push("$((");
        i += 2;
      } else {
        if (!stack.some((s) => s === "$(")) count++;
        stack.push("$(");
        i++;
      }
    } else if (c === "(") stack.push("(");
    else if (c === ")") {
      if (top === "$((" && script[i + 1] === ")") i++;
      stack.pop();
    } else if (stack.length === 0 && (c === ";" || c === "|" || (c === "&" && script[i + 1] === "&"))) {
      end();
      start = line;
    }
  }
  end();
  return out;
}

test("the scanner finds substitutions side by side, and not nested ones, arithmetic ones or quoted text", () => {
  assert.deepEqual(siblingSubstitutions('printf "%s %s" "$(a)" "$(b)"\n'), [[1, 2]]);
  assert.deepEqual(siblingSubstitutions("x=$(a) y=$(b)\n"), [[1, 2]]);
  assert.deepEqual(siblingSubstitutions('lib write "$(a)" \\\n  "$(b)"\n'), [[1, 2]]);
  assert.deepEqual(siblingSubstitutions('fail x "$(a | b) and $(c)"\n'), [[1, 2]]);
  assert.deepEqual(siblingSubstitutions('x=$(cd "$(dirname "$y")" && pwd)\n'), []);
  assert.deepEqual(siblingSubstitutions("e=$(( $(date +%s) - T0 ))\n"), []);
  assert.deepEqual(siblingSubstitutions("a=$(x); b=$(y)\nc=$(z) && d=$(w)\n"), []);
  assert.deepEqual(siblingSubstitutions("echo '$(a) $(b)' # $(c) $(d)\n"), []);
  assert.deepEqual(siblingSubstitutions("f() {\n  a=$(x)\n  b=$(y) c=$(z)\n}\n"), [[3, 2]]);
});

test("no simple command in run-record.sh holds two command substitutions side by side", () => {
  const script = readFileSync(join(here, "..", "run-record.sh"), "utf8");
  assert.deepEqual(siblingSubstitutions(script), [], "split each into its own assignment first");
});
