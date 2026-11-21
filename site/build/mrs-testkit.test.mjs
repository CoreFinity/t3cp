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

// The stand-in API is served on the IPv4 loopback and the command line is pointed at it by address: where "localhost"
// resolves to ::1 for the server and to 127.0.0.1 for the client (the gate containers), the two never met.
test('runCli serves its stand-in API on 127.0.0.1 and points the command line at that address', async () => {
  let local = null, host = null;
  const { code, stderr } = await kit.runCli(['--out', join(await kit.tempDir(), 'mrs.json'), '--retry-delay-ms', '0'], (req, res) => {
    local = req.socket.localAddress; host = req.headers.host;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(kit.page([])));
  });
  assert.equal(code, 0, stderr);
  assert.equal(local, '127.0.0.1');
  assert.match(host, /^127\.0\.0\.1:\d+$/);
});
