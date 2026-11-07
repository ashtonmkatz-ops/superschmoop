// (from the SwitchRecomp web builds, MZ Labs, AGPL-3.0)
// for static hosts that can't send headers: this service worker adds the cross-origin isolation headers
// (COOP/COEP) that SharedArrayBuffer, and so the game's threads, need. shell.js registers it and reloads once
// split builds (web/split_build.py, split.json): the game module comes in parts. joined here once into Cache Storage
// under its own URL, so the page and the runtime load it like the one-file build (streaming compile, and the browser
// keeps the compiled code: joined in the page and compiled from memory it started slow on every launch)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const COI = { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' };
let splitP = null;
const splitMap = () => splitP || (splitP = fetch(new URL('split.json', self.registration.scope), { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
async function splitWasm(url, e) {
  const name = 'swr-wasm-' + e.size;
  for (const k of await caches.keys()) if (k.startsWith('swr-wasm-') && k !== name) await caches.delete(k);   // an older build's
  const cache = await caches.open(name); const hit = await cache.match(url); if (hit) return hit;
  let i = 0, rd = null;
  const body = new ReadableStream({ async pull(c) {
    for (;;) {
      if (!rd) { if (i >= e.parts) { c.close(); return; }
        const r = await fetch(url + '.' + String(i++).padStart(3, '0')); if (!r.ok || !r.body) { c.error(new Error('part ' + (i - 1) + ': ' + r.status)); return; } rd = r.body.getReader(); }
      const x = await rd.read(); if (x.done) { rd = null; continue; } c.enqueue(x.value); return; } } });
  const [a, b] = body.tee(), h = Object.assign({ 'Content-Type': 'application/wasm', 'Content-Length': String(e.size) }, COI);
  cache.put(url, new Response(a, { headers: h })).catch(() => {});   // the next load (the runtime's) comes from there
  return new Response(b, { headers: h }); }
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  if (r.method === 'GET' && r.url.endsWith('.wasm')) {
    e.respondWith(splitMap().then((m) => { const rel = decodeURIComponent(new URL(r.url).pathname.slice(new URL(self.registration.scope).pathname.length));
      return m[rel] ? splitWasm(r.url, m[rel]) : fetch(r); }));   // one file: as it comes (same origin needs no CORP; a copy would lose the code cache)
    return; }
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch((err) => { console.error(err); throw err; }));
});
