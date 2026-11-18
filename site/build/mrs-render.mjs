// The MRs page part: the HTML that goes inside <main> after the tagline, rendered at build time from
// data/v1/mrs.json (schema/mrs-2.json): the fork author's pull requests and issues on upstream, grouped Open, Merged or
// fixed, Closed. Pure and deterministic: the output depends only on the document.
// The page needs no script. Classes follow the approved mockup; the three inline styles of the mockup are
// classes here (mrs-links, mrs-t, mrs-foot) because the site's CSP has style-src 'self'; mrs-stale is the
// stale note.
import { AUTHOR, DISCUSSION_URL, ISSUE_QUERY, UPSTREAM } from './mrs.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const UPSTREAM_URL = `https://github.com/${UPSTREAM}`;
const ALL_BY_AUTHOR = `${UPSTREAM_URL}/pulls?q=is%3Apr+author%3A${AUTHOR}`;
const ISSUES_BY_AUTHOR = `${UPSTREAM_URL}/issues?q=is%3Aissue+author%3A${AUTHOR}`;

// "15 Nov 2026" from an ISO UTC timestamp (the UTC date).
export function formatDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// "x pull requests: a open, b merged, c closed. y issues: d open, e closed." from the file's counts (which include any
// left out of items); a list kept from before issues were read says so instead of counting none.
export function statusLine(doc) {
  const { pr, issue } = doc.counts;
  const prs = `${plural(pr.open + pr.merged + pr.closed, 'pull request', 'pull requests')}: ${pr.open} open, ${pr.merged} merged, ${pr.closed} closed.`;
  return doc.source_queries.includes(ISSUE_QUERY)
    ? `${prs} ${plural(issue.open + issue.closed, 'issue', 'issues')}: ${issue.open} open, ${issue.closed} closed.`
    : `${prs} Issues were not read for this list.`;
}

const HEADER = `<header class="page-h"><h1>MRs.</h1><p class="lede">Pull requests and issues to upstream. The fork's fixes go to <a href="${UPSTREAM_URL}">T3 Code</a> as pull requests; this list is read from GitHub at build time, nothing else.</p>
<div class="row mrs-links"><a class="btn btn-p" href="${DISCUSSION_URL}">The upstream discussion</a><a class="btn" href="${UPSTREAM_URL}/pulls">All pull requests on T3 Code</a></div></header>`;
const ABOUT = "Open, merged and closed pull requests, and open and closed issues, by the fork's author on the upstream repository, from the public GitHub API, refreshed at every site build.";
const THEAD = '<thead><tr><th>Item</th><th>Kind</th><th class="n">Number</th><th>Status</th><th class="hs">Last update</th></tr></thead>';

// Where an item goes and what its status says: a merged pull request and an issue closed as completed are "Merged or
// fixed"; a closed pull request and an issue closed otherwise are "Closed".
const GROUPS = ['Open', 'Merged or fixed', 'Closed'];
const groupOf = (item) => (item.state === 'open' ? 'Open' : item.state === 'merged' || item.closed_as === 'completed' ? 'Merged or fixed' : 'Closed');
const STATUS = { Open: ['open', 'open'], 'Merged or fixed': ['merged', 'merged'], Closed: ['closed', 'closed'] };
const status = (item) => (item.kind === 'issue' && item.closed_as === 'completed' ? ['merged', 'fixed'] : STATUS[groupOf(item)]);

const row = (item) => { const [cls, word] = status(item); return `<tr><td class="mrs-t"><a href="${esc(item.url)}">${esc(item.title)}</a></td>`
  + `<td>${item.kind === 'pr' ? 'PR' : 'issue'}</td>`
  + `<td class="n mut">#${esc(item.number)}</td>`
  + `<td><span class="st st-${cls}">${word}</span></td>`
  + `<td class="hs mut">${esc(formatDate(item.updated_at))}</td></tr>`; };

// doc: the parsed mrs.json, or null when the build has no file.
export function renderMrsPart(doc) {
  const out = [HEADER];
  if (!doc || doc.fetched_at == null) {
    const why = doc ? ': GitHub could not be read at this build.' : '.';
    out.push(`<p class="note mrs-stale" role="status">No list yet${why}</p>`);
    out.push(`<p class="note mrs-foot">${ABOUT}</p>`);
    return `${out.join('\n')}\n`;
  }
  if (doc.stale) {
    out.push(`<p class="note mrs-stale" role="status">GitHub could not be read at this build, so this is the list from ${esc(formatDate(doc.fetched_at))}.</p>`);
  }
  out.push(`<p class="count" id="mcount">${esc(statusLine(doc))}</p>`);
  if (doc.items.length > 0) {
    // The file is newest first; the page groups Open, Merged or fixed, Closed, newest first in each; no empty group.
    const rows = GROUPS.map((g) => [g, doc.items.filter((item) => groupOf(item) === g)]).filter(([, items]) => items.length)
      .map(([g, items]) => `<tr><th colspan="5" class="grp">${g}</th></tr>${items.map(row).join('')}`).join('');
    out.push(`<div class="tw"><table id="mrs">${THEAD}<tbody>${rows}</tbody></table></div>`);
  }
  if (doc.omitted > 0) {
    out.push(`<p class="note">${plural(doc.omitted, 'older item is', 'older items are')} not listed here; the full lists are on GitHub: <a href="${ALL_BY_AUTHOR}">pull requests</a>, <a href="${ISSUES_BY_AUTHOR}">issues</a>.</p>`);
  }
  const at = `${formatDate(doc.fetched_at)} at ${doc.fetched_at.slice(11, 16)} UTC`;
  out.push(`<p class="note mrs-foot">${ABOUT} Read from GitHub on ${esc(at)}.</p>`);
  return `${out.join('\n')}\n`;
}
