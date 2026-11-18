// Tests for the MRs test kit itself: the temporary directories the tests create are removed after each run.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as kit from './mrs-testkit.mjs';

after(kit.removeTempDirs);

test('removeTempDirs removes every directory tempDir made, with its contents', async () => {
  const a = await kit.tempDir();
  const b = await kit.tempDir();
  await writeFile(join(a, 'mrs.json'), '{}');
  await kit.removeTempDirs();
  await assert.rejects(stat(a), { code: 'ENOENT' });
  await assert.rejects(stat(b), { code: 'ENOENT' });
  await kit.removeTempDirs(); // nothing left to remove: no error
});
