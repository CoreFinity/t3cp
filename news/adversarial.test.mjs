// The independent review's adversarial cases (adversarial.mjs and adversarial2.mjs, 123) as a table: every case but the controls must be caught.
// Strings the public-repo scan forbids are assembled at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { check } from './check.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';
import { hostShape } from './fixtures/host-shape.mjs';

const sha = (b) => createHash('sha256').update(JSON.stringify(b)).digest('hex');
const C1 = '{claim:turns_completed.linux-x64.100.base}';
const C2 = '{claim:rss_peak_mib.linux-x64.250.base}';
const C3 = '{claim:turn_p50_ms.linux-x64.250.base}';
const CW = '{claim:dispatch_p95_ms.linux-x64.100.base}';
const CX = '{claim:writer_tx_p95_ms.linux-x64.100.base}';
const ZW = '\u200B';
const clean = () => [];
// A stand-in for the public scanner on the patterns the cases plant (host shape, email, internal path).
const scanText = (t) => {
  const out = [];
  for (const [id, re] of [['host', hostShape('giu')], ['email', /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/giu], ['path', new RegExp('/v' + 'ar/', 'gu')]]) {
    for (const m of String(t).matchAll(re)) out.push({ pattern: id, match: m[0], index: m.index });
  }
  return out;
};

function run(kind, text, mutate) {
  const b = bundle();
  if (mutate) mutate(b);
  const p = goodClaimPost(b);
  p.bundle_sha256 = sha(b);
  if (kind === 'summary') p.summary = text;
  else p.sections[kind] = { ...p.sections[kind], caption: text };
  return check(p, b, { scanText });
}

const CASES = [

  // [group, label, field, text, mutate?]
  ['number-word', '"twelve"', 'summary', `Twelve agents in all: ${C1}.`],
  ['number-word', '"a third"', 'summary', `A third of the base: ${C3}.`],
  ['number-word', '"half"', 'summary', `About half: ${C3}.`],
  ['number-word', '"a fifth"', 'summary', `Down by a fifth: ${C3}.`],
  ['number-word', '"a fifth" (no direction word)', 'summary', `A fifth of the base: ${C3}.`],
  ['number-word', '"billion"', 'summary', `A billion rows: ${C1}.`],
  ['number-word', '"sixfold"', 'summary', `Sixfold: ${C1}.`],
  ['number-word', '"hundredfold"', 'summary', `A hundredfold gap closed: ${C1}.`],
  ['number-word', 'ordinal "third"', 'summary', `For the third release running: ${C1}.`],
  ['number-word', '"a couple of"', 'summary', `A couple of points: ${C1}.`],
  ['digit', 'Arabic-Indic digits + Arabic percent "\u0663\u0664\u066A"', 'summary', `About \u0663\u0664\u066A: ${C1}.`],
  ['digit', 'full-width "\uFF13\uFF14\uFF05"', 'summary', `About \uFF13\uFF14\uFF05: ${C1}.`],
  ['digit', 'full-width digits only "\uFF13\uFF14"', 'summary', `About \uFF13\uFF14 turns: ${C1}.`],
  ['digit', 'vulgar fraction "\u00BD"', 'summary', `About \u00BD: ${C3}.`],
  ['digit', 'superscript "\u00B2"', 'summary', `Squared\u00B2: ${C3}.`],
  ['digit', 'digit after a letter "x2"', 'summary', `Throughput x2: ${C1}.`],
  ['digit', 'digit after a letter "p99"', 'summary', `The p99 view: ${C3}.`],
  ['digit', 'ASCII "34%"', 'summary', `About 34%: ${C1}.`],
  ['direction', '"dropped"', 'summary', `Memory dropped: ${C2}.`],
  ['direction', '"doubled"', 'summary', `Throughput doubled: ${C1}.`],
  ['direction', '"worse"', 'summary', `Worse: ${C1}.`],
  ['direction', '"better"', 'summary', `Better: ${C2}.`],
  ['direction', '"regression"', 'summary', `A regression: ${C1}.`],
  ['direction', '"speed-up"', 'summary', `A speed-up: ${C3}.`],
  ['direction', '"slowdown"', 'summary', `A slowdown: ${C3}.`],
  ['direction', '"cut"', 'summary', `Time cut: ${C3}.`],
  ['direction', '"halved"', 'summary', `Time halved: ${C3}.`],
  ['direction', '"climbed"', 'summary', `Turns climbed: ${C1}.`],
  ['direction', '"surged"', 'summary', `Turns surged: ${C1}.`],
  ['direction', '"sank"', 'summary', `Turns sank: ${C1}.`],
  ['direction', '"ballooned"', 'summary', `Memory ballooned: ${C3}.`],
  ['direction', '"slashed"', 'summary', `Turn time slashed: ${C2}.`],
  ['direction', '"plummeted"', 'summary', `Turns plummeted: ${C1}.`],
  ['direction', '"lowered"', 'summary', `Turn time lowered: ${C2}.`],
  ['direction', '"shrinks"', 'summary', `Turn time shrinks: ${C2}.`],
  ['direction', '"smaller"', 'summary', `A smaller footprint: ${C2}.`],
  ['direction', '"lighter"', 'summary', `Lighter on memory: ${C2}.`],
  ['direction', '"fastest"', 'summary', `The fastest release yet: ${C2}.`],
  ['direction', '"lowest"', 'summary', `The lowest yet: ${C2}.`],
  ['direction', '"a new high"', 'summary', `A new high: ${C2}.`],
  ['direction', '"degraded"', 'summary', `Turns degraded: ${C1}.`],
  ['direction', '"recovered"', 'summary', `Turns recovered: ${C2}.`],
  ['direction', '"sped up" (two words)', 'summary', `Sped up: ${C3}.`],
  ['direction', '"quicker"', 'summary', `Quicker: ${C3}.`],
  ['negation', '"contrary to"', 'summary', `Contrary to the chart, ${C1}.`],
  ['negation', '"not"', 'summary', `It is not true that ${C1}.`],
  ['negation', '"despite"', 'summary', `Despite the claim, ${C1}.`],
  ['negation', '"however"', 'summary', `However, ${C1}.`],
  ['negation', '"but"', 'summary', `But ${C1}.`],
  ['negation', '"never"', 'summary', `Never mind ${C1}.`],
  ['negation', '"no change"', 'summary', `No change: ${C1}.`],
  ['negation', '"neither"', 'summary', `Neither here nor there: ${C1}.`],
  ['negation', '"n\'t" ("isn\'t")', 'summary', `This isn't right: ${C1}.`],
  ['negation', '"false"', 'summary', `False: ${C1}.`],
  ['negation', '"opposite"', 'summary', `The opposite holds: ${C1}.`],
  ['synonym', '"latency"', 'summary', `Latency: ${C1}.`],
  ['synonym', '"memory"', 'summary', `Memory: ${C1}.`],
  ['synonym', '"CPU"', 'summary', `CPU: ${C1}.`],
  ['synonym', '"throughput"', 'summary', `Throughput: ${C2}.`],
  ['synonym', 'catalogue name outside the bundle ("Push latency p95")', 'summary', `Push latency p95: ${C1}.`],
  ['synonym', 'bundle metric name ("Peak memory")', 'summary', `Peak memory: ${C1}.`],
  ['quote', 'placeholder inside a quote', 1, `The changelog says "${C1}".`],
  ['quote', 'placeholder inside curly quotes', 1, `The changelog says \u201C${C1}\u201D.`],
  ['quote', 'placeholder inside single quotes', 1, `The changelog says '${C1}'.`],
  ['two', 'two placeholders through a semicolon', 'summary', `${C1}; ${C2}.`],
  ['two', 'two placeholders in a parenthesis', 'summary', `${C1} (${C2}).`],
  ['two', 'two placeholders through an em dash', 'summary', `${C1} \u2014 ${C2}.`],
  ['two', 'two placeholders through "." with no space', 'summary', `${C1}.${C2}.`],
  ['two', 'two placeholders through an ellipsis', 'summary', `${C1}\u2026 ${C2}.`],
  ['two', 'two placeholders through "?"', 'summary', `${C1}? ${C2}.`],
  ['markup', 'HTML tag', 'summary', `<b>Look</b>: ${C1}.`],
  ['markup', 'HTML entity', 'summary', `Look &amp; see: ${C1}.`],
  ['markup', 'HTML numeric entity', 'summary', `About &#51;&#52;&#37;: ${C1}.`],
  ['markup', 'markdown bold', 'summary', `**Look**: ${C1}.`],
  ['markup', 'markdown link', 'summary', `[Look](https://x.example): ${C1}.`],
  ['markup', 'markdown list marker', 'summary', `- Look: ${C1}.`],
  ['markup', 'bare URL', 'summary', `See t3cp.io/x: ${C1}.`],
  ['quote-trunc', 'truncated quote that drops "not" (changelog: "Message ordinals read through an index, not a scan.")', 1,
    `${'{claim:writer_tx_p95_ms.linux-x64.100.base}'}. The changelog says "a scan".`],
  ['quote-trunc', 'truncated quote with a number and a direction', 1,
    `${'{claim:writer_tx_p95_ms.linux-x64.100.base}'}. The changelog says "3 times slower on cold start".`,
    (b) => { b.changelog.push('No longer 3 times slower on cold start.'); }],
  ['quote-trunc', 'truncated quote that inverts a cause', 1,
    `${'{claim:writer_tx_p95_ms.linux-x64.100.base}'}. As the changelog says, "writes are slower".`,
    (b) => { b.changelog.push('Reverted the change under which writes are slower.'); }],
  ['quote-trunc', 'one-word quote', 1,
    `${'{claim:writer_tx_p95_ms.linux-x64.100.base}'}. The changelog says "not".`],
  ['split', 'host shape split across a placeholder ("ws" + digit)', 'summary', `ws${C1}.`],
  ['split', 'email split across a placeholder (clause ends "noise")', 'summary', `${C1}@corp-internal.com.`],
  ['split', 'path split across a placeholder', 'summary', `/var/${C1}.`],
  ['split', 'internal name in free text directly (control)', 'summary', `On ${['w', 's', '4'].join('')}: ${C1}.`],
  ['zw', 'ZWSP in a banned word "dra\\u200Bmatically"', 'summary', `Dra${ZW}matically: ${C1}.`],
  ['zw', 'ZWSP in a direction word "fa\\u200Bster"', 'summary', `Fa${ZW}ster: ${C3}.`],
  ['zw', 'soft hyphen in a direction word "slo\\u00ADwer"', 'summary', `Slo\u00ADwer: ${C3}.`],
  ['zw', 'word joiner in a banned word "hu\\u2060ge"', 'summary', `Hu\u2060ge: ${C1}.`],
  ['zw', 'ZWSP in a negation "n\\u200Bot"', 'summary', `It is n${ZW}ot so: ${C1}.`],
  ['zw', 'ZWJ (control) "hu\\u200Dge"', 'summary', `Hu\u200Dge: ${C1}.`],
  ['zw', 'Cyrillic homoglyph "f\u0430ster"', 'summary', `F\u0430ster: ${C3}.`],
  ['zw', 'ZWSP inside a digit run "3\\u200B4%"', 'summary', `About 3${ZW}4%: ${C1}.`],
  ['zw', 'ZWSP inside an internal host name', 'summary', `On w${ZW}s4: ${C1}.`],
  ['zw', 'exclamation via full-width "\uFF01"', 'summary', `Look\uFF01 ${C1}.`],
  ['zw', 'exclamation via inverted "\u00A1"', 'summary', `\u00A1Look: ${C1}.`],
  ['binding', 'summary cites a within-noise claim while movers exist', 'summary', `${CW}.`],
  ['binding', 'caption cites a claim of another metric', 0, `${C2}.`],
  // The control cites the regressed claim first: the summary runs largest change first.
  ['control', 'clean placeholder post (control)', 'summary', `${C2}. ${C1}.`],

  ['quote', 'placeholder inside a quote (right chart)', 1, `The changelog says "${CX}".`],
  ['quote', 'placeholder inside single quotes (right chart)', 1, `The changelog says '${CX}'.`],
  ['quote', 'quote with no changelog match (control)', 1, `${CX}. The changelog says "made everything quicker".`],
  ['platform', '"On macOS" with a Linux claim', 'summary', `On macOS: ${C1}.`],
  ['platform', '"On an M2 Pro" with a Linux claim', 'summary', `On an M2 Pro: ${C1}.`],
  ['platform', '"On ARM" with a Linux claim', 'summary', `On ARM: ${C1}.`],
  ['level', '"with a single agent" on a 100-agent claim', 'summary', `With a single agent, ${C1}.`],
  ['level', '"at full load" on a 100-agent claim', 'summary', `At full load, ${C1}.`],
  ['comparison', '"Against perf.7" on a base claim', 'summary', `Against perf.7: ${C1}.`],
  ['comparison', '"Against the previous release" on a base claim', 'summary', `Against the previous release: ${C1}.`],
  ['comparison', '"Against upstream main" on a base claim', 'summary', `Against upstream main: ${C1}.`],
  ['cause', '"since" as a cause', 'summary', `Since reads moved to the reader pool, ${C1}.`],
  ['cause', '"with" as a cause', 'summary', `With reads on the reader pool, ${C1}.`],
  ['cause', '"because" (control)', 'summary', `Because of the reader pool, ${C1}.`],
  ['quality', '"good"', 'summary', `A good result: ${C1}.`],
  ['quality', '"disappointing"', 'summary', `A disappointing result: ${C1}.`],
  ['quality', '"marginal"', 'summary', `A marginal change: ${C2}.`],
  ['quality', '"slight"', 'summary', `A slight change: ${C2}.`],
  ['quality', '"substantial"', 'summary', `A substantial change: ${C1}.`],
  ['quality', '"largest"', 'summary', `The largest change: ${CW}.`],
  ['quality', '"problem"', 'summary', `A problem: ${C1}.`],
  ['quality', '"fixed"', 'summary', `Fixed: ${C2}.`],
  ['synonym-caption', '"CPU" in the chart caption of another metric', 0, `CPU time: {claim:turns_completed.linux-x64.250.base}.`],
  ['synonym-caption', '"memory" in the turns chart caption', 0, `Memory use: {claim:turns_completed.linux-x64.250.base}.`],
];

const CONTROLS = new Set(['clean placeholder post (control)']);

test('the review\'s adversarial cases (both scripts, 123): all but the control are caught', () => {
  assert.equal(CASES.length, 123);
  const passed = [];
  for (const [group, label, field, text, mutate] of CASES) {
    const r = run(field, text, mutate);
    if (CONTROLS.has(label)) assert.deepEqual(r.findings, [], `${group}: ${label} must pass`);
    else if (r.passed) passed.push(`${group}: ${label}`);
  }
  assert.deepEqual(passed, [], 'cases the checker let through');
});

// ---- The re-review's cases (adversarial3.mjs, 40): allowed words that form claims, glued placeholders, quotes. ----
const CP = '{claim:rss_peak_mib.linux-x64.250.prev}';
const addLine = (l) => (b) => { b.changelog.push(l); };
const CASES3 = [
  // allowlist words combined into a claim
  ['allow-combo', '"Each release shows" (generalises across releases)', 'summary', `Each release shows ${C1}.`],
  ['allow-combo', '"The upstream nightly series also shows" (credits upstream)', 'summary', `The upstream nightly series also shows ${C1}.`],
  ['allow-combo', '"Measured against the fork:" (reverses the reference)', 'summary', `Measured against the fork: ${C1}.`],
  ['allow-combo', '"The base compared with the fork:"', 'summary', `The base compared with the fork: ${C1}.`],
  ['allow-combo', '"For each agent:" (per-agent reading)', 'summary', `For each agent: ${C1}.`],
  ['allow-combo', '"Both nightlies and the fork show"', 'summary', `Both nightlies and the fork show ${C1}.`],
  ['allow-combo', '"Against the nightly:" (base named a nightly)', 'summary', `Against the nightly: ${C1}.`],
  ['allow-combo', 'trailing ", against the fork record"', 'summary', `${C1}, against the fork record.`],
  ['allow-combo', '"Here the previous fork release shows" on a base claim', 'summary', `Here the previous fork release shows ${C1}.`],
  ['allow-combo', 'trailing ", also against the upstream base" on a prev claim', 4, `${CP}, also against the upstream base.`],
  ['allow-combo', 'summary with no claim while movers exist', 'summary', `Here the charts show the fork against the upstream base.`],
  // placeholder-adjacent
  ['adjacent', 'letter glued after a placeholder "{claim}a"', 'summary', `${C1}a.`],
  ['adjacent', 'word glued before a placeholder "the{claim}"', 'summary', `the${C1}.`],
  ['adjacent', 'claim and quote glued "{claim}{quote:1}"', 1, `${CX}{quote:1}.`],
  ['adjacent', 'full-width braces around a claim id', 'summary', `\uFF5Bclaim:turns_completed.linux-x64.100.base\uFF5D.`],
  ['adjacent', 'full-width colon inside a placeholder', 'summary', `{claim\uFF1Aturns_completed.linux-x64.100.base}.`],
  ['adjacent', 'upper-case claim id', 'summary', `{claim:Turns_completed.linux-x64.100.base}.`],
  ['adjacent', 'no-break space between words', 'summary', `Each\u00A0release shows ${C1}.`],
  ['adjacent', 'nested placeholder', 'summary', `{claim:{claim:turns_completed.linux-x64.100.base}}.`],
  // other scripts and negation idioms
  ['script', 'German "Nicht"', 'summary', `Nicht ${C1}.`],
  ['script', 'Greek "\u03CC\u03C7\u03B9"', 'summary', `\u03CC\u03C7\u03B9 ${C1}.`],
  ['script', 'CJK "\u4E0D"', 'summary', `\u4E0D ${C1}.`],
  ['script', 'Latin letter that looks like 2 ("\u01BB")', 'summary', `\u01BB ${C1}.`],
  ['script', 'superscript Latin letters spelling "the" (NFKC folds to an allowed word)', 'summary', `\u1D57\u02B0\u1D49 base shows ${C1}.`],
  ['script', '"hardly"', 'summary', `Hardly ${C1}.`],
  ['script', '"far from"', 'summary', `Far from ${C1}.`],
  ['script', '"unimproved" (prefix)', 'summary', `Unimproved: ${C1}.`],
  ['script', '"Against this:" before a claim', 'summary', `Against this: ${C1}.`],
  // quote abuse
  ['quote', 'quotable line with negation and a metric (by design)', 1, `${CX}. {quote:2}.`],
  ['quote', 'line with a direction word outside the categories ("snappier")', 1, `${CX}. {quote:3}.`, addLine('Writes are snappier now.')],
  ['quote', 'line with "doubles" (inflection outside the number list)', 1, `${CX}. {quote:3}.`, addLine('Doubles the reader pool.')],
  ['quote', 'line with "a handful"', 1, `${CX}. {quote:3}.`, addLine('Turns finish in a handful of steps.')],
  ['quote', 'line with "zippier"', 1, `${CX}. {quote:3}.`, addLine('Dispatch is zippier.')],
  ['quote', 'quote index out of range', 1, `${CX}. {quote:9}.`],
  ['quote', 'quote index zero', 1, `${CX}. {quote:0}.`],
  ['quote', 'quote inside a sentence with words', 1, `${CX}. The fork shows {quote:1}.`],
  ['quote', 'quote of an unrelated line in the summary (implied cause)', 'summary', `${C2}. {quote:1}.`],
  ['quote', 'changelog line holding a placeholder-shaped token', 1, `${CX}. {quote:3}.`, addLine('See {claim:db_ready_ms.linux-x64.once.base} for startup.')],
  // structure
  ['struct', 'four sentences in the summary', 'summary', `${C1}. ${C2}. ${C3}. Here the charts show the fork.`],
  // The control cites the regressed claim first: the summary runs largest change first.
  ['control', 'clean placeholder post (control)', 'summary', `${C2}. ${C1}.`],
];
// A {quote:n} in a caption is always caught now (quotes stand only in the end block): the by-design quote case is
// no longer a control.
const CONTROLS3 = new Set(['clean placeholder post (control)']);

test('the re-review\'s cases (40): all but the control are caught', () => {
  assert.equal(CASES3.length, 40);
  const passed = [];
  for (const [group, label, field, text, mutate] of CASES3) {
    const r = run(field, text, mutate);
    if (CONTROLS3.has(label)) assert.deepEqual(r.findings, [], `${group}: ${label} must pass`);
    else if (r.passed) passed.push(`${group}: ${label}`);
  }
  assert.deepEqual(passed, [], 'cases the checker let through');
});
