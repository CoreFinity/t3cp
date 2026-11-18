// Shared plumbing for the audit CLIs: exit codes and "run only when executed directly".
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 0 clean, 1 error (fail closed), 2 findings. */
export const EXIT = Object.freeze({ clean: 0, error: 1, findings: 2 });

export const isMain = (meta) => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(meta.url));
  } catch {
    return false;
  }
};

/** Runs a CLI body; any thrown error is a failure (exit 1), never a pass. */
export const runCli = (name, body) => {
  try {
    process.exitCode = body();
  } catch (error) {
    process.stderr.write(`${name}: ERROR: ${error?.message ?? error}\n`);
    process.exitCode = EXIT.error;
  }
};

/** `--flag value` pairs; a repeated flag collects its values; unknown flags are errors. */
export const parseArgs = (argv, known) => {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!known.includes(flag)) throw new Error(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    (out[flag] ??= []).push(value);
    index++;
  }
  return out;
};
