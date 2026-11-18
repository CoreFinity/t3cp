// The publish build's own _headers gate: dist/_headers must be design Appendix C as written (one revalidating rule
// for every data file, immutable caching for the hashed assets only). `node site/build/check-headers.mjs <dist>`
// exits 1 and prints the first difference on any drift.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_HASH } from './layout.mjs';

// Appendix C, with the theme bootstrap's hash.
export function appendixC() {
  return `/*
  x-content-type-options: nosniff
  referrer-policy: strict-origin-when-cross-origin
  permissions-policy: interest-cohort=()
  content-security-policy: default-src 'none'; script-src 'self' ${THEME_HASH} https://plausible.io https://static.cloudflareinsights.com; connect-src 'self' https://plausible.io https://cloudflareinsights.com; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  cache-control: public, max-age=0, s-maxage=600, stale-while-revalidate=86400
/data/v1/*
  ! cache-control
  cache-control: public, max-age=300, s-maxage=1800, stale-while-revalidate=86400
/assets/*
  ! cache-control
  cache-control: public, max-age=31536000, immutable
`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const dist = process.argv[2];
  if (!dist) { console.error('usage: node site/build/check-headers.mjs <dist>'); process.exit(2); }
  const want = appendixC().split('\n'), got = readFileSync(join(dist, '_headers'), 'utf8').split('\n');
  const i = want.findIndex((l, k) => l !== got[k]);
  if (i >= 0 || got.length !== want.length) {
    const at = i >= 0 ? i : Math.min(want.length, got.length);
    console.error(`_headers drifted from Appendix C at line ${at + 1}:\n  want: ${want[at] ?? '(end)'}\n  got:  ${got[at] ?? '(end)'}`);
    process.exit(1);
  }
  console.log('_headers matches Appendix C');
}
