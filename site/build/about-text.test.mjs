// Red first: About opens with the approved longer text, four paragraphs in place of the three ledes: why one server
// for many agents is the hard case, the fork that sends every fix upstream (its MRs page linked), the nightly method
// in plain words, and what "the lines meet" means. Paragraph 4 describes the fork measured each night beside that
// night's upstream build (the fork-head line). The sections below it stay as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.mjs';

const ENT = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' };
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/&(amp|#39|quot|lt|gt);/g, e => ENT[e]).replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();
const TEXT = [
  'T3 Code works well for one developer at a laptop. Run it as one server for many coding agents at once, dozens or hundreds of them, and other limits show up: a main thread close to saturation, reads waiting for a database connection, memory that grows by the hour, queued runs that start late.',
  'So we forked it. Our performance fork works on exactly those limits, and it keeps no fix to itself: every change goes back to upstream T3 Code as a pull request, listed on our MRs page. The fork is there to make upstream faster, not to replace it.',
  "Each night we measure the same way. Upstream's newest nightly runs on a cloud machine against the same large database, at 1, 50, 100, 150, 200 and 250 agents, three attempts at each level, and the numbers are published the day they are taken. Each release of the fork is built from its public tag and measured on the same machine, under the same load, against the upstream code it is based on. A change counts only when it is larger than the metric's measured noise; everything else is within noise.",
  "On the charts, upstream's nightlies are one line and our fork another. Each night we build the fork's latest release from its public tag and measure it beside that night's upstream build, on the same machine and under the same load. Where the fork is faster there is a gap between the lines. When upstream merges one of our pull requests, its next nightly carries the fix and the gap at that metric closes. When the lines meet, upstream has every fix the fork had to offer.",
];

test('About opens with the four paragraphs, the MRs page linked, and keeps its sections', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-about-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const html = readFileSync(join(out, 'about/index.html'), 'utf8');
    const head = html.slice(html.indexOf('<header class="page-h">'), html.indexOf('</header>', html.indexOf('<header class="page-h">')));
    const ledes = [...head.matchAll(/<p class="lede">([^]*?)<\/p>/g)].map(m => m[1]);
    assert.deepEqual(ledes.map(txt), TEXT);
    assert.match(ledes[1], /listed on our <a href="\/mrs\/">MRs page<\/a>\./, 'the MRs page is linked');
    assert.doesNotMatch(html, /An independent record of how T3 Code performs|the way it is run in production|So every nightly is measured/, 'the old ledes are gone');
    assert.match(head, /See the charts[^]*T3 Code on GitHub[^]*The fork on GitHub/, 'the buttons stay');
    for (const h of ['How it is measured.', 'Not T3 Code.', 'Take the data.', 'Licences.', 'Visits and corrections.']) assert.ok(html.includes(`<h2>${h}</h2>`), h);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
