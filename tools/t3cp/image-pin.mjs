#!/usr/bin/env node
// The exporter closure hash and its pin (tools/t3cp/image-pin.json). An image is built from a t3cp tree whose pin equals
// that tree's closure hash; ops refuses to launch an image whose hash differs from main's pin.
//
//   node tools/t3cp/image-pin.mjs --print               the tree's closure hash (exporter_files_sha256)
//   node tools/t3cp/image-pin.mjs --check [--pin <f>]   exit 0 when the pin (default tools/t3cp/image-pin.json) equals
//                                                       it, 2 when it differs or the pin is unreadable or malformed
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { exporterFilesSha256 } from "./export.mjs";
import { isMain } from "./lib/repo.mjs";

export const PIN_FILE = new URL("./image-pin.json", import.meta.url);

/** The pinned hash, or throws when the pin is unreadable or malformed. */
export function readPin(file = PIN_FILE) {
  const pin = JSON.parse(fs.readFileSync(file, "utf8"));
  if (pin?.schema !== "t3cp/image-pin/1" || typeof pin.exporter_files_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.exporter_files_sha256)) {
    throw new Error("not a t3cp/image-pin/1 file with a 64-hex exporter_files_sha256");
  }
  return pin.exporter_files_sha256;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { print: { type: "boolean" }, check: { type: "boolean" }, pin: { type: "string" } } });
  if (values.print === values.check) {
    process.stderr.write("usage: image-pin.mjs --print | --check [--pin <file>]\n");
    return 2;
  }
  const hash = exporterFilesSha256();
  if (values.print) {
    process.stdout.write(`${hash}\n`);
    return 0;
  }
  let pinned;
  try {
    pinned = readPin(values.pin ?? PIN_FILE);
  } catch (error) {
    process.stderr.write(`image-pin: pin unreadable: ${error.message}\n`);
    return 2;
  }
  if (pinned !== hash) {
    process.stderr.write(`image-pin: the pinned hash differs from this tree's closure hash (${pinned} != ${hash})\n`);
    return 2;
  }
  process.stdout.write(`image-pin: ${hash}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
