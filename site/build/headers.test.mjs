// Red first: _headers is design Appendix C as written: one revalidating rule for every data file, immutable caching
// only for the content-hashed assets, no other rule, and no path that two specific rules match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { headers } from './build.mjs';
import { THEME_HASH } from './layout.mjs';

const CSP = `default-src 'none'; script-src 'self' ${THEME_HASH} https://plausible.io https://static.cloudflareinsights.com; connect-src 'self' https://plausible.io https://cloudflareinsights.com; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const APPENDIX_C = `/*
  x-content-type-options: nosniff
  referrer-policy: strict-origin-when-cross-origin
  permissions-policy: interest-cohort=()
  content-security-policy: ${CSP}
  cache-control: public, max-age=0, s-maxage=600, stale-while-revalidate=86400
/data/v1/*
  ! cache-control
  cache-control: public, max-age=300, s-maxage=1800, stale-while-revalidate=86400
/assets/*
  ! cache-control
  cache-control: public, max-age=31536000, immutable
`;

test('_headers is Appendix C as written', () => {
  assert.equal(headers({ analytics: {} }), APPENDIX_C);
});

test('nothing but the hashed assets is immutable', () => {
  const rules = headers({ analytics: {} }).split(/\n(?=\/)/);
  for (const r of rules) if (/immutable/.test(r)) assert.match(r, /^\/assets\/\*/);
});
