// Whether a module is the script node was started with, however that path was reached (a symlinked directory, a
// path with a space): both sides resolved to the real file. import.meta.url alone is resolved and percent-encoded,
// argv[1] is neither, so comparing them as strings silently skips the command line.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
