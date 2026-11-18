#!/usr/bin/env node
// Writes schema/*.json (data's schemas) from tools/t3cp/lib/schemas.mjs, the site-output fields of
// tools/t3cp/lib/schemas-site.mjs and catalogue/catalogue.json.
// Run after any catalogue change: `node tools/t3cp/dev/build-schemas.mjs`. schema/schemas.test.mjs fails
// when a committed schema differs from this output.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { serialise } from "../lib/schemas.mjs";
import { buildAllSchemas } from "../lib/schemas-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalogue = JSON.parse(fs.readFileSync(path.join(root, "catalogue/catalogue.json"), "utf8"));
for (const [name, schema] of Object.entries(buildAllSchemas(catalogue))) {
  fs.writeFileSync(path.join(root, "schema", name), serialise(schema));
  console.log(`schema/${name}`);
}
