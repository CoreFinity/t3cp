// The MRs page part: the HTML that goes inside <main> after the tagline, rendered at build time from
// data/v1/mrs.json (schema/mrs-1.json). Pure and deterministic: the output depends only on the document.
// The page needs no script. Classes follow the approved mockup; the three inline styles of the mockup are
// classes here (mrs-links, mrs-t, mrs-foot) because the site's CSP has style-src 'self'; mrs-stale is the
// stale note.
import { AUTHOR, DISCUSSION_URL, UPSTREAM } from './mrs.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const UPSTREAM_URL = `https://github.com/${UPSTREAM}`;
const ALL_BY_AUTHOR = `${UPSTREAM_URL}/pulls?q=is%3Apr+author%3A${AUTHOR}`;

// "15 Nov 2026" from an ISO UTC timestamp (the UTC date).
export function formatDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// "x pull requests: a open, b merged, c closed." from the file's counts (which include any left out of items).
export function statusLine(doc) {
  const { open, merged, closed } = doc.counts;
  return `${plural(open + merged + closed, 'pull request', 'pull requests')}: ${open} open, ${merged} merged, ${closed} closed.`;
}

const HEADER = `<header class="page-h"><h1>MRs.</h1><p class="lede">Pull requests to upstream. The fork's fixes go to <a href="${UPSTREAM_URL}">T3 Code</a> as pull requests; this list is read from GitHub at build time, nothing else.</p>
<div class="row mrs-links"><a class="btn btn-p" href="${DISCUSSION_URL}">The upstream discussion</a><a class="btn" href="${UPSTREAM_URL}/pulls">All pull requests on T3 Code</a></div></header>`;
const ABOUT = "Open, merged and closed pull requests by the fork's author on the upstream repository, from the public GitHub API, refreshed at every site build.";
const STATE_ORDER = ['open', 'merged', 'closed'];
const THEAD = '<thead><tr><th>Pull request</th><th class="n">Number</th><th>Status</th><th class="hs">Last update</th></tr></thead>';

const row = (item) => `<tr><td class="mrs-t"><a href="${esc(item.url)}">${esc(item.title)}</a></td>`
  + `<td class="n mut">#${esc(item.number)}</td>`
  + `<td><span class="st st-${esc(item.state)}">${esc(item.state)}</span></td>`
  + `<td class="hs mut">${esc(formatDate(item.updated_at))}</td></tr>`;

// doc: the parsed mrs.json, or null when the build has no file.
export function renderMrsPart(doc) {
  const out = [HEADER];
  if (!doc || doc.fetched_at == null) {
    const why = doc ? ': GitHub could not be read at this build.' : '.';
    out.push(`<p class="note mrs-stale" role="status">No pull request list yet${why}</p>`);
    out.push(`<p class="note mrs-foot">${ABOUT}</p>`);
    return `${out.join('\n')}\n`;
  }
  if (doc.stale) {
    out.push(`<p class="note mrs-stale" role="status">GitHub could not be read at this build, so this is the list from ${esc(formatDate(doc.fetched_at))}.</p>`);
  }
  out.push(`<p class="count" id="mcount">${esc(statusLine(doc))}</p>`);
  if (doc.items.length > 0) {
    // The file is newest first; the page groups open, merged, closed (the mockup's order), newest first in each.
    const rows = STATE_ORDER.flatMap((state) => doc.items.filter((item) => item.state === state)).map(row).join('');
    out.push(`<div class="tw"><table id="mrs">${THEAD}<tbody>${rows}</tbody></table></div>`);
  }
  if (doc.omitted > 0) {
    out.push(`<p class="note">${plural(doc.omitted, 'older pull request is', 'older pull requests are')} not listed here; <a href="${ALL_BY_AUTHOR}">the full list is on GitHub</a>.</p>`);
  }
  const at = `${formatDate(doc.fetched_at)} at ${doc.fetched_at.slice(11, 16)} UTC`;
  out.push(`<p class="note mrs-foot">${ABOUT} Read from GitHub on ${esc(at)}.</p>`);
  return `${out.join('\n')}\n`;
}
