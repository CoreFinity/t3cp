// Changelog lines reach the post bundle, the model's view, the committed source file and the release page, quoted
// or not. Every line is scanned as written and after NFKC normalisation with format characters removed, and the
// normalised line is what is kept; a line with a link (any URL), markup (an HTML tag) or an HTML entity is refused:
// the excerpt is plain text, and the release page links the tag itself. Every name here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';

const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const scanText = (t) => [...String(t).matchAll(/zorbelhost/gi)].map((m) => ({ pattern: 'private_host', index: m.index }));
const build = (changelog) => buildPostBundle(source(), { catalogue, changelog, scanText });

test('a name split by an invisible format character is caught in the normalised line', () => {
  assert.throws(() => build(['Faster dispatch on Zorbel​host.']), /internal-name scan/);
  assert.throws(() => build(['Faster dispatch on Zorbel⁠host.']), /internal-name scan/);
  assert.throws(() => build(['Faster dispatch on Ｚorbelhost.']), /internal-name scan/, 'a fullwidth letter, folded by NFKC');
});

test('the kept lines are the normalised ones: NFKC, no format character', () => {
  const b = build(['Faster​ dispatch­ for ｆive readers.']);
  assert.deepEqual(b.changelog, ['Faster dispatch for five readers.']);
});

test('a line with a link, markup or an HTML entity is refused, naming the line only', () => {
  for (const line of ['See https://example.invalid/notes for details.', 'Notes at www.example.invalid today.', 'Read <https://example.invalid> first.',
    'A <b>bold</b> change.', 'Reads &amp; writes split.', 'A <img src=x onerror=y> change.', 'Fetch from ftp://example.invalid/x.']) {
    assert.throws(() => build(['A plain first line.', line]), (e) => /changelog line 2/.test(e.message) && !e.message.includes('example.invalid'), line);
  }
  assert.doesNotThrow(() => build(['Reads routed to the reader pool by statement class.', 'Writer transactions batched in groups of two.']));
});
