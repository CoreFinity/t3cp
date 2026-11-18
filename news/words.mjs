// The free-text vocabulary of a release post. Outside a {claim:…} or {quote:…} placeholder the written text may
// use only ALLOWED_WORDS (neutral connectors and chart nouns), compared after NFKC
// normalisation and lower-casing; every other word fails. WORD_CATEGORIES name the words a post must never write
// itself (they come only from claims): a test checks that no allowed word is in any of them, and the checker uses
// them to say which kind of word it found.

export const ALLOWED_WORDS = Object.freeze(new Set([
  // Only words that cannot name a subject, set a scope or make a comparison: the rendered clause already names
  // the metric, the level, the release and what it is compared with.
  'the', 'a', 'an', 'this', 'here', 'in', 'chart', 'charts', 'ladder', 'series',
]));

const list = (s) => s.trim().split(/\s+/);

export const WORD_CATEGORIES = Object.freeze({
  number: list(`zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen
    seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred hundreds thousand thousands
    million millions billion billions trillion dozen dozens couple score first second third fourth fifth sixth seventh
    eighth ninth tenth eleventh twelfth twentieth hundredth thousandth half halves quarter quarters thirds fifths tenths
    percent percentage twice thrice double doubled doubling triple tripled quadruple quadrupled halved halving fold
    twofold threefold fourfold fivefold sixfold tenfold hundredfold single`),
  direction: list(`up down rose rise rises risen rising fell fall falls fallen falling drop drops dropped dropping
    increase increased increases increasing decrease decreased decreases decreasing reduce reduced reduces reduction
    grew grow grows growing growth shrank shrunk shrink shrinks shrinking gain gained gains loss losses lost worse worsened
    better improve improves improving improvement improvements regress regresses regression regressions climbed climb
    jumped jump spiked spike slipped plunged plummeted soared surged surge sank sink ballooned slashed lowered raised
    smaller larger bigger lighter heavier fastest slowest lowest highest high low higher lower more fewer less faster
    slower quicker quickly slowly speedup sped boost boosted outperform outperforms outperformed degraded degrade
    recovered recover regained ahead behind above below over under top bottom new cut cuts trimmed halving`),
  verdict: list(`improved regressed within noise unchanged beyond steady stable flat same similar equal threshold
    verdict significant`),
  metric: list(`latency latencies memory cpu throughput rss heap turn turns time times dispatch sqlite reader readers
    writer writers lock wait startup event events loop gc wal migration migrations delay rate speed performance footprint
    usage requests request queue delivery snapshot database disk io spans span thread threads process processes main
    server ms mib duration cost costs peak`),
  platform: list(`linux macos mac macs darwin apple arm x64 x86 windows intel amd epyc silicon pro ultra mini vm cloud
    machine laptop desktop hardware`),
  level: list(`one single full load heavy light many few several idle all every level levels concurrency concurrent
    scale busy max maximum minimum small large`),
  cause: list(`because since due thanks after so therefore hence consequently owing driven caused causes cause result
    results resulted reason why fixed fix fixes via through thus accordingly following`),
  negation: list(`not no never nor neither none nothing nobody false untrue without instead rather contrary despite
    although though however but yet opposite cannot isn t nt unlike except only`),
  quality: list(`good bad great poor nice best worst excellent strong weak marginal slight slightly substantial largest
    huge big tiny notable problem problems issue issues bug broken disappointing impressive solid healthy clean win
    success failure fail failed ok fine`),
  future: list(`will would could should might may shall soon next upcoming planned plan expect expected`),
  quantity: list(`handful several most many few lot lots plenty bunch multiple numerous majority minority fraction much
    doubles triples quadruples halves whole entire every all some any each both`),
  subject: list(`release releases fork base upstream nightly nightlies previous agent agents record records platform
    version versions build builds`),
  effect: list(`accelerate accelerates accelerated speeds speeding remove removes removed stop stops stopped optimal
    optimise optimises optimised optimize optimizes optimized optimisation optimization fix fixes fixed eliminate
    eliminates eliminated avoid avoids avoided prevent prevents prevented save saves saved trim trims trimmed shorten
    shortens shortened lengthen lengthens streamline streamlines streamlined enhance enhances enhanced unblock
    unblocks unblocked resolve resolves resolved solve solves solved repair repairs repaired restore restores restored
    efficient efficiently tuned tune tunes`),
  manner: list(`quick quickly fast snappy snappily instant instantly cheap cheaply smooth smoothly responsive slow slowly
    sluggish heavy heavily light lightly lean swift swiftly rapid rapidly speedy nimble brisk zippy laggy janky expensive
    costly lightweight heavyweight hefty bloated sleek`),
});

const CATEGORY_OF = new Map();
for (const [name, words] of Object.entries(WORD_CATEGORIES)) for (const w of words) if (!CATEGORY_OF.has(w)) CATEGORY_OF.set(w, name);

const SETS = Object.fromEntries(Object.entries(WORD_CATEGORIES).map(([k, v]) => [k, new Set(v)]));

/** Whether a word is in a category (a word can be in several). */
export const inCategory = (word, name) => Boolean(SETS[name] && SETS[name].has(String(word).toLowerCase()));

/** The first category a word belongs to, or null. */
export const categoryOf = (word) => CATEGORY_OF.get(String(word).toLowerCase()) ?? null;

/** The text as the checker reads it: NFKC. */
export const normalise = (s) => String(s).normalize('NFKC');

// -er and -est words a changelog line may hold: nouns and function words, not comparatives or superlatives.
const NOT_COMPARATIVE = new Set(list(`after another decoder driver framer ingest inter order owner per poller provider reader
  request scheduler server spawner steer subscriber together whatever worker writer user number other either whether
  never ever buffer header handler layer filter timer container cluster parameter register marker member folder browser
  renderer parser compiler controller listener sender receiver consumer producer publisher logger tracer sampler manager
  matter power river water test tests manifest digest interest rest suggest`));

/**
 * A changelog line the post may quote whole: no number of any kind; no word for a number, quantity, direction,
 * verdict, quality, effect (speeds, removes, fixes, optimal …) or manner (quick, cheap, smooth, lean …); and no
 * comparative or superlative (-er, -est),
 * apart from known nouns such as "reader". A quotation can then never read as a measurement or a cause.
 */
export function isQuotable(line) {
  const t = normalise(line);
  if (!t.trim() || /\p{N}/u.test(t) || /[\p{Cf}"“”]/u.test(t)) return false;
  return !(t.match(/\p{L}+/gu) || []).some((w) => {
    const x = w.toLowerCase();
    if (['number', 'quantity', 'direction', 'verdict', 'quality', 'effect', 'manner'].some((c) => inCategory(x, c))) return true;
    return /(?:er|est)$/.test(x) && !NOT_COMPARATIVE.has(x);
  });
}
