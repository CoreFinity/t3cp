// Red first: a metric id that is not in the catalogue (query string or path) leads to the catalogue
// index with a notice, never to an error page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './build/lib/app-vm.mjs';

const T = loadApp();
const ids = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8')).metrics.map(m => m.id);

test('a known id resolves to its own page', () => {
  assert.deepEqual(T.resolveMetric(ids, 'elu'), { ok: true, id: 'elu', href: '/metrics/elu/' });
});

test('an unknown id resolves to the catalogue index, carrying the id for the notice', () => {
  const r = T.resolveMetric(ids, 'no_such_metric');
  assert.equal(r.ok, false);
  assert.equal(r.href, '/metrics/?m=no_such_metric');
});

test('an id that could carry markup is encoded in the link and escaped in the notice', () => {
  const r = T.resolveMetric(ids, '"><script>x</script>');
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.href, /[<>"]/);
  const notice = T.metricNotice('"><script>x</script>');
  assert.doesNotMatch(notice, /<script>/);
  assert.match(notice, /&lt;script&gt;/);
  assert.match(notice, /not in the catalogue/);
});

test('the metric id is read from a /metrics/<id>/ path (the 404 page uses this)', () => {
  assert.equal(T.metricFromPath('/metrics/no_such_metric/'), 'no_such_metric');
  assert.equal(T.metricFromPath('/metrics/elu'), 'elu');
  assert.equal(T.metricFromPath('/metrics/'), null);
  assert.equal(T.metricFromPath('/about/'), null);
});
