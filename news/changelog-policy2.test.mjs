// review-posts' two minors on the changelog line policy. Invisible code points outside \p{Cf} (every default
// ignorable one), combining marks and Cyrillic or Greek homoglyphs inside a Latin word must not hide a name; a
// link without "//" (javascript:, data:, mailto:, file:, tel:, or a bare dotted host with a path) is refused like
// any other. Every name here is invented; errors name the line number only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';

const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const scanText = (t) => [...String(t).matchAll(/zorbelhost/gi)].map((m) => ({ pattern: 'private_host', index: m.index }));
const build = (changelog) => buildPostBundle(source(), { catalogue, changelog, scanText });
const refusedLine2 = (line) => (e) => /changelog line 2/.test(e.message) && !/zorbel|example\.invalid/i.test(e.message);

test('every default-ignorable code point is removed before the scan, so it cannot split a name', () => {
  const splitters = { 'U+034F': '͏', 'U+FE00': '︀', 'U+FE0F': '️', 'U+3164': 'ㅤ', 'U+115F': 'ᅟ', 'U+FFA0': 'ﾠ',
    'U+180B': '᠋', 'U+180E': '᠎', 'a tag character': '\u{E0041}', 'the tag cancel': '\u{E007F}' };
  for (const [what, ch] of Object.entries(splitters)) {
    assert.throws(() => build(['A plain first line.', `Faster dispatch on Zorbel${ch}host.`]), refusedLine2(), what);
  }
});

test('combining marks cannot split a name either', () => {
  for (const mark of ['́', '̧', '̶', '⃝']) {
    assert.throws(() => build(['A plain first line.', `Faster dispatch on Zorbel${mark}host.`]), refusedLine2(), `U+${mark.codePointAt(0).toString(16)}`);
  }
});

test('a word mixing Latin with Cyrillic or Greek letters is refused', () => {
  // Cyrillic о (U+043E), Greek ο (U+03BF), Cyrillic е (U+0435) inside Latin words.
  for (const word of ['Zоrbelhost', 'Zοrbelhost', 'rеader']) {
    assert.throws(() => build(['A plain first line.', `Faster dispatch on ${word}.`]), refusedLine2(), word);
  }
  // Whole words in another script, and accented Latin, stay allowed.
  assert.doesNotThrow(() => build(['Faster dispatch, быстрее and ταχύτερα.', 'Café-style naïve résumé parsing.']));
});

test('a link without "//" is refused: script, data, mail, file and phone schemes, and a bare dotted host with a path', () => {
  for (const line of ['Open javascript:alert(1) to see.', 'Embedded data:text/html;base64,AAAA here.', 'Mail mailto:someone@example.invalid today.',
    'Read file:///etc/hosts first.', 'Call tel:+15550100 now.', 'Notes at example.invalid/notes today.', 'See docs.example.invalid/a/b for more.']) {
    assert.throws(() => build(['A plain first line.', line]), refusedLine2(), line);
  }
  assert.doesNotThrow(() => build(['Note: reads are routed by statement class.', 'The ratio stays 2:1 under load.', 'Fixes in site/build and news/check.mjs.']));
});

// review-posts' false positives on #31aa: technical prose stays allowed, every negative above stays refused.
test('tech prose is allowed: a dotted file or framework name before a slash, the micro sign, and a Greek letter that looks like no Latin one', () => {
  assert.doesNotThrow(() => build(['Built on Node.js/Electron and Next.js/React.', 'Tests in index.ts/index.test.ts and config.yml/app.json.', 'Turns finish in 120 µs at most.', 'The Δt between ticks is shorter.']));
});

test('a look-alike letter still cannot hide a name: the names scan folds Cyrillic and Greek look-alikes to Latin', () => {
  // A Cyrillic о (U+043E), a Greek ο (U+03BF) or a Cyrillic е (U+0435) in place of the Latin letter it looks like:
  // the names list itself catches it (the folded form is scanned), not only the mixed-script rule.
  for (const word of ['Z\u043Erbelhost', 'Z\u03BFrbelhost', 'Zorb\u0435lhost']) {
    const seen = [];
    const scan = (t) => { seen.push(t); return scanText(t); };
    assert.throws(() => buildPostBundle(source(), { catalogue, changelog: ['A plain first line.', `Faster dispatch on ${word}.`], scanText: scan }),
      (e) => /changelog line 2 fails the internal-name scan/.test(e.message), word);
    assert.ok(seen.some((t) => t.includes('Zorbelhost')), `${word}: the names scan sees the folded name`);
  }
});
