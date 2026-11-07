// The page around the wasm build (the same start screen as the SwitchRecomp web builds): checks the browser, copies
// the packed game files (gamedata/*.data) into the origin private file system on the first start (the runtime mounts
// it, web/entry.c), starts the module, sends it keyboard / mouse / touch events and the gamepads' state through WebIn
// in the shared linear memory (web/web.h), plays its audio rings with an AudioWorklet and shows the frames the render
// thread sends.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let game = { title: 'Super Mario Maker 2', script: 'Super Mario Maker 2.js' };
  let running = false;

  // ------------------------------------------------------------------ cross-origin isolation (SharedArrayBuffer)
  // a server that sends COOP/COEP (serve.py) needs nothing; elsewhere coi-sw.js adds the headers and we reload once
  if (!window.crossOriginIsolated && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('coi-sw.js').then((r) => {
      if (!navigator.serviceWorker.controller && !sessionStorage.getItem('smm-coi-reload')) { sessionStorage.setItem('smm-coi-reload', '1'); location.reload(); }
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ browser checks
  const MEM64 = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);   // (memory i64 1)
  function checks() {
    const r = [];
    const add = (ok, text, fix) => r.push({ ok, text: ok ? text : text + (fix ? ' — ' + fix : '') });
    add(window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined', 'Threads (SharedArrayBuffer)', 'serve the page with serve.py (COOP/COEP headers), or reload once');
    let m64 = false; try { m64 = WebAssembly.validate(MEM64); } catch (e) {}
    add(m64, '64-bit WebAssembly memory (memory64)', 'needs Chrome / Edge 133+ or Firefox 134+');
    add(!!(navigator.storage && navigator.storage.getDirectory), 'Private file storage (OPFS)');
    add(!!navigator.gpu, 'WebGPU', 'needs Chrome / Edge 113+ (or Safari 26 / Firefox 141+ where WebGPU is on)');
    add(typeof AudioWorkletNode !== 'undefined', 'Audio (AudioWorklet)');
    const ul = $('checks'); ul.innerHTML = '';
    for (const c of r) { const li = document.createElement('li'); li.className = c.ok ? 'ok' : 'bad'; li.textContent = c.text; ul.appendChild(li); }
    return r[0].ok && r[1].ok && r[2].ok && r[3].ok;
  }

  // ------------------------------------------------------------------ game data in OPFS
  const dataDir = () => game.title + '_data';
  async function opfs() { return navigator.storage.getDirectory(); }
  async function dirAt(root, parts, create) { let d = root; for (const p of parts) d = await d.getDirectoryHandle(p, { create }); return d; }
  async function exists(root, parts) { try { await dirAt(root, parts, false); return true; } catch (e) { return false; } }
  let dataMarker = null;
  async function dataState() {
    try {
      const root = await opfs();
      const ok = await exists(root, [dataDir(), 'extracted', 'exefs']) && await exists(root, [dataDir(), 'extracted', 'romfs']);
      let marker = null; try { const f = await (await (await dirAt(root, [dataDir()], false)).getFileHandle('.imported')).getFile(); marker = JSON.parse(await f.text()); } catch (e) {}
      let est = ''; try { const e = await navigator.storage.estimate(); est = ' · storage used ' + (e.usage / 1073741824).toFixed(1) + ' GB of ' + (e.quota / 1073741824).toFixed(0) + ' GB'; } catch (e) {}
      $('datastate').textContent = ok && marker ? 'Imported: ' + marker.files + ' files, ' + (marker.bytes / 1073741824).toFixed(2) + ' GB' + est : 'Not imported yet' + est;
      dataMarker = ok ? marker : null;
      return ok && !!marker;
    } catch (e) { $('datastate').textContent = 'Private storage unavailable: ' + e.message; return false; }
  }

  // ------------------------------------------------------------------ files split into parts (hosts with a size cap per file)
  // split.json lists those files, name.000, name.001, ... are their parts in order. sfetch gives one Response streaming the
  // parts back to back; without split.json it's a plain fetch
  let SPLIT = null;
  async function splitMap() { if (SPLIT) return SPLIT;
    try { const r = await fetch('split.json', { cache: 'no-cache' }); SPLIT = r.ok ? await r.json() : {}; } catch (e) { SPLIT = {}; } return SPLIT; }
  async function sfetch(url, type) {
    const m = await splitMap(), e = m[decodeURIComponent(url)];
    if (!e) return fetch(url);
    let i = 0, rd = null;
    const body = new ReadableStream({ async pull(c) {
      for (;;) {
        if (!rd) { if (i >= e.parts) { c.close(); return; }
          const r = await fetch(url + '.' + String(i++).padStart(3, '0')); if (!r.ok || !r.body) { c.error(new Error(url + ' part ' + (i - 1) + ': ' + r.status)); return; } rd = r.body.getReader(); }
        const x = await rd.read(); if (x.done) { rd = null; continue; } c.enqueue(x.value); return; } } });
    const h = { 'Content-Length': String(e.size) }; if (type) h['Content-Type'] = type;
    return new Response(body, { headers: h }); }

  // ------------------------------------------------------------------ start screen: one bar, then the play button
  // the bar: the game files setup (first visit, up to BAR_DATA) then the game module's download (the rest)
  const BAR_DATA = 0.85;
  let wasmBuf = null;   // the module's bytes when they came in parts
  function bar(f) { const b = $('bar'); b.classList.remove('busy'); $('barfill').style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%'; }
  function ready() { $('bar').style.display = 'none'; $('importmsg').textContent = ''; $('start').style.display = 'block'; $('start').disabled = false; $('start').focus(); }
  // the module (.wasm, the big one) into the browser's cache now, so the play button starts right away
  async function prefetchModule(from) {
    const url = game.script.replace(/\.js$/, '.wasm');
    if (Object.keys(await splitMap()).length && !(navigator.serviceWorker && navigator.serviceWorker.controller)) { wasmBuf = await (async () => {
      const r = await sfetch(url), total = +r.headers.get('content-length') || 0, out = new Uint8Array(total), rd = r.body.getReader(); let got = 0;
      for (;;) { const c = await rd.read(); if (c.done) break; out.set(c.value, got); got += c.value.length;
        bar(from + (1 - from) * got / (total || 1)); $('importmsg').textContent = 'Loading the game · ' + (got / 1048576).toFixed(0) + ' / ' + (total / 1048576).toFixed(0) + ' MB'; }
      return out; })(); bar(1); return; }
    try { const r = await fetch(url); if (!r.ok || !r.body) return;
      const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(); let got = 0;
      for (;;) { const c = await rd.read(); if (c.done) break; got += c.value.length;
        if (total) { bar(from + (1 - from) * got / total); $('importmsg').textContent = 'Loading the game · ' + (got / 1048576).toFixed(0) + ' / ' + (total / 1048576).toFixed(0) + ' MB'; } }
    } catch (e) {}
    bar(1); }

  // ------------------------------------------------------------------ game data that came with the build
  // gamedata/manifest.json + game_NN.data (web-build/pack_data.py): the files back to back. copied into the private
  // storage on the first start, and again when the build brings other data. the saves already there are kept
  async function packedManifest() {
    try { const r = await fetch('gamedata/manifest.json', { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (e) {}
    return null;
  }
  async function importPacked(man) {
    const root = await opfs(); const base = await dirAt(root, [dataDir()], true);
    try { await navigator.storage.persist(); } catch (e) {}
    const total = man.parts.reduce((a, p) => a + p.size, 0);
    let done = 0, n = 0; const prog = $('prog'); prog.max = total || 1; const t0 = performance.now();
    const show = () => { const s = (performance.now() - t0) / 1000; prog.value = done; bar(done / (total || 1) * BAR_DATA);
      $('importmsg').textContent = 'Setting up the game files (first time only) · ' + (done / 1073741824).toFixed(2) + ' / ' + (total / 1073741824).toFixed(2) + ' GB' +
        (s > 1 ? ' · ' + (done / 1048576 / s).toFixed(0) + ' MB/s' : ''); };
    for (let pi = 0; pi < man.parts.length; pi++) {
      const list = man.files.filter((f) => f[1] === pi).sort((a, b) => a[2] - b[2]);
      const res = await sfetch('gamedata/' + man.parts[pi].name);
      if (!res.ok || !res.body) throw new Error('gamedata/' + man.parts[pi].name + ': ' + res.status);
      const rd = res.body.getReader(); let buf = null, bo = 0, pos = 0;
      const take = async (len, sink) => {   // the next len bytes of the part, to sink (or skipped)
        while (len > 0) {
          if (!buf || bo >= buf.length) { const r = await rd.read(); if (r.done) throw new Error(man.parts[pi].name + ' ends early'); buf = r.value; bo = 0; }
          const k = Math.min(len, buf.length - bo); if (sink) await sink(buf.subarray(bo, bo + k));
          bo += k; len -= k; pos += k; done += k;
        }
      };
      for (const [rel, , off, size] of list) {
        if (off > pos) await take(off - pos, null);
        const parts = rel.split('/'); const d = await dirAt(base, parts.slice(0, -1), true); const name = parts[parts.length - 1];
        let skip = false; try { const old = await (await d.getFileHandle(name)).getFile(); skip = old.size === size && dataMarker && dataMarker.id === man.id; } catch (e) {}
        if (skip) await take(size, null);
        else { const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await take(size, (c) => w.write(c)); await w.close(); }
        n++; if (n % 25 === 0) show();
      }
      try { await rd.cancel(); } catch (e) {}
    }
    show();
    const mw = await (await base.getFileHandle('.imported', { create: true })).createWritable();
    await mw.write(JSON.stringify({ files: man.files.length, bytes: total, when: Date.now(), id: man.id })); await mw.close();
    $('importmsg').textContent = 'Game files ready.';
  }

  // a picked folder (the desktop SMM2Recomp folder: extracted/, fonts/, sysdata/, mods-generated/) when the build has no gamedata
  async function* walkHandle(dir, path) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') yield* walkHandle(h, path.concat(name)); else yield { path: path.concat(name), file: () => h.getFile() };
    }
  }
  function* walkList(list) { for (const f of list) { const p = (f.webkitRelativePath || f.name).split('/'); p.shift(); yield { path: p, file: async () => f }; } }
  const KEEP = ['extracted', 'fonts', 'sysdata', 'mods-generated'];
  async function importFrom(entries) {
    const items = [];
    for await (const e of entries) {
      const i = e.path.findIndex((s) => KEEP.includes(s));
      if (i < 0 || i === e.path.length - 1) continue;
      if (e.path[i] === 'extracted' && !['exefs', 'romfs', 'setup.json'].includes(e.path[i + 1])) continue;   // (not the desktop game code)
      items.push({ rel: e.path.slice(i), file: e.file });
    }
    if (!items.some((x) => x.rel[1] === 'exefs') || !items.some((x) => x.rel[1] === 'romfs'))
      throw new Error('that folder has no extracted/exefs and extracted/romfs inside (pick the SMM2Recomp folder after its setup ran)');
    const root = await opfs(); const base = await dirAt(root, [dataDir()], true);
    try { await navigator.storage.persist(); } catch (e) {}
    const files = await Promise.all(items.map(async (x) => ({ rel: x.rel, f: await x.file() })));
    const total = files.reduce((a, x) => a + x.f.size, 0);
    let done = 0, n = 0; const t0 = performance.now();
    for (const x of files) {
      const d = await dirAt(base, x.rel.slice(0, -1), true); const name = x.rel[x.rel.length - 1];
      let skip = false; try { const old = await (await d.getFileHandle(name)).getFile(); skip = old.size === x.f.size; } catch (e) {}
      if (!skip) { const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await x.f.stream().pipeTo(w); }
      done += x.f.size; n++; bar(done / (total || 1) * BAR_DATA);
      if (n % 20 === 0 || n === files.length) {
        const s = (performance.now() - t0) / 1000;
        $('importmsg').textContent = 'Copying ' + n + ' / ' + files.length + ' files, ' + (done / 1073741824).toFixed(2) + ' / ' + (total / 1073741824).toFixed(2) + ' GB' + (s > 1 ? ' (' + (done / 1048576 / s).toFixed(0) + ' MB/s)' : '');
      }
    }
    const mw = await (await base.getFileHandle('.imported', { create: true })).createWritable();
    await mw.write(JSON.stringify({ files: files.length, bytes: total, when: Date.now() })); await mw.close();
    $('importmsg').textContent = 'Done: ' + files.length + ' files.';
  }
  $('pick').onclick = async () => {
    try {
      $('pick').disabled = true;
      if (window.showDirectoryPicker) { const d = await window.showDirectoryPicker({ id: 'smm2-game', mode: 'read' }); await importFrom(walkHandle(d, [])); }
      else {
        const inp = document.createElement('input'); inp.type = 'file'; inp.webkitdirectory = true;
        const list = await new Promise((res) => { inp.onchange = () => res(inp.files); inp.click(); });
        await importFrom((async function* () { yield* walkList(list); })());
      }
    } catch (e) { if (e.name !== 'AbortError') $('importmsg').textContent = 'Import failed: ' + e.message; }
    finally { $('pick').disabled = false;
      if (await dataState() && checks()) { $('pick').style.display = 'none'; await prefetchModule(BAR_DATA); ready(); } }
  };
  $('wipe').onclick = async () => {
    if (!confirm('Remove the imported game data (and its saves) from this browser?')) return;
    try { await (await opfs()).removeEntry(dataDir(), { recursive: true }); } catch (e) {}
    await dataState(); $('start').disabled = true;
  };

  // ------------------------------------------------------------------ log panel
  const logEl = $('log'); let logLines = [];
  function logAdd(s) { logLines.push(s); if (logLines.length > 800) logLines = logLines.slice(-500); if (logEl.style.display === 'block') { logEl.textContent = logLines.join('\n'); logEl.scrollTop = 1e9; } }
  function toggleLog() { const on = logEl.style.display !== 'block'; logEl.style.display = on ? 'block' : 'none'; if (on) { logEl.textContent = logLines.join('\n'); logEl.scrollTop = 1e9; } }
  $('showlog').onclick = toggleLog;
  let showFps = false; $('showfps').onclick = () => { showFps = !showFps; ws.fps = showFps ? 1 : 0; wsSave(); $('fpsbox').style.display = showFps ? 'block' : 'none'; };

  // ------------------------------------------------------------------ input: WebIn (web/web.h)
  // words: 0 seq, 1 ev_wr, 2 ev_rd, 3 out_w, 4 out_h, 5 css_w, 6 css_h, 7 focus, 8 presented, 9 quit, 10 display hz, 11 flags,
  // 12..15 pad id, 16..19 pad buttons, 20..23 pad type, 24..35 pad axes (i16 [4][6]), 64..127 pad names, 128.. events (8 words each)
  let inPtr = 0;
  const NEV = 256;
  const W32 = () => new Int32Array(Module.wasmMemory.buffer), F32 = () => new Float32Array(Module.wasmMemory.buffer);
  function pushEv(type, a, b, x, y, dx, dy) {
    if (!inPtr) return;
    const I = W32(), F = F32(), w = inPtr >> 2;
    const wr = Atomics.load(I, w + 1) >>> 0, rd = Atomics.load(I, w + 2) >>> 0;
    if (((wr - rd) >>> 0) >= NEV) return;   // (full: the runtime hasn't looked for a while)
    const e = w + 128 + (wr % NEV) * 8;
    I[e] = type; I[e + 1] = a | 0; I[e + 2] = b | 0; I[e + 3] = 0; F[e + 4] = x || 0; F[e + 5] = y || 0; F[e + 6] = dx || 0; F[e + 7] = dy || 0;
    Atomics.store(I, w + 1, (wr + 1) | 0);
  }
  const EV = { KEY_DOWN: 1, KEY_UP: 2, TEXT: 3, MOUSE_MOVE: 4, MOUSE_DOWN: 5, MOUSE_UP: 6, WHEEL: 7, FINGER_DOWN: 8, FINGER_UP: 9, FINGER_MOVE: 10, FINGER_CANCEL: 11 };
  // KeyboardEvent.code -> USB HID scancode (SDL's): the physical key, so WASD is ZQSD on an AZERTY keyboard
  const SC = {};
  for (let i = 0; i < 26; i++) SC['Key' + String.fromCharCode(65 + i)] = 4 + i;
  for (let i = 1; i <= 9; i++) SC['Digit' + i] = 29 + i; SC.Digit0 = 39;
  for (let i = 1; i <= 12; i++) SC['F' + i] = 57 + i;
  for (let i = 1; i <= 9; i++) SC['Numpad' + i] = 88 + i; SC.Numpad0 = 98;
  Object.assign(SC, { Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49,
    Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73,
    Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84,
    NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, NumpadDecimal: 99, ControlLeft: 224, ShiftLeft: 225, AltLeft: 226,
    MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231 });
  const mods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 0x40 : 0) | (e.altKey ? 0x100 : 0);
  window.addEventListener('keydown', (e) => {
    if (!running) return;
    if (e.code === 'F11') { e.preventDefault(); fullscreen(); return; }
    if (e.code === 'F9' && e.shiftKey) { e.preventDefault(); toggleLog(); return; }
    const sc = SC[e.code]; if (sc === undefined) return;
    if (!(e.ctrlKey && (e.code === 'KeyR' || e.code === 'KeyW'))) e.preventDefault();
    pushEv(EV.KEY_DOWN, sc, mods(e) | (e.repeat ? 1 << 16 : 0));
    if (e.key && e.key.length === 1 && !e.ctrlKey) pushEv(EV.TEXT, e.key.codePointAt(0), 0);
  });
  window.addEventListener('keyup', (e) => { const sc = SC[e.code]; if (sc !== undefined && running) pushEv(EV.KEY_UP, sc, mods(e)); });
  window.addEventListener('blur', () => { if (running) for (const k in SC) pushEv(EV.KEY_UP, SC[k], 0); });

  // the mouse on the picture is a finger on the console's touch screen (the Course Maker); touches are fingers
  const scr = $('screen');
  const rel = (e) => { const r = scr.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, r.width, r.height]; };
  let mbuttons = 0;
  scr.addEventListener('mousedown', (e) => { if (!running) return; scr.focus(); const [x, y] = rel(e); mbuttons |= 1 << e.button; pushEv(EV.MOUSE_DOWN, e.button === 0 ? 1 : e.button === 2 ? 3 : 2, 0, x, y); });
  window.addEventListener('mouseup', (e) => { if (!running) return; const [x, y] = rel(e); mbuttons &= ~(1 << e.button); pushEv(EV.MOUSE_UP, e.button === 0 ? 1 : e.button === 2 ? 3 : 2, 0, x, y); });
  scr.addEventListener('mousemove', (e) => { if (!running) return; const [x, y] = rel(e); pushEv(EV.MOUSE_MOVE, (mbuttons & 1 ? 1 : 0) | (mbuttons & 4 ? 4 : 0), 0, x, y, e.movementX, e.movementY); });
  scr.addEventListener('wheel', (e) => { if (!running) return; e.preventDefault(); const [x, y] = rel(e); pushEv(EV.WHEEL, 0, 0, x, y, -Math.sign(e.deltaX), -Math.sign(e.deltaY)); }, { passive: false });
  scr.addEventListener('contextmenu', (e) => e.preventDefault());
  const fingers = new Map(); let nextFinger = 1;
  const touchEv = (type) => (e) => {
    if (!running) return; e.preventDefault();
    for (const t of e.changedTouches) {
      const [x, y, w, h] = rel(t);
      if (type === EV.FINGER_DOWN) fingers.set(t.identifier, nextFinger++);
      const id = fingers.get(t.identifier); if (id === undefined) continue;
      pushEv(type, id, 0, x / (w || 1), y / (h || 1));
      if (type === EV.FINGER_UP || type === EV.FINGER_CANCEL) fingers.delete(t.identifier);
    }
  };
  scr.addEventListener('touchstart', touchEv(EV.FINGER_DOWN), { passive: false });
  scr.addEventListener('touchmove', touchEv(EV.FINGER_MOVE), { passive: false });
  scr.addEventListener('touchend', touchEv(EV.FINGER_UP), { passive: false });
  scr.addEventListener('touchcancel', touchEv(EV.FINGER_CANCEL), { passive: false });

  // gamepads: the standard mapping -> SDL_GamepadButton bits / axes (SDL ranges)
  const PADB = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 9], [5, 10], [8, 4], [9, 6], [10, 7], [11, 8], [12, 11], [13, 12], [14, 13], [15, 14], [16, 5]];
  const padIds = [0, 0, 0, 0]; let padSerial = 1;
  const dz = (v) => Math.abs(v) < ws.deadzone ? 0 : v;
  function padsTick(I, w) {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let s = 0; s < 4; s++) {
      if (s === 3 && touchPad.on) continue;   // (the on-screen pad's slot: touchPadTick)
      const p = list[s];
      if (!p || !p.connected) { if (padIds[s]) { padIds[s] = 0; Atomics.store(I, w + 12 + s, 0); } continue; }
      if (!padIds[s] || padIds[s].pad !== p.id) {
        padIds[s] = { id: padSerial++, pad: p.id };
        const nm = new TextEncoder().encode(p.id.slice(0, 60)), u8 = new Uint8Array(Module.wasmMemory.buffer, inPtr + 256 + s * 64, 64);
        u8.fill(0); u8.set(nm);
        const lid = p.id.toLowerCase();
        I[w + 20 + s] = /xbox|xinput|045e/.test(lid) ? 3 : /054c|playstation|dualsense|dualshock/.test(lid) ? (/dualsense|0ce6/.test(lid) ? 6 : 5) : /057e|nintendo|pro controller/.test(lid) ? 7 : 1;
        Atomics.store(I, w + 12 + s, padIds[s].id);
      }
      let b = 0;
      for (const [i, bit] of PADB) if (p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5)) b |= 1 << bit;
      if (ws.padlayout === 'xbox') b = (b & ~15) | ((b & 1) << 1) | ((b & 2) >> 1) | ((b & 4) << 1) | ((b & 8) >> 1);   // (A / B and X / Y where the pad's labels say)
      I[w + 16 + s] = b;
      const ax = new Int16Array(Module.wasmMemory.buffer, inPtr + 96 + s * 12, 6);
      ax[0] = Math.round(dz(p.axes[0] || 0) * 32767); ax[1] = Math.round(dz(p.axes[1] || 0) * 32767);
      ax[2] = Math.round(dz(p.axes[2] || 0) * 32767); ax[3] = Math.round(dz(p.axes[3] || 0) * 32767);
      ax[4] = Math.round((p.buttons[6] ? p.buttons[6].value : 0) * 32767); ax[5] = Math.round((p.buttons[7] ? p.buttons[7].value : 0) * 32767);
    }
  }

  // on-screen controls on touch screens: a stick at the left, the Switch buttons; the rest of the picture is the touch screen
  const touchPad = { lx: 0, ly: 0, bits: 0, stick: null, on: false };
  const TBTN = [
    { b: 1, t: 'A', r: 18, bt: 84 }, { b: 0, t: 'B', r: 84, bt: 22 }, { b: 3, t: 'X', r: 84, bt: 146 }, { b: 2, t: 'Y', r: 150, bt: 84 },
    { b: 10, t: 'R', r: 18, tp: 64, sm: 1 }, { b: 9, t: 'L', l: 18, tp: 64, sm: 1 }, { b: 6, t: '+', r: 80, tp: 64, sm: 1 }, { b: 4, t: '−', l: 80, tp: 64, sm: 1 },
  ];
  function buildTouch() {
    const root = $('touch'); if (root.dataset.built) return; root.dataset.built = '1';
    for (const d of TBTN) {
      const el = document.createElement('div'); el.className = 'tbtn' + (d.sm ? ' sm' : ''); el.textContent = d.t;
      if (d.r !== undefined) el.style.right = d.r + 'px'; if (d.l !== undefined) el.style.left = d.l + 'px';
      if (d.bt !== undefined) el.style.bottom = d.bt + 'px'; if (d.tp !== undefined) el.style.top = d.tp + 'px';
      const bit = 1 << d.b;
      const down = (e) => { e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); el.classList.add('down'); touchPad.bits |= bit; if (navigator.vibrate) navigator.vibrate(8); };
      const up = (e) => { e.preventDefault(); el.classList.remove('down'); touchPad.bits &= ~bit; };
      el.addEventListener('pointerdown', down); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      root.appendChild(el);
    }
    const zone = $('t-stick'), base = $('t-base'), knob = $('t-knob');
    zone.addEventListener('pointerdown', (e) => { e.preventDefault(); zone.setPointerCapture(e.pointerId);
      touchPad.stick = { id: e.pointerId, cx: e.clientX, cy: e.clientY };
      base.style.left = e.clientX + 'px'; base.style.top = e.clientY + 'px'; base.style.display = 'block'; knob.style.transform = ''; });
    zone.addEventListener('pointermove', (e) => { const s = touchPad.stick; if (!s || s.id !== e.pointerId) return;
      let dx = (e.clientX - s.cx) / 60, dy = (e.clientY - s.cy) / 60; const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
      touchPad.lx = Math.round(dx * 32767); touchPad.ly = Math.round(dy * 32767); knob.style.transform = 'translate(' + dx * 36 + 'px,' + dy * 36 + 'px)'; });
    const end = (e) => { if (touchPad.stick && touchPad.stick.id === e.pointerId) { touchPad.stick = null; touchPad.lx = touchPad.ly = 0; base.style.display = 'none'; } };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  }
  // the on-screen pad goes to slot 3 when nothing else is there
  function touchPadTick(I, w) {
    if (!touchPad.on) return;
    const s = 3;
    if (!padIds[s] || padIds[s].pad !== 'touch') {
      padIds[s] = { id: padSerial++, pad: 'touch' };
      new Uint8Array(Module.wasmMemory.buffer, inPtr + 256 + s * 64, 64).set(new TextEncoder().encode('On-screen controller'));
      I[w + 20 + s] = 7; Atomics.store(I, w + 12 + s, padIds[s].id);
    }
    I[w + 16 + s] = touchPad.bits;
    const ax = new Int16Array(Module.wasmMemory.buffer, inPtr + 96 + s * 12, 6); ax[0] = touchPad.lx; ax[1] = touchPad.ly;
  }
  const isTouch = () => matchMedia('(pointer: coarse)').matches;

  function inputTick() {
    if (!inPtr) return;
    const I = W32(), w = inPtr >> 2;
    Atomics.store(I, w + 7, document.hidden ? 2 : 1);
    padsTick(I, w);
    touchPadTick(I, w);
    // output size: the picture on screen in device pixels, at most 1080 lines and 1920 wide (the game's own size)
    const r = scr.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    let ow = Math.round(r.width * dpr), oh = Math.round(r.height * dpr);
    const k = Math.min(1, 1920 / (ow || 1), 1080 / (oh || 1)); ow = Math.max(320, Math.round(ow * k)); oh = Math.max(180, Math.round(oh * k));
    Atomics.store(I, w + 3, ow); Atomics.store(I, w + 4, oh);
    Atomics.store(I, w + 5, Math.round(r.width)); Atomics.store(I, w + 6, Math.round(r.height));
    Atomics.add(I, w, 1);
  }
  function loop() { inputTick(); uiTick(); requestAnimationFrame(loop); }


  // ------------------------------------------------------------------ Web Settings
  // kept in this browser; the game's own Settings window shows and changes them (games/smm2/mods/web_ui.c)
  const WS_DEF = { aspect: '16:9', shadows: 1, framelimit: 60, compute: 'fast', volume: 100, fps: 0, filter: 'smooth', awake: 1, padlayout: 'switch', deadzone: 0.1, lang: '', about: 0, docked: 1, pausehidden: 1, touch: 'auto', gpu: 'fast', shaders: 'smooth', prewarm: 1, wisp: 'auto', server: '', token: '', ocwdomain: '', ocwtoken: '' };
  const ws = Object.assign({}, WS_DEF);
  try { Object.assign(ws, JSON.parse(localStorage.getItem('smm2-web-settings') || '{}')); } catch (e) {}
  const wsSave = () => { try { localStorage.setItem('smm2-web-settings', JSON.stringify(ws)); } catch (e) {} };
  // the rows of the game's Settings window (games/smm2/mods/web_ui.c) by value number
  const WS_VALS = { aspect: ['16:9', 'fill', '16:10', '21:9', '32:9'], shadows: [1, 0], framelimit: [60, 30], compute: ['fast', 'exact'], fps: [0, 1], filter: ['smooth', 'sharp'], touch: ['auto', 'on', 'off'], awake: [1, 0], padlayout: ['switch', 'xbox'], deadzone: [0.05, 0.1, 0.15, 0.2, 0.25],
    lang: ['', 'en-US', 'fr', 'de', 'it', 'es', 'nl', 'ja'], about: [0], docked: [1, 0], pausehidden: [1, 0], gpu: ['fast', 'low'], shaders: ['smooth', 'exact'], prewarm: [1, 0], volume: [100, 75, 50, 25, 0] };
  function wsGet(k) { if (k === 'wispon') return ws.wisp === 'off' ? 1 : 0; return Math.max(0, WS_VALS[k].indexOf(ws[k])); }
  function wsSet(k, i) { if (k === 'wispon') ws.wisp = i ? 'off' : (new URLSearchParams(location.search).get('wisp') || 'auto'); else ws[k] = WS_VALS[k][i]; wsSave(); wsApply(); }
  let wake = null;
  async function keepAwake() { try { if (ws.awake && running && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!ws.awake && wake) { await wake.release(); wake = null; } } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  function wsApply() {
    if (gain) gain.gain.value = ws.volume / 100;
    if (running && wsShape !== ws.aspect) { wsShape = ws.aspect; shapeNow = shapeOf(ws.aspect); layout(); }
    showFps = !!ws.fps; $('fpsbox').style.display = showFps ? 'block' : 'none';
    scr.style.imageRendering = ws.filter === 'sharp' ? 'pixelated' : 'auto';
    keepAwake();
    if (running) { touchPad.on = ws.touch === 'on' || (ws.touch === 'auto' && isTouch()); if (touchPad.on) buildTouch(); $('touch').style.display = touchPad.on ? 'block' : 'none'; }
  }

  // ------------------------------------------------------------------ Mod Manager (web_ui.c's Mods page)
  // A zip or a folder the player picks goes into <data>/mods/<id>/romfs (runtime/usermods.h: the game layers those over its own
  // files at its next start). Its game files are found wherever they are in it: a romfs folder, or the game's own top folders.
  const ROMFS_TOPS = ['Model', 'Pack', 'Sound', 'Layout', 'Effect', 'Env', 'Message', 'Font', 'Course', 'Stage', 'Movie', 'Mii', 'Shader', 'UI'];
  const modJob = { state: 0, text: '' };   // state 0 idle, 1 busy, 2 done (text: "ok\n<ids>" or "err\n<why>")
  const modSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mod';
  // entries: { path: [...], open: () => ReadableStream }. One mod per game-files folder found
  async function modInstall(entries, name) {
    const roots = new Map();
    for (const e of entries) {
      const p = e.path.filter((s) => s !== '');
      if (p.some((s) => s.startsWith('.') || s === '__MACOSX')) continue;
      let i = p.findIndex((s) => s.toLowerCase() === 'romfs'), rel, key, variant;
      if (i >= 0) { rel = p.slice(i + 1); key = p.slice(0, i + 1).join('/'); variant = i > 0 ? p[i - 1] : ''; }
      else { i = p.findIndex((s) => ROMFS_TOPS.includes(s)); if (i < 0 || i === p.length - 1) continue;
        rel = p.slice(i); key = p.slice(0, i).join('/') + '/'; variant = i > 0 ? p[i - 1] : ''; }
      if (!rel.length) continue;
      if (!roots.has(key)) roots.set(key, { variant, files: [] });
      roots.get(key).files.push({ rel, open: e.open });
    }
    if (!roots.size) throw new Error(entries.some((e) => e.path.some((s) => /^exefs/i.test(s))) ? 'Code mods are not supported' : 'No game files in it');
    const base = await dirAt(await opfs(), [dataDir(), 'mods'], true), ids = [];
    for (const r of roots.values()) {
      const nm = roots.size > 1 || !name ? (r.variant || name || 'Mod') : name, id = modSlug(nm);
      try { await base.removeEntry(id, { recursive: true }); } catch (e) {}
      const d = await base.getDirectoryHandle(id, { create: true });
      let n = 0;
      for (const f of r.files) {
        const dir = await dirAt(d, ['romfs', ...f.rel.slice(0, -1)], true);
        const w = await (await dir.getFileHandle(f.rel[f.rel.length - 1], { create: true })).createWritable();
        await f.open().pipeTo(w);
        if (++n % 10 === 0) modJob.note = 'Copying ' + n + ' / ' + r.files.length;
      }
      const w = await (await d.getFileHandle('mod.info', { create: true })).createWritable(); await w.write('name=' + nm.replace(/\n/g, ' ') + '\n'); await w.close();
      ids.push(id); logAdd('[mods] installed ' + nm + ' (' + r.files.length + ' files) as mods/' + id);
    }
    return ids;
  }
  // a zip's members as entries (stored or deflated; zip64 sizes and offsets), read straight from the file
  async function zipEntries(file) {
    const tail = new DataView(await file.slice(Math.max(0, file.size - 65558)).arrayBuffer());
    let e = -1; for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Not a zip file');
    let count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
    if (cdOff === 0xFFFFFFFF && e >= 20 && tail.getUint32(e - 20, true) === 0x07064b50) {
      const z = new DataView(await file.slice(Number(tail.getBigUint64(e - 12, true)), Number(tail.getBigUint64(e - 12, true)) + 56).arrayBuffer());
      count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), out = [], dec = new TextDecoder();
    for (let o = 0, k = 0; k < count && o + 46 <= cd.byteLength; k++) {
      if (cd.getUint32(o, true) !== 0x02014b50) break;
      const method = cd.getUint16(o + 10, true), nl = cd.getUint16(o + 28, true), xl = cd.getUint16(o + 30, true), cl = cd.getUint16(o + 32, true);
      let csize = cd.getUint32(o + 20, true), usize = cd.getUint32(o + 24, true), loc = cd.getUint32(o + 42, true);
      const nameBytes = new Uint8Array(cd.buffer, o + 46, nl), nm = dec.decode(nameBytes);
      for (let x = o + 46 + nl, xe = x + xl; x + 4 <= xe;) {   // (zip64: the 0xFFFFFFFF fields, in order)
        const id = cd.getUint16(x, true), sz = cd.getUint16(x + 2, true);
        if (id === 1) { let q = x + 4; if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(q, true)); q += 8; } if (loc === 0xFFFFFFFF) loc = Number(cd.getBigUint64(q, true)); }
        x += 4 + sz;
      }
      o += 46 + nl + xl + cl;
      if (nm.endsWith('/')) continue;
      if (method !== 0 && method !== 8) throw new Error('Unsupported zip compression in ' + nm);
      out.push({ path: nm.replace(/\\/g, '/').split('/'), open: () => {
        const ts = new TransformStream();
        (async () => { const h = new DataView(await file.slice(loc, loc + 30).arrayBuffer());
          const at = loc + 30 + h.getUint16(26, true) + h.getUint16(28, true), s = file.slice(at, at + csize).stream();
          await (method === 8 ? s.pipeThrough(new DecompressionStream('deflate-raw')) : s).pipeTo(ts.writable); })().catch((err) => ts.writable.abort(err).catch(() => {}));
        return ts.readable; } });
    }
    return out;
  }
  // kind 0: a zip file, 1: a folder. 1: picking, 0: the browser wants a click or tap for that (a pad's button isn't one)
  function modAdd(kind) {
    if (modJob.state === 1) return 1;
    if (navigator.userActivation && !navigator.userActivation.isActive) return 0;
    const run = async (get) => {
      modJob.state = 1; modJob.note = '';
      try { const r = await get(); if (!r) { modJob.state = 0; return; }
        modJob.note = 'Copying'; const ids = await modInstall(r.entries, r.name); modJob.text = 'ok\n' + ids.join('\n'); }
      catch (e) { modJob.text = 'err\n' + (e && e.name === 'AbortError' ? '' : (e && e.message) || 'failed'); logAdd('[mods] ' + modJob.text.slice(4)); }
      modJob.state = 2; };
    const pick = (inp) => new Promise((res) => { inp.onchange = () => res(inp.files); inp.oncancel = () => res(null); inp.click(); });
    const test = new URLSearchParams(location.search).get('modzip');   // (tests: a zip next to the page instead of the picker)
    if (test && kind === 0) run(async () => ({ entries: await zipEntries(await (await fetch(test)).blob()), name: test.split('/').pop().replace(/\.zip$/i, '') }));
    else if (kind === 0) {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,application/zip';
      run(async () => { const f = await pick(inp); if (!f || !f[0]) return null; return { entries: await zipEntries(f[0]), name: f[0].name.replace(/\.zip$/i, '') }; });
    } else if (window.showDirectoryPicker) {
      run(async () => { let d; try { d = await window.showDirectoryPicker({ id: 'smm2-mod', mode: 'read' }); } catch (e) { return null; }
        const entries = []; for await (const e of walkHandle(d, [])) entries.push({ path: e.path, open: () => { const ts = new TransformStream(); e.file().then((f) => f.stream().pipeTo(ts.writable)).catch(() => {}); return ts.readable; } });
        return { entries, name: d.name }; });
    } else {
      const inp = document.createElement('input'); inp.type = 'file'; inp.webkitdirectory = true;
      run(async () => { const list = await pick(inp); if (!list || !list.length) return null;
        const entries = [...list].map((f) => ({ path: (f.webkitRelativePath || f.name).split('/'), open: () => f.stream() }));
        return { entries, name: entries[0].path.length > 1 ? entries[0].path[0] : '' }; });
    }
    return 1;
  }
  // (the game's side asks until it's done) 1 busy (with a note), 2 done: then the text once
  function modPoll() { const s = modJob.state; if (s === 2) modJob.state = 0; return s; }
  // a restart: the page again, and the game starts by itself
  function restart() { try { sessionStorage.setItem('smm-autostart', '1'); } catch (e) {} location.reload(); }

  // ------------------------------------------------------------------ Course World: the course server in a worker (course_worker.js)
  // The game's own HTTP client connects to 127.0.0.1:8640 as ever; those streams end here instead of in a socket. Works on any host:
  // TGRCode answers browsers directly, so there's nothing to run on the server's side.
  const COURSE_PORT = 8640, course = { worker: null, waiting: new Map(), next: 1, local: new Set() };
  async function courseStart() {
    try {
      const d = await dirAt(await opfs(), [dataDir(), 'extracted', 'exefs'], false);
      const main = new Uint8Array(await (await (await d.getFileHandle('main')).getFile()).arrayBuffer());
      course.worker = new Worker('course_worker.js');
      const token = await new Promise((res, rej) => {
        setTimeout(() => rej(new Error('no answer')), 15000);   // (the game starts either way)
        course.worker.onerror = (e) => rej(new Error(e.message));
        course.worker.onmessage = (e) => { const m = e.data;
          if (m.net !== undefined) courseNet(m);
          else if (m.log !== undefined) { logAdd('[course] ' + m.log); console.log('[course] ' + m.log); }
          else if (m.token !== undefined) res(m.token);
          else { const w = course.waiting.get(m.id); if (w) { course.waiting.delete(m.id); w(m); } } };
        course.worker.postMessage({ main }, [main.buffer]);
      });
      return token ? { server: 'http://127.0.0.1:' + COURSE_PORT, token } : null;
    } catch (e) { logAdd('[course] no course server: ' + e.message); console.warn('[course] no course server: ' + e.message); course.worker = null; return null; }
  }
  // The course server's requests to TGRCode go through the Wisp proxy when there is one (the game's own HTTPS client, on the page's
  // stream): the server's worker asks here and waits on a shared buffer. Without a proxy it asks TGRCode itself, which works from any host
  const fetches = new Map(); let fetchId = 1;
  const courseNet = async ({ net: url, sab }) => { const ctrl = new Int32Array(sab, 0, 4);
    const fail = () => { Atomics.store(ctrl, 0, 2); Atomics.notify(ctrl, 0); };
    if (!wispUrl()) return fail();
    wispStart();
    for (let i = 0; i < 300 && wisp.state === 1; i++) await new Promise((r) => setTimeout(r, 10));
    if (wisp.state !== 2 || !inPtr) return fail();
    const id = fetchId++, u = new TextEncoder().encode(url), p = Number(cAlloc(u.length + 1));
    fetches.set(id, { ctrl, sab });
    const m = new Uint8Array(Module.wasmMemory.buffer); m.set(u, p); m[p + u.length] = 0;
    cCall('_wisp_fetch', id, p, u.length); };
  function wispFetched(id, p, n, status) { const f = fetches.get(id); if (!f) return; fetches.delete(id);
    if (status === 0 || n > f.sab.byteLength - 16) { console.log('[course] wisp request failed, status ' + status + ', ' + n + ' bytes'); Atomics.store(f.ctrl, 0, 2); Atomics.notify(f.ctrl, 0); return; }
    new Uint8Array(f.sab, 16, n).set(new Uint8Array(Module.wasmMemory.buffer, p, n));
    if (!wisp.courseSeen) { wisp.courseSeen = 1; const t = '[course] through the Wisp proxy'; logAdd(t); console.log(t); }
    f.ctrl[1] = status; f.ctrl[2] = n; Atomics.store(f.ctrl, 0, 1); Atomics.notify(f.ctrl, 0); }

  // one request off a stream's bytes: the head, then Content-Length bytes of body
  function courseFeed(id, s) {
    const all = new Uint8Array(s.got.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of s.got) { all.set(b, o); o += b.length; }
    let end = -1; for (let i = 3; i < all.length; i++) if (all[i] === 10 && all[i - 1] === 13 && all[i - 2] === 10 && all[i - 3] === 13) { end = i + 1; break; }
    if (end < 0) return;
    const head = new TextDecoder().decode(all.subarray(0, end)), lines = head.split('\r\n'), [method, url] = lines[0].split(' ');
    const h = (k) => { const l = lines.find((x) => x.toLowerCase().startsWith(k + ':')); return l ? l.slice(k.length + 1).trim() : ''; };
    const len = +h('content-length') || 0;
    if (all.length < end + len) return;
    s.got = [];
    const qid = course.next++, body = all.slice(end, end + len);
    course.waiting.set(qid, (r) => {
      const t = 'HTTP/1.1 ' + r.status + ' OK\r\nContent-Type: ' + r.type + '\r\nContent-Length: ' + r.bytes.length + '\r\nConnection: close\r\n\r\n';
      const a = new TextEncoder().encode(t), out = new Uint8Array(a.length + r.bytes.length); out.set(a); out.set(r.bytes, a.length);
      for (let i = 0; i < out.length; i += 60000) { const c = out.subarray(i, i + 60000), p = Number(cAlloc(c.length)); new Uint8Array(Module.wasmMemory.buffer).set(c, p); cCall('_wisp_rx', id, p, c.length); cFree(p); }
      wispEnded(id, 2); wisp.streams.delete(id);
    });
    course.worker.postMessage({ id: qid, method, url, auth: h('authorization'), body }, [body.buffer]);
  }

  // ------------------------------------------------------------------ online: the page's end of the Wisp connection (web/wisp.c)
  const wisp = { ws: null, state: 0, send: [], streams: new Map(), buffer: 64 };   // state 0 not started, 1 connecting, 2 open, -1 failed
  const wispUrl = () => { const u = (ws.wisp || '').trim(); if (!u || u === 'off') return '';
    if (u === 'auto') return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/wisp/'; return u; };
  function wispPacket(type, id, body) { const b = new Uint8Array(5 + body.length); b[0] = type; new DataView(b.buffer).setUint32(1, id, true); b.set(body, 5); return b; }
  function wispPut(b) { if (wisp.state === 2) wisp.ws.send(b); else wisp.send.push(b); }
  function wispStart() {
    if (wisp.state > 0) return; wisp.state = 1;
    try { wisp.ws = new WebSocket(wispUrl()); } catch (e) { wisp.state = -1; logAdd('[wisp] ' + e.message); return; }
    wisp.ws.binaryType = 'arraybuffer';
    wisp.ws.onerror = () => { logAdd('[wisp] could not reach ' + wispUrl()); };
    wisp.ws.onclose = () => { wisp.state = -1; for (const id of wisp.streams.keys()) wispEnded(id, 3); wisp.streams.clear(); };
    wisp.ws.onmessage = (e) => { const d = new Uint8Array(e.data), v = new DataView(e.data), type = d[0], id = v.getUint32(1, true);
      if (type === 2) { const n = d.length - 5, p = Number(cAlloc(n)); new Uint8Array(Module.wasmMemory.buffer).set(d.subarray(5), p); cCall('_wisp_rx', id, p, n); cFree(p); }
      else if (type === 3) { const b = v.getUint32(5, true);
        if (id === 0) { wisp.buffer = b; if (wisp.state !== 2) { wisp.state = 2; logAdd('[wisp] connected to ' + wispUrl()); } for (const s of wisp.send) wisp.ws.send(s); wisp.send = []; }
        else { const s = wisp.streams.get(id); if (s) { s.credit = b; wispFlush(id, s); } } }
      else if (type === 4) { wispEnded(id, d[5]); wisp.streams.delete(id); } };
  }
  const big = (n) => (Module.wisp64 ? BigInt(n) : n);
  function cAlloc(n) { try { return Module._malloc(big(n)); } catch (e) { Module.wisp64 = true; return Module._malloc(BigInt(n)); } }
  function cFree(p) { Module._free(big(p)); }
  function cCall(f, id, p, n) { try { Module[f](id, big(p), n); } catch (e) { if (e instanceof TypeError && !Module.wisp64) { Module.wisp64 = true; Module[f](id, BigInt(p), n); } else throw e; } }
  function wispEnded(id, reason) { Module._wisp_closed(id, reason); }
  function wispFlush(id, s) { while (s.q.length && (s.udp || s.credit > 0)) { const b = s.q.shift(); wispPut(wispPacket(2, id, b)); if (!s.udp) s.credit--; } }
  Object.assign(wisp, {
    url: () => wispUrl() || (course.worker ? 'local' : ''),
    ready: () => { if (course.worker) return 1; if (!wispUrl()) return -1; wispStart(); return wisp.state === 2 ? 1 : wisp.state < 0 ? -1 : 0; },
    open: (id, udp, host, port) => {
      if (course.worker && port === COURSE_PORT && host === '127.0.0.1') { wisp.streams.set(id, { local: true, got: [] }); return; }
      wispStart(); const h = new TextEncoder().encode(host), b = new Uint8Array(3 + h.length);
      b[0] = udp ? 2 : 1; b[1] = port & 255; b[2] = port >> 8; b.set(h, 3); wispPut(wispPacket(1, id, b)); wisp.streams.set(id, { q: [], credit: wisp.buffer, udp: !!udp }); },
    write: (id, p, n) => { const s = wisp.streams.get(id); if (!s) return 0; const b = new Uint8Array(Module.wasmMemory.buffer).slice(p, p + n);
      if (s.local) { s.got.push(b); courseFeed(id, s); return 1; }
      s.q.push(b); wispFlush(id, s); return 1; },
    close: (id) => { const s = wisp.streams.get(id); if (s && s.local) { wisp.streams.delete(id); return; } if (wisp.streams.delete(id)) wispPut(wispPacket(4, id, new Uint8Array([2]))); },
  });

  // ------------------------------------------------------------------ audio
  let actx = null, gain = null;
  async function audioStart() {
    try { actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); await actx.audioWorklet.addModule('audio_worklet.js'); await actx.resume(); }
    catch (e) { console.warn('audio unavailable', e); actx = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!actx) return; if (document.hidden) { if (ws.pausehidden) actx.suspend().catch(() => {}); } else actx.resume().catch(() => {}); });
  // (a browser may hold the context back until it sees the player do something)
  for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, () => { if (actx && actx.state === 'suspended' && !document.hidden) actx.resume().catch(() => {}); }, true);

  // ------------------------------------------------------------------ frames
  let br = null;
  function present(bmp) {
    if (!br) br = scr.getContext('bitmaprenderer');
    if (scr.width !== bmp.width || scr.height !== bmp.height) { scr.width = bmp.width; scr.height = bmp.height; }
    br.transferFromImageBitmap(bmp); fpsN++;
    if (inPtr) Atomics.add(W32(), (inPtr >> 2) + 8, 1);   // shown: the runtime keeps at most 2 frames on their way
  }
  function fullscreen() { const g = $('game'); if (document.fullscreenElement) document.exitFullscreen(); else g.requestFullscreen().catch(() => {}); }
  $('fs').onclick = fullscreen;
  ['fpsbox', 'touch', 'shaderbox'].forEach((id) => $('game').appendChild($(id)));   /* inside the fullscreen element */

  // the biggest box of the picture's shape in the window (the game draws that shape: Web Settings, Picture Shape)
  let shapeNow = 0, wsShape = null;
  const shapeOf = (s) => s === 'fill' ? Math.max(1.25, Math.min(3.9, innerWidth / innerHeight)) : (+s.split(':')[0] / +s.split(':')[1]);
  function layout() {
    const g = $('game'), W = g.clientWidth, H = g.clientHeight; if (!W || !H) return;
    const a = shapeNow || 16 / 9; let w = W, h = Math.round(W / a); if (h > H) { h = H; w = Math.round(H * a); }
    scr.style.width = w + 'px'; scr.style.height = h + 'px'; scr.style.left = ((W - w) / 2) + 'px'; scr.style.top = ((H - h) / 2) + 'px';
  }
  window.addEventListener('resize', () => { if (running && ws.aspect === 'fill') shapeNow = shapeOf('fill'); layout(); }); document.addEventListener('fullscreenchange', () => setTimeout(layout, 50));
  let fpsN = 0, fpsT = performance.now();
  function uiTick() { const now = performance.now(); if (now - fpsT >= 1000) { $('fpsbox').textContent = Math.round(fpsN * 1000 / (now - fpsT)) + ' FPS'; fpsN = 0; fpsT = now; } }

  // ------------------------------------------------------------------ start
  $('start').onclick = async () => {
    $('start').disabled = true; $('status').textContent = 'Starting…';
    await audioStart();
    const q = new URLSearchParams(location.search);
    // first start on a low-end device (few cores, little memory, a phone): the integrated GPU, Switch handheld mode
    const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 8, mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const env = q.getAll('env');
    if ((ws.gpu === 'low' || cores <= 4 || mem <= 4 || mobile) && !env.some((e) => e.startsWith('WEB_LOWPOWER='))) env.push('WEB_LOWPOWER=1');
    if (ws.shaders === 'exact') env.push('WEB_EXACT_SHADERS=1');
    if (ws.compute === 'exact') env.push('WEB_EXACT_COMPUTE=1');
    wsShape = ws.aspect; shapeNow = shapeOf(ws.aspect); if (ws.aspect !== '16:9') env.push('WEB_ASPECT=' + shapeNow.toFixed(4));
    { const a = env.find((e) => e.startsWith('WEB_ASPECT=')); if (a) shapeNow = +a.slice(11) || shapeNow; }   // (a test's own shape)
    if (!ws.shadows) env.push('WEB_NO_SHADOWS=1');
    if (ws.framelimit === 30) env.push('WEB_FRAME_30=1');
    if (!ws.docked) env.push('WEB_HANDHELD=1');
    if (ws.lang) env.push('WEB_LANGUAGE=' + ws.lang);
    if (!ws.prewarm) env.push('WEB_NO_PREWARM=1');
    // Course World: a server set by hand, else the one serve.py runs next to the page
    let course = ws.server ? { server: ws.server, token: ws.token } : null;
    if (!course && ws.wisp !== 'off') course = await courseStart();
    if (course) { env.push('RECOMP_MOD_SERVER=' + course.server, 'RECOMP_MOD_COURSES=server'); if (course.token) env.push('RECOMP_MOD_TOKEN=' + course.token); }
    if (ws.ocwdomain && ws.ocwtoken) { env.push('RECOMP_NET_BACKEND=ocw');
      try { const d = await dirAt(await opfs(), [dataDir()], true), w = await (await d.getFileHandle('ocw-config.json', { create: true })).createWritable();
        await w.write(JSON.stringify({ domain: ws.ocwdomain, token: ws.ocwtoken })); await w.close(); } catch (e) {} }
    window.Module = {
      mainScriptUrlOrBlob: game.script,
      ...(wasmBuf ? { instantiateWasm: (imports, ok) => { WebAssembly.instantiate(wasmBuf, imports).then((r) => { wasmBuf = null; ok(r.instance, r.module); },
        (e) => { $('status').textContent = 'Could not start the game module: ' + e.message; }); return {}; } } : {}),
      arguments: q.getAll('arg'),
      swrEnv: env,
      print: (s) => { logAdd(s); console.log(s); }, printErr: (s) => { logAdd(s); console.warn(s); },
      swrMessage: (t, err) => { logAdd(t); if (err) alert(t); },
      swrInputAttach: (p) => { inPtr = Number(p); },
      swrPresent: present,
      swrWebGet: wsGet, swrWebSet: wsSet, swrShape: () => shapeNow,
      swrModAdd: modAdd, swrModPoll: modPoll, swrModText: () => modJob.text, swrModNote: () => modJob.note || '', swrRestart: restart, swrToggleLog: toggleLog,
      swrTrace: (r) => { (window.smmShaderTrace = window.smmShaderTrace || []).push(r); },
      swrGpuLost: () => { const b = $('shaderbox'); b.style.display = 'block'; b.textContent = 'The graphics stopped. Restarting the game'; setTimeout(restart, 2500); },
      swrPrewarm: (done, n, fin) => { const b = $('shaderbox'); b.style.display = fin ? 'none' : 'block'; b.textContent = 'Preparing shaders ' + done + ' / ' + n; },
      wispFetched, wispUrl: wisp.url, wispReady: wisp.ready, wispOpen: wisp.open, wispSend: wisp.write, wispClose: wisp.close,
      swrAudioAttach: (p) => {
        if (!actx) return;
        const node = new AudioWorkletNode(actx, 'smm-audio', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { memory: Module.wasmMemory, ptr: Number(p) } });
        gain = actx.createGain(); gain.gain.value = ws.volume / 100; node.connect(gain).connect(actx.destination);
      },
      onAbort: (w) => { $('status').textContent = 'Stopped: ' + w; logAdd('aborted: ' + w); },
      onExit: (c) => { running = false; logAdd('exited (' + c + ')'); },
    };
    const s = document.createElement('script'); s.src = game.script;
    s.onerror = () => { $('status').textContent = 'Could not load ' + game.script; };
    document.body.appendChild(s);
    $('setup').style.display = 'none'; $('game').style.display = 'flex'; $('hud').style.display = 'flex';
    running = true; scr.focus(); layout();
    if (q.get('touch') === '1') ws.touch = 'on';
    wsApply();
    requestAnimationFrame(loop);
  };

  // ------------------------------------------------------------------ boot
  (async () => {
    try { const r = await fetch('game.json', { cache: 'no-cache' }); if (r.ok) game = Object.assign(game, await r.json()); } catch (e) {}
    document.title = game.title; $('title').textContent = game.title;
    // split build: coi-sw.js has to be in charge of this page before the module loads (see prefetchModule)
    if (Object.keys(await splitMap()).length && 'serviceWorker' in navigator && location.protocol !== 'file:') {
      try { await navigator.serviceWorker.register('coi-sw.js'); await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller && !sessionStorage.getItem('smm-sw-reload')) { sessionStorage.setItem('smm-sw-reload', '1'); location.reload(); return; } } catch (e) {} }
    const ok = checks(); let have = await dataState();
    if (!ok) { $('bar').style.display = 'none';
      $('importmsg').textContent = 'This browser can\'t run the game:\n' + [...$('checks').querySelectorAll('li.bad')].map((l) => l.textContent).join('\n'); return; }
    const man = await packedManifest(); let setUp = false;
    if (man && (!have || !dataMarker || dataMarker.id !== man.id)) {
      setUp = true;
      try { await importPacked(man); } catch (e) { $('bar').style.display = 'none'; $('importmsg').textContent = 'Setting up the game files failed: ' + e.message; return; }
      have = await dataState();
    }
    if (!have) { $('bar').style.display = 'none'; $('importmsg').textContent = 'No game files yet. Pick your SMM2Recomp folder (after its setup ran: extracted/, fonts/, sysdata/ inside).';
      $('pick').style.display = 'block'; return; }
    $('importmsg').textContent = 'Loading the game';
    await prefetchModule(setUp ? BAR_DATA : 0); ready();
    // (the game's Restart Game: straight back in)
    let again = false; try { again = sessionStorage.getItem('smm-autostart') === '1'; sessionStorage.removeItem('smm-autostart'); } catch (e) {}
    if (again) $('start').click();
  })();
})();
