// Loads site/app.js in Node behind a minimal DOM shim, so the build renders its static tables with the browser's
// own functions and the tests exercise the real renderer. app.js reaches the page only through the `window` and
// `document` it is handed, so it runs here in the caller's realm (plain objects compare equal in tests). No dependency.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_PATH = fileURLToPath(new URL('../../app.js', import.meta.url));

function element() {
  return {
    dataset: {}, style: {}, hidden: false, innerHTML: '', textContent: '', clientWidth: 0, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, addEventListener() {}, appendChild() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
  };
}

// storage: 'blocked' throws on every access (a browser with site data blocked), 'empty' is a working empty store.
export function loadApp({ source, storage = 'empty', search = '', pathname = '/' } = {}) {
  const code = source ?? readFileSync(APP_PATH, 'utf8');
  const mem = new Map();
  const store = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const document = {
    body: element(), documentElement: element(), title: '', activeElement: null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    createElement: element, createElementNS: element, getElementById: () => null,
  };
  const errors = [];
  const window = {
    document, location: { search, pathname, hash: '', href: pathname + search, origin: 'https://t3cp.io', replace() {} },
    history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollY: 0,
    console: { log() {}, warn() {}, info() {}, error: (...a) => errors.push(a.join(' ')) },
  };
  Object.defineProperty(window, 'localStorage', { get() { if (storage === 'blocked') throw new Error('SecurityError: storage blocked'); return store; } });
  new Function('window', 'document', code)(window, document);
  const T = window.T3CP;
  if (!T) throw new Error('app.js did not define window.T3CP');
  return Object.assign(T, { __errors: errors, __window: window });
}
