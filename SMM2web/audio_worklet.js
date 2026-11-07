// Plays the runtime's audio streams (web/web.h WebAudio: u32 nrings, listening, beat, pad; then per ring u32 rd, wr,
// size, active, f32 gain, 3 pad words, f32 pcm[size * 2]) straight out of the shared wasm memory, mixed. Positions count
// frames and only grow; beat tells the runtime someone is playing (else it drains the rings in real time itself).
const RING_BYTES = 32 + 16384 * 2 * 4;
class SmmAudio extends AudioWorkletProcessor {
  constructor(opt) { super(); this.mem = opt.processorOptions.memory; this.ptr = opt.processorOptions.ptr; this.buf = null; this.prime = []; }
  views() {
    if (this.buf === this.mem.buffer) return;
    this.buf = this.mem.buffer;
    this.hdr = new Int32Array(this.buf, this.ptr, 4);
    this.rings = [];
    const n = Atomics.load(this.hdr, 0) || 4;
    for (let i = 0; i < n; i++) {
      const p = this.ptr + 16 + i * RING_BYTES;
      this.rings.push({ h: new Int32Array(this.buf, p, 4), g: new Float32Array(this.buf, p + 16, 1), size: 16384, pcm: new Float32Array(this.buf, p + 32, 16384 * 2) });
      this.prime.push(true);
    }
  }
  process(inputs, outputs) {
    this.views();
    const L = outputs[0][0], R = outputs[0][1] || outputs[0][0], n = L.length;
    L.fill(0); R.fill(0);
    Atomics.store(this.hdr, 1, 1);
    Atomics.add(this.hdr, 2, 1);
    for (let r = 0; r < this.rings.length; r++) {
      const g = this.rings[r], h = g.h;
      if (!Atomics.load(h, 3)) continue;
      const rd = Atomics.load(h, 0) >>> 0, wr = Atomics.load(h, 1) >>> 0, avail = (wr - rd) >>> 0;
      // some slack before starting: less than the runtime queues (audio.c: 2288 frames, it stops adding there; asking for
      // more left both sides waiting whenever the ring's fill landed just under this, silent until a reload)
      if (this.prime[r]) { if (avail < 1024) continue; this.prime[r] = false; }
      const k = Math.min(n, avail), gain = g.g[0], pcm = g.pcm;
      for (let i = 0; i < k; i++) { const j = ((rd + i) % g.size) * 2; L[i] += pcm[j] * gain; R[i] += pcm[j + 1] * gain; }
      if (k < n) this.prime[r] = true;   // ran dry: build up some slack again instead of crackling
      Atomics.store(h, 0, (rd + k) | 0);
    }
    return true;
  }
}
registerProcessor('smm-audio', SmmAudio);
