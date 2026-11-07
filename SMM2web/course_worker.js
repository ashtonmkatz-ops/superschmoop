// The course server in the page (web-build/core-web crates/web: the project's mmk-server built for the browser). The page sends it
// each of the game's requests; courses come from TGRCode straight from here. Its files live in the browser's IndexedDB, saved
// every few seconds, so a static host needs nothing but the files.
'use strict';
if (self.name === 'em-pthread') importScripts('mmk.js');   // (the server's threads start from this file too: they only need the module)
else {
let ready = null;
const started = new Promise((res) => { ready = res; });
self.Module = {
  mainScriptUrlOrBlob: 'mmk.js',
  print: (s) => postMessage({ log: s }), printErr: (s) => postMessage({ log: s }),
  onRuntimeInitialized: () => ready(),
};
self.addEventListener('error', (e) => postMessage({ log: 'error: ' + e.message }));
self.addEventListener('unhandledrejection', (e) => postMessage({ log: 'error: ' + (e.reason && e.reason.message || e.reason) }));
try { importScripts('mmk.js'); } catch (e) { postMessage({ log: 'load failed: ' + e.message }); }

const utf = (s) => { const n = Module.lengthBytesUTF8(s) + 1, p = Module._malloc(n); Module.stringToUTF8(s, p, n); return p; };
async function start(main) {
  await started;
  const FS = Module.FS;
  FS.mkdir('/srv'); FS.mount(FS.filesystems.IDBFS, {}, '/srv');
  await new Promise((r) => FS.syncfs(true, () => r()));
  const m = Module._malloc(main.length);
  Module.HEAPU8.set(main, m);
  const dir = utf('/srv'), t = Module._mmk_web_start(dir, m, main.length);
  Module._free(dir); Module._free(m);
  setInterval(() => FS.syncfs(false, () => {}), 10000);
  return t ? Module.UTF8ToString(t) : '';
}
function answer(q) {
  const body = q.body || new Uint8Array(0), b = Module._malloc(body.length + 1), out = Module._malloc(8), ct = Module._malloc(64);
  Module.HEAPU8.set(body, b);
  const me = utf(q.method), url = utf(q.url), auth = utf(q.auth || '');
  const p = Module._mmk_web_handle(me, url, auth, b, body.length, out, ct);
  const n = Module.HEAPU32[out >> 2], status = Module.HEAPU32[(out >> 2) + 1], type = Module.UTF8ToString(ct);
  const bytes = Module.HEAPU8.slice(p, p + n);
  Module._mmk_web_free(p, n);
  for (const x of [b, out, ct, me, url, auth]) Module._free(x);
  return { id: q.id, status, type, bytes };
}
self.onmessage = async (e) => {
  const q = e.data;
  if (q.main) { postMessage({ token: await start(q.main) }); return; }
  await started;
  const r = answer(q);
  postMessage(r, [r.bytes.buffer]);
};
}
