/* Battleship Toys — isometric two-player naval battle. Vanilla web component <battleship-game>.
   Inspired by the tank-toys architecture: single component, Canvas 2D, Web Audio, WebRTC p2p. */
(function () {
  'use strict';
  if (customElements.get('battleship-game')) return;

  const TILE_W = 64, TILE_H = 32, HSTEP = 20;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- connect-code codec ---------- */
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function encodeCode(obj) {
    const json = JSON.stringify(obj);
    try {
      const cs = new CompressionStream('deflate-raw');
      const buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer();
      return 'B1.' + b64(new Uint8Array(buf));
    } catch (e) {
      return 'B0.' + b64(new TextEncoder().encode(json));
    }
  }
  async function decodeCode(str) {
    str = (str || '').trim().replace(/\s+/g, '');
    const i = str.indexOf('.');
    if (i < 0) throw new Error('bad code');
    const tag = str.slice(0, i), bytes = unb64(str.slice(i + 1));
    let text;
    if (tag === 'B1' || tag === 'T1') {
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
      text = new TextDecoder().decode(buf);
    } else {
      text = new TextDecoder().decode(bytes);
    }
    return JSON.parse(text);
  }

  /* ---------- WebRTC manual-signaling link ---------- */
  class NetLink {
    constructor(onMsg, onState) {
      this.onMsg = onMsg; this.onState = onState; this.ch = null;
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
      });
      this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    }
    _wire(ch) {
      this.ch = ch;
      ch.onopen = () => this.onState('open');
      ch.onclose = () => this.onState('closed');
      ch.onmessage = (e) => { try { this.onMsg(JSON.parse(e.data)); } catch (_) {} };
    }
    _gather() {
      return new Promise((res) => {
        if (this.pc.iceGatheringState === 'complete') return res();
        const t = setTimeout(res, 4000);
        this.pc.addEventListener('icegatheringstatechange', () => {
          if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
        });
      });
    }
    async host() {
      this._wire(this.pc.createDataChannel('game'));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this._gather();
      return encodeCode(this.pc.localDescription);
    }
    async acceptAnswer(code) {
      await this.pc.setRemoteDescription(await decodeCode(code));
    }
    async join(code) {
      this.pc.ondatachannel = (e) => this._wire(e.channel);
      await this.pc.setRemoteDescription(await decodeCode(code));
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this._gather();
      return encodeCode(this.pc.localDescription);
    }
    send(o) { if (this.ch && this.ch.readyState === 'open') this.ch.send(JSON.stringify(o)); }
    close() { try { this.pc.close(); } catch (_) {} }
  }

  /* ---------- sound (all synthesized) ---------- */
  class Sfx {
    _c() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    blip(f0, f1, dur, type, vol) {
      try {
        const c = this._c(); if (!c) return;
        const o = c.createOscillator(), g = c.createGain();
        o.type = type || 'square';
        o.frequency.setValueAtTime(f0, c.currentTime);
        o.frequency.exponentialRampToValueAtTime(Math.max(25, f1), c.currentTime + dur);
        g.gain.setValueAtTime(vol || 0.12, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
        o.connect(g); g.connect(c.destination);
        o.start(); o.stop(c.currentTime + dur);
      } catch (e) {}
    }
    noise(dur, f, vol) {
      try {
        const c = this._c(); if (!c) return;
        const len = Math.floor(c.sampleRate * dur);
        const buf = c.createBuffer(1, len, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = c.createBufferSource(); src.buffer = buf;
        const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = f;
        const g = c.createGain(); g.gain.value = vol;
        src.connect(flt); flt.connect(g); g.connect(c.destination);
        src.start();
      } catch (e) {}
    }
    cannon() { this.blip(180, 45, 0.2, 'sawtooth', 0.13); this.noise(0.16, 900, 0.1); }
    splash() { this.noise(0.28, 1600, 0.12); this.blip(600, 150, 0.16, 'triangle', 0.05); }
    torpedo() { this.blip(120, 330, 0.35, 'sine', 0.09); this.noise(0.3, 500, 0.05); }
    roar() { this.blip(72, 30, 0.85, 'sawtooth', 0.18); this.blip(150, 48, 0.6, 'square', 0.07); this.noise(0.55, 380, 0.11); }
    thunk() { this.blip(170, 60, 0.13, 'sawtooth', 0.12); }
    rocket() { this.blip(220, 560, 0.28, 'sawtooth', 0.11); this.noise(0.2, 1200, 0.07); }
    boom() { this.blip(110, 26, 0.55, 'sawtooth', 0.2); this.blip(65, 22, 0.65, 'triangle', 0.2); this.noise(0.5, 700, 0.14); }
    bigBoom() {
      // ship-killer blast: sub-bass drop + crack + long rumble, then a delayed after-rumble
      this.blip(170, 24, 0.9, 'sawtooth', 0.3);
      this.blip(75, 18, 1.25, 'triangle', 0.3);
      this.blip(46, 16, 1.4, 'sine', 0.36);
      this.blip(420, 60, 0.18, 'square', 0.1);
      this.noise(0.95, 520, 0.3);
      setTimeout(() => { try { this.noise(0.7, 300, 0.16); this.blip(60, 20, 0.9, 'triangle', 0.14); } catch (e) {} }, 140);
    }
    pick() { this.blip(520, 980, 0.16, 'sine', 0.12); }
    win() { this.blip(400, 800, 0.4, 'triangle', 0.15); this.blip(300, 600, 0.6, 'sine', 0.1); }
  }

  /* ---------- map: open sea, islands, shallows, rocks ---------- */
  function genMap(seed, N) {
    const rnd = mulberry32(seed);
    const F = new Float32Array(N * N);
    const islands = Math.round(N * N / 62) + 2;
    for (let i = 0; i < islands; i++) {
      const cx = 3 + rnd() * (N - 6), cy = 3 + rnd() * (N - 6);
      const r = 1.5 + rnd() * 2.6, amp = 1.3 + rnd() * 2.3;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const d2 = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (r * r);
        F[y * N + x] += amp * Math.exp(-d2 * 2.3);
      }
    }
    const h = new Int8Array(N * N);
    const shallow = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      h[i] = Math.max(0, Math.min(3, Math.floor(F[i])));
      if (h[i] === 0 && F[i] > 0.45) shallow[i] = 1;
    }
    const obst = new Array(N * N).fill(null);
    const rocks = Math.round(N * N * 0.022);
    for (let i = 0; i < rocks; i++) {
      const x = 1 + Math.floor(rnd() * (N - 2)), y = 1 + Math.floor(rnd() * (N - 2));
      const idx = y * N + x;
      if (obst[idx] || h[idx] > 0) continue;
      obst[idx] = { k: 'rock' };
    }
    // decorative palms on island tiles (removed if the island erodes away)
    const deco = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (h[y * N + x] >= 1 && rnd() < 0.14) deco.push({ x, y, v: rnd() });
    }
    const spawns = [{ x: 2.5, y: 2.5 }, { x: N - 2.5, y: N - 2.5 }];
    for (const s of spawns) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y);
        if (d < 3.2) { h[y * N + x] = 0; shallow[y * N + x] = 0; obst[y * N + x] = null; }
      }
    }
    for (let i = deco.length - 1; i >= 0; i--) if (h[deco[i].y * N + deco[i].x] < 1) deco.splice(i, 1);
    const tint = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) tint[i] = rnd();
    return { N, h, shallow, obst, deco, spawns, tint, seed };
  }
  function mapH(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.N || ty >= map.N) return 99;
    return map.h[ty * map.N + tx];
  }
  function mapOb(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.N || ty >= map.N) return null;
    return map.obst[ty * map.N + tx];
  }
  function mapShallow(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.N || ty >= map.N) return 0;
    return map.shallow[ty * map.N + tx];
  }

  const PU_KINDS = ['wind', 'hull', 'quick', 'homing', 'rocket', 'mine'];
  const PU_COLOR = { wind: '#f5a623', hull: '#37c8e0', quick: '#e84fa0', homing: '#b06bff', rocket: '#e8563a', mine: '#4a5560' };
  const PU_NAME = { wind: 'Tailwind!', hull: 'Iron hull!', quick: 'Quick load!', homing: 'Homing torpedoes!', rocket: 'Rockets!', mine: 'Sea mines!' };

  /* ---------- component ---------- */
  class BattleshipGame extends HTMLElement {
    connectedCallback() {
      if (this._init) { this._startLoop(); return; }
      this._init = true;
      this.cfgN = Math.max(12, Math.min(40, parseInt(this.getAttribute('map-size') || this.getAttribute('mapsize') || '20', 10) || 20));
      this.winScore = Math.max(1, Math.min(20, parseInt(this.getAttribute('win-score') || this.getAttribute('winscore') || '5', 10) || 5));
      this.sfx = new Sfx();
      this._buildDom();
      this.keys = {};
      this.state = 'menu';         // menu | host | join | play | over
      this.mode = 'local';         // local | net | ai
      this.myIdx = 0;
      this.net = null;
      this.bullets = [];
      this.parts = [];
      this.pus = [];
      this.mines = [];
      this.mnId = 1;
      this.puNext = 5;
      this.puId = 1;
      this.sendT = 0;
      this.time = 0;
      this.shake = 0;
      this.map = genMap((Math.random() * 1e9) | 0, this.cfgN);   // backdrop map
      this.ships = [];
      this.ai = null;
      this._bind();
      this._show('menu');
      this._startLoop();
    }
    _startLoop() {
      if (this._looping) return;
      this._looping = true;
      this._last = performance.now();
      const loop = (now) => {
        if (!this.isConnected) { this._looping = false; return; }
        const dt = Math.min(0.05, (now - this._last) / 1000);
        this._last = now;
        this.time += dt;
        // never let a single bad frame kill the loop (would freeze input forever)
        try { this._update(dt); } catch (err) { console.error('battleship update error', err); }
        try { this._render(); } catch (err) { console.error('battleship render error', err); }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    disconnectedCallback() {
      setTimeout(() => { if (!this.isConnected && this.net) this.net.close(); }, 0);
    }

    /* ----- DOM ----- */
    _buildDom() {
      const sh = this.attachShadow({ mode: 'open' });
      sh.innerHTML = `
<style>
  :host{display:block;width:100%;height:100%;position:relative;font-family:'Nunito','Trebuchet MS',sans-serif;-webkit-user-select:none;user-select:none}
  canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .screen{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(16,48,74,0.36);backdrop-filter:blur(3px)}
  .screen.on{display:flex}
  .card{background:#f6f2e3;border-radius:26px;padding:30px 34px;box-shadow:0 12px 0 rgba(28,74,110,0.45),0 24px 60px rgba(8,30,50,0.35);max-width:520px;width:min(92vw,520px);text-align:center;color:#22384a}
  h1{margin:0 0 4px;font-size:42px;font-weight:900;letter-spacing:-1px;color:#1f6f9e}
  h1 .r{color:#e84c3d}h1 .b{color:#3a7bd5}
  h2{margin:0 0 14px;font-size:24px;font-weight:900;color:#22384a}
  p{margin:6px 0 16px;font-size:15px;font-weight:700;color:#54718a;line-height:1.45}
  .btn{display:block;width:100%;box-sizing:border-box;margin:10px 0 0;padding:14px 18px;font:900 19px 'Nunito','Trebuchet MS',sans-serif;color:#fff;background:#4caf50;border:none;border-radius:16px;cursor:pointer;box-shadow:0 5px 0 #33803a;transition:transform .06s}
  .btn:hover{filter:brightness(1.06)}
  .btn:active{transform:translateY(4px);box-shadow:0 1px 0 #33803a}
  .btn.red{background:#e84c3d;box-shadow:0 5px 0 #b03225}
  .btn.red:active{box-shadow:0 1px 0 #b03225}
  .btn.blue{background:#3a7bd5;box-shadow:0 5px 0 #2757a0}
  .btn.blue:active{box-shadow:0 1px 0 #2757a0}
  .btn.teal{background:#1f96a8;box-shadow:0 5px 0 #146d7c}
  .btn.teal:active{box-shadow:0 1px 0 #146d7c}
  .btn.ghost{background:#d9d3be;color:#54718a;box-shadow:0 5px 0 #b4ad94}
  .btn.ghost:active{box-shadow:0 1px 0 #b4ad94}
  textarea{width:100%;box-sizing:border-box;height:84px;resize:none;border-radius:12px;border:3px solid #c4dde8;background:#fff;padding:10px;font:700 11px ui-monospace,Menlo,monospace;color:#22384a;outline:none}
  textarea:focus{border-color:#1f96a8}
  .steplab{display:flex;align-items:center;gap:8px;margin:16px 0 6px;font-size:14px;font-weight:900;color:#22384a;text-align:left}
  .steplab .n{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#1f96a8;color:#fff;font-size:13px;flex-shrink:0}
  .status{margin-top:14px;font-size:14px;font-weight:900;color:#8a8168;min-height:18px}
  .status.ok{color:#1f7d3c}.status.err{color:#c0392b}
  .hud{position:absolute;top:0;left:0;right:0;display:none;justify-content:space-between;align-items:flex-start;padding:14px 18px;pointer-events:none}
  .hud.on{display:flex}
  .pcard{display:flex;flex-direction:column;gap:5px;background:rgba(246,242,227,0.92);border-radius:16px;padding:10px 14px;box-shadow:0 4px 0 rgba(28,74,110,0.35);min-width:170px}
  .prow{display:flex;align-items:center;gap:8px}
  .dot{width:14px;height:14px;border-radius:50%;flex-shrink:0}
  .pname{font-size:15px;font-weight:900;color:#22384a}
  .score{margin-left:auto;font-size:19px;font-weight:900;color:#22384a}
  .hpbar{display:flex;gap:3px}
  .hp{width:24px;height:9px;border-radius:4px;background:#d9d3be}
  .hp.f0{background:#e84c3d}.hp.f1{background:#3a7bd5}
  .buffs{display:flex;gap:5px;min-height:14px;flex-wrap:wrap}
  .buff{padding:1px 7px;border-radius:8px;font-size:10px;font-weight:900;color:#fff}
  .mid{background:rgba(246,242,227,0.92);border-radius:14px;padding:8px 16px;font-size:14px;font-weight:900;color:#54718a;box-shadow:0 4px 0 rgba(28,74,110,0.35)}
  .hint{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);background:rgba(12,42,66,0.6);color:#dff0fa;border-radius:12px;padding:6px 16px;font-size:13px;font-weight:800;display:none;white-space:nowrap}
  .hint.on{display:block}
  .legend{position:absolute;right:14px;bottom:12px;display:none;align-items:center;gap:11px;background:rgba(12,42,66,0.6);color:#dff0fa;border-radius:12px;padding:6px 14px;font-size:12px;font-weight:800;pointer-events:none}
  .legend.on{display:flex}
  .legend .lt{opacity:0.65;text-transform:uppercase;letter-spacing:.5px;font-size:10px}
  .li{display:flex;align-items:center;gap:5px}
  .ldot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
  .toast{position:absolute;top:70px;left:50%;transform:translateX(-50%);background:#1c3a52;color:#fff;border-radius:12px;padding:8px 18px;font-size:15px;font-weight:900;opacity:0;transition:opacity .25s;pointer-events:none}
  .toast.on{opacity:1}
  .rowbtns{display:flex;gap:10px}
  .rowbtns .btn{flex:1}
  .bigwin{font-size:38px;font-weight:900;margin:0 0 6px}
  .winscore{font-size:22px;font-weight:900;color:#22384a;margin:2px 0 16px;letter-spacing:.3px}
  .winscore .r{color:#e84c3d}.winscore .b{color:#3a7bd5}
</style>
<canvas></canvas>
<div class="hud">
  <div class="pcard" id="pc0">
    <div class="prow"><span class="dot" style="background:#e84c3d"></span><span class="pname" id="pn0">Red</span><span class="score">0</span></div>
    <div class="hpbar"></div><div class="buffs"></div>
  </div>
  <div class="mid" id="mid">first to 5</div>
  <div class="pcard" id="pc1">
    <div class="prow"><span class="dot" style="background:#3a7bd5"></span><span class="pname" id="pn1">Blue</span><span class="score">0</span></div>
    <div class="hpbar"></div><div class="buffs"></div>
  </div>
</div>
<div class="hint" id="hint"></div>
<div class="legend" id="legend">
  <span class="lt">reloads</span>
  <span class="li"><span class="ldot" style="background:#ffffff"></span>torpedo</span>
  <span class="li"><span class="ldot" style="background:#ff7d50"></span>missile</span>
  <span class="li"><span class="ldot" style="background:#ffd66e"></span>broadside</span>
</div>
<div class="toast" id="toast"></div>

<div class="screen on" id="scr-menu"><div class="card">
  <h1><span class="r">BATTLE</span> <span class="b">SHIPS</span></h1>
  <p>Toy fleets, tiny islands, big splashes.<br>Isometric naval duel &mdash; cannons arc, torpedoes run deep.</p>
  <button class="btn teal" id="b-ai">Play the computer</button>
  <button class="btn red" id="b-host">Host an online game</button>
  <button class="btn blue" id="b-join">Join with a code</button>
  <button class="btn" id="b-local">Local &mdash; both on this keyboard</button>
</div></div>

<div class="screen" id="scr-host"><div class="card">
  <h2>Host a game</h2>
  <div class="steplab"><span class="n">1</span>Send this invite code to your friend</div>
  <textarea id="host-code" readonly placeholder="Creating code&hellip;"></textarea>
  <button class="btn ghost" id="b-copy-host">Copy invite code</button>
  <div class="steplab"><span class="n">2</span>Paste their reply code here</div>
  <textarea id="host-answer" placeholder="Paste reply code&hellip;"></textarea>
  <button class="btn" id="b-connect">Connect</button>
  <div class="status" id="host-status"></div>
  <button class="btn ghost" id="b-back1">Back</button>
</div></div>

<div class="screen" id="scr-join"><div class="card">
  <h2>Join a game</h2>
  <div class="steplab"><span class="n">1</span>Paste the host&rsquo;s invite code</div>
  <textarea id="join-code" placeholder="Paste invite code&hellip;"></textarea>
  <button class="btn" id="b-reply">Create reply code</button>
  <div class="steplab"><span class="n">2</span>Send this reply code back to the host</div>
  <textarea id="join-answer" readonly></textarea>
  <button class="btn ghost" id="b-copy-join">Copy reply code</button>
  <div class="status" id="join-status"></div>
  <button class="btn ghost" id="b-back2">Back</button>
</div></div>

<div class="screen" id="scr-over"><div class="card">
  <div class="bigwin" id="win-title">Red wins!</div>
  <div class="winscore" id="win-score"></div>
  <p id="win-sub"></p>
  <div class="rowbtns">
    <button class="btn" id="b-rematch">Rematch</button>
    <button class="btn ghost" id="b-menu">Menu</button>
  </div>
</div></div>`;
      this.$ = (s) => sh.querySelector(s);
      this.canvas = this.$('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.$('#mid').textContent = 'first to ' + this.winScore;
    }

    _bind() {
      const $ = this.$;
      $('#b-local').onclick = () => { this.mode = 'local'; this._startMatch((Math.random() * 1e9) | 0); };
      $('#b-ai').onclick = () => { this.mode = 'ai'; this._startMatch((Math.random() * 1e9) | 0); };
      $('#b-host').onclick = () => this._hostFlow();
      $('#b-join').onclick = () => this._show('join');
      $('#b-back1').onclick = () => this._abortNet();
      $('#b-back2').onclick = () => this._abortNet();
      $('#b-menu').onclick = () => { this._abortNet(); };
      $('#b-copy-host').onclick = () => this._copy($('#host-code').value, $('#b-copy-host'));
      $('#b-copy-join').onclick = () => this._copy($('#join-answer').value, $('#b-copy-join'));
      $('#b-connect').onclick = () => this._hostAccept();
      $('#b-reply').onclick = () => this._joinFlow();
      $('#b-rematch').onclick = () => {
        if (this.mode === 'net') {
          const seed = (Math.random() * 1e9) | 0;
          this.net.send({ t: 're', seed });
          this._startMatch(seed);
        } else this._startMatch((Math.random() * 1e9) | 0);
      };
      window.addEventListener('keydown', (e) => {
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
        this.keys[e.code] = true;
        if (['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && this.state === 'play') e.preventDefault();
        this.sfx._c && this.sfx._c();
      });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      window.addEventListener('blur', () => { this.keys = {}; });
    }

    _copy(text, btn) {
      if (!text) return;
      const done = () => { const o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = o; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    }

    _show(name) {
      for (const n of ['menu', 'host', 'join', 'over']) this.$('#scr-' + n).classList.toggle('on', n === name);
      this.$('.hud').classList.toggle('on', name === 'over' || this.state === 'play');
      this.$('#hint').classList.toggle('on', false);
      this.$('#legend').classList.toggle('on', false);
    }

    _toast(msg) {
      const t = this.$('#toast');
      t.textContent = msg; t.classList.add('on');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.remove('on'), 2200);
    }

    /* ----- net flows ----- */
    _newLink() {
      if (this.net) this.net.close();
      this.net = new NetLink((m) => this._onMsg(m), (s) => this._onNetState(s));
    }
    async _hostFlow() {
      this._show('host');
      this.$('#host-code').value = '';
      this.$('#host-status').textContent = 'Creating invite code…';
      this._newLink();
      this.myIdx = 0;
      try {
        this.$('#host-code').value = await this.net.host();
        this.$('#host-status').textContent = 'Waiting for the reply code…';
      } catch (e) {
        this.$('#host-status').textContent = 'Could not create code: ' + e.message;
        this.$('#host-status').className = 'status err';
      }
    }
    async _hostAccept() {
      const st = this.$('#host-status');
      try {
        st.className = 'status'; st.textContent = 'Connecting…';
        await this.net.acceptAnswer(this.$('#host-answer').value);
      } catch (e) { st.className = 'status err'; st.textContent = 'That code didn’t parse — paste the full reply code.'; }
    }
    async _joinFlow() {
      const st = this.$('#join-status');
      this._newLink();
      this.myIdx = 1;
      try {
        st.className = 'status'; st.textContent = 'Creating reply code…';
        this.$('#join-answer').value = await this.net.join(this.$('#join-code').value);
        st.textContent = 'Send the reply code to the host, then wait…';
      } catch (e) { st.className = 'status err'; st.textContent = 'That code didn’t parse — paste the full invite code.'; }
    }
    _abortNet() {
      if (this.net) { this.net.close(); this.net = null; }
      this.state = 'menu'; this.mode = 'local';
      this._show('menu');
      this.$('.hud').classList.remove('on');
      this.$('#hint').classList.remove('on');
      this.$('#legend').classList.remove('on');
    }
    _onNetState(s) {
      if (s === 'open') {
        this.mode = 'net';
        if (this.myIdx === 0) {
          const seed = (Math.random() * 1e9) | 0;
          this.net.send({ t: 'map', seed });
          this._startMatch(seed);
        } else {
          const st = this.$('#join-status');
          st.className = 'status ok'; st.textContent = 'Connected! Casting off…';
        }
      } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        if (this.state === 'play' || this.state === 'over') {
          this._toast('Connection lost');
          this._abortNet();
        }
      }
    }
    _onMsg(m) {
      const rs = this.ships && this.ships[1 - this.myIdx];
      switch (m.t) {
        case 'map': this._startMatch(m.seed); break;
        case 're': this._startMatch(m.seed); break;
        case 's':
          if (!rs) break;
          rs.net = { x: m.x, y: m.y, a: m.a };
          rs.hp = m.hp; rs.score = m.sc; rs.inv = m.inv; rs.shield = m.sh;
          if (typeof m.ho === 'number') rs.homing = m.ho;
          if (typeof m.ro === 'number') rs.rockets = m.ro;
          if (typeof m.mn === 'number') rs.mines = m.mn;
          if (rs.alive && !m.al) this._explodeShip(rs);
          rs.alive = m.al;
          this._checkWin();
          break;
        case 'f':
          this.bullets.push({
            x: m.x, y: m.y, dx: m.dx, dy: m.dy, h: m.h, owner: 1 - this.myIdx,
            life: m.tp ? (m.g ? 6 : 5) : (m.ms ? (m.life || 2) : m.rk ? 1.4 : 3),
            tp: !!m.tp, rk: !!m.rk, ms: !!m.ms, hv: m.hv || 0, ix: m.ix, iy: m.iy,
            guided: !!m.g, target: m.g ? this.myIdx : -1, dmg: m.dmg || 1
          });
          if (m.tp) this.sfx.torpedo(); else if (m.rk || m.ms) this.sfx.rocket(); else this.sfx.cannon();
          break;
        case 'bs': this._fireBroadside(m.x, m.y, m.a, 1 - this.myIdx); break;
        case 'mn':
          this.mines.push({ id: m.id, x: m.x, y: m.y, owner: 1 - this.myIdx, arm: 1.5, life: 25 });
          this._splash(m.x, m.y, false);
          break;
        case 'mnx': {
          const i = this.mines.findIndex(mm => mm.id === m.id);
          if (i >= 0) { this._mineBoom(this.mines[i], false); this.mines.splice(i, 1); }
          break;
        }
        case 'd':
          if (this.ships[this.myIdx]) { this.ships[this.myIdx].score++; this._checkWin(); }
          break;
        case 'ob': this._destroyObstacle(m.x, m.y, false); break;
        case 'tf':
          if (Array.isArray(m.c)) for (const c of m.c) {
            if (c.x >= 0 && c.y >= 0 && c.x < this.map.N && c.y < this.map.N) this._setTileH(c.x, c.y, c.h);
          }
          break;
        case 'pu': this.pus.push({ id: m.id, x: m.x, y: m.y, k: m.k }); break;
        case 'pug': {
          const i = this.pus.findIndex(p => p.id === m.id);
          if (i >= 0) this.pus.splice(i, 1);
          break;
        }
      }
    }

    /* ----- match ----- */
    _startMatch(seed) {
      this.map = genMap(seed, this.cfgN);
      this.bullets = []; this.parts = []; this.pus = []; this.mines = [];
      this.puNext = 6; this.puId = 1; this.mnId = 1;
      const mk = (i) => {
        const s = this.map.spawns[i];
        const a = Math.atan2(this.map.N / 2 - s.y, this.map.N / 2 - s.x);
        return {
          i, x: s.x, y: s.y, a, hp: 5, alive: true, respawn: 0, inv: 2, cool: 0, tcool: 0, bcool: 0, mscool: 0, mncool: 0,
          score: 0, shield: 0, speed: 0, rapid: 0, homing: 0, rockets: 0, mines: 0, net: null, anim: 0,
          px: s.x, py: s.y, wakeT: 0
        };
      };
      this.ships = [mk(0), mk(1)];
      /* the sea monster's lair — seeded, so both peers agree; deep water, away from spawns */
      {
        const mrnd = mulberry32(((seed ^ 0x5ea0) >>> 0) + 7);
        let mx = this.map.N / 2 + 0.5, my = this.map.N / 2 + 0.5;
        for (let tries = 0; tries < 80; tries++) {
          const x = 3 + Math.floor(mrnd() * (this.map.N - 6));
          const y = 3 + Math.floor(mrnd() * (this.map.N - 6));
          if (mapH(this.map, x, y) > 0 || mapShallow(this.map, x, y) || mapOb(this.map, x, y)) continue;
          if (this.map.spawns.some(s => Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) < 5.5)) continue;
          mx = x + 0.5; my = y + 0.5; break;
        }
        this.monster = { x: mx, y: my, state: 'lurk', t: 0, cool: 4, bubT: 0, warned: false };
      }
      this.ai = { torpT: 1.5, roamA: 0 };
      this.state = 'play';
      this._show('none');
      this.$('.hud').classList.add('on');
      this.$('#pn0').textContent = this.mode === 'ai' ? 'You' : 'Red';
      this.$('#pn1').textContent = this.mode === 'ai' ? 'Computer' : 'Blue';
      const hint = this.$('#hint');
      hint.classList.add('on');
      hint.textContent = this.mode === 'local'
        ? 'Red: WASD · Space cannon · E torpedo · R missile · Q broadside · F mine — Blue: Arrows · Enter · ⇧ · . · / · , mine'
        : this.mode === 'ai'
          ? 'WASD or Arrows to sail · Space cannon · E torpedo · R missile · Q broadside · F drops mines'
          : (this.myIdx === 0 ? 'You are RED · ' : 'You are BLUE · ') + 'Space cannon · E torpedo · R missile · Q broadside · F drops mines';
      this.$('#legend').classList.add('on');
      this._toast(this.mode === 'net' ? 'Linked up! Anchors aweigh!' : 'Anchors aweigh!');
    }

    _checkWin() {
      if (this.state !== 'play') return;
      const w = this.ships.findIndex(t => t.score >= this.winScore);
      if (w < 0) return;
      this.state = 'over';
      this._updateHud();
      this._show('over');
      this.$('.hud').classList.add('on');
      const names = ['Red', 'Blue'], colors = ['#e84c3d', '#3a7bd5'];
      const el = this.$('#win-title');
      if (this.mode === 'net') {
        const iWon = w === this.myIdx;
        el.textContent = iWon ? 'You win!' : 'You lose';
        el.style.color = iWon ? colors[this.myIdx] : '#8a8168';
        this.$('#win-sub').textContent = iWon ? 'You rule the waves!' : 'Back to port for repairs.';
      } else if (this.mode === 'ai') {
        const iWon = w === 0;
        el.textContent = iWon ? 'You win!' : 'The computer wins';
        el.style.color = iWon ? colors[0] : '#8a8168';
        this.$('#win-sub').textContent = iWon ? 'You rule the waves!' : 'Back to port for repairs.';
      } else {
        el.textContent = names[w] + ' wins!';
        el.style.color = colors[w];
        this.$('#win-sub').textContent = 'Great battle!';
      }
      const n0 = this.mode === 'ai' ? 'You' : 'Red', n1 = this.mode === 'ai' ? 'Computer' : 'Blue';
      this.$('#win-score').innerHTML = '<span class="r">' + n0 + ' ' + this.ships[0].score + '</span> — <span class="b">' + this.ships[1].score + ' ' + n1 + '</span>';
      this.sfx.win();
    }

    /* ----- controls ----- */
    _controlOf(idx) {
      const k = this.keys;
      if (this.mode === 'local') {
        if (idx === 0) return { f: k.KeyW, b: k.KeyS, l: k.KeyA, r: k.KeyD, fire: k.Space, torp: k.KeyE, bs: k.KeyQ, ms: k.KeyR, mine: k.KeyF };
        return { f: k.ArrowUp, b: k.ArrowDown, l: k.ArrowLeft, r: k.ArrowRight, fire: k.Enter, torp: k.ShiftRight, bs: k.Slash, ms: k.Period, mine: k.Comma };
      }
      if (this.mode === 'ai') {
        if (idx === 1) return this._aiControl();
        return {
          f: k.KeyW || k.ArrowUp, b: k.KeyS || k.ArrowDown,
          l: k.KeyA || k.ArrowLeft, r: k.KeyD || k.ArrowRight,
          fire: k.Space || k.Enter, torp: k.KeyE || k.ShiftRight || k.ShiftLeft, bs: k.KeyQ || k.Slash, ms: k.KeyR || k.Period, mine: k.KeyF || k.Comma
        };
      }
      return {
        f: k.KeyW || k.ArrowUp, b: k.KeyS || k.ArrowDown,
        l: k.KeyA || k.ArrowLeft, r: k.KeyD || k.ArrowRight,
        fire: k.Space || k.Enter, torp: k.KeyE || k.ShiftRight || k.ShiftLeft, bs: k.KeyQ || k.Slash, ms: k.KeyR || k.Period, mine: k.KeyF || k.Comma
      };
    }

    /* ----- AI skipper ----- */
    _norm(a) {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    }
    // line-of-sight: 'water' checks torpedo path (any land/rock blocks);
    // 'arc' approximates the cannon shell's falling height along the way
    _losClear(x0, y0, x1, y1, kind) {
      const d = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(2, Math.ceil(d * 2));
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        const tx = Math.floor(x0 + (x1 - x0) * f), ty = Math.floor(y0 + (y1 - y0) * f);
        const h = mapH(this.map, tx, ty);
        if (h >= 99) return false;
        if (kind === 'water') {
          if (h >= 1 || mapOb(this.map, tx, ty)) return false;
        } else {
          const bh = 0.6 - 0.5 * (d * f / 8.5);
          if (h > bh) return false;
          if (mapOb(this.map, tx, ty) && bh < 0.9) return false;
        }
      }
      return true;
    }
    _aiControl() {
      const me = this.ships[1], foe = this.ships[0];
      if (!me || !me.alive) return { f: 0, b: 0, l: 0, r: 0, fire: 0, torp: 0, mine: 0 };
      const c = { f: false, b: false, l: false, r: false, fire: false, torp: false, bs: false, ms: false, mine: false };
      // pick destination: nearby power-up if the foe is far, else the foe (keep ~4 tiles)
      let tx = foe.x, ty = foe.y;
      const dFoe = Math.hypot(foe.x - me.x, foe.y - me.y);
      let bestPu = null, bestD = 6;
      for (const p of this.pus) {
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d < bestD) { bestD = d; bestPu = p; }
      }
      if (bestPu && (dFoe > 5 || me.hp <= 2)) { tx = bestPu.x; ty = bestPu.y; }
      const desired = Math.atan2(ty - me.y, tx - me.x) + Math.sin(this.time * 1.4) * 0.12;   // imperfect helmsman
      let da = this._norm(desired - me.a);
      // obstacle avoidance: probe ahead and to the sides
      const blocked = (ang, d) => {
        const px = me.x + Math.cos(ang) * d, py = me.y + Math.sin(ang) * d;
        return this._shipBlocked(Math.floor(px), Math.floor(py));
      };
      const ahead = blocked(me.a, 1.1) || blocked(me.a, 0.6);
      const left = blocked(me.a - 0.65, 1.0);
      const right = blocked(me.a + 0.65, 1.0);
      if (ahead) {
        if (!right && left) da = 0.9;
        else if (!left && right) da = -0.9;
        else if (!left && !right) da = da >= 0 ? 0.9 : -0.9;
        else { c.b = true; da = 0.9; }   // boxed in: back out while turning
      }
      if (da > 0.07) c.r = true;
      else if (da < -0.07) c.l = true;
      c.f = !c.b && Math.abs(da) < 1.25 && !(dFoe < 2.2 && !bestPu);   // don't ram
      // gunnery — only when actually hunting the foe
      const daFoe = this._norm(Math.atan2(foe.y - me.y, foe.x - me.x) - me.a);
      const hesitating = Math.sin(this.time * 0.65 + 1.3) > 0.45;   // regular lulls so a human can breathe
      if (foe.alive && foe.inv <= 0 && !hesitating) {
        if (dFoe < 8 && Math.abs(daFoe) < 0.11 && Math.random() < 0.3 && this._losClear(me.x, me.y, foe.x, foe.y, 'arc')) c.fire = true;
        if (dFoe < 6.5 && Math.abs(daFoe) < 0.14 && this._losClear(me.x, me.y, foe.x, foe.y, 'water') && Math.random() < 0.04) c.torp = true;
        const abeam = Math.abs(Math.abs(daFoe) - Math.PI / 2);
        if (me.bcool <= 0 && dFoe < 5.5 && abeam < 0.22 && Math.random() < 0.05) c.bs = true;
        if (me.mscool <= 0 && dFoe > 4 && dFoe < 11 && Math.abs(daFoe) < 0.6 && Math.random() < 0.03) c.ms = true;
      }
      if (me.mines > 0 && dFoe < 3.2 && Math.abs(daFoe) > 2.1 && Math.random() < 0.06) c.mine = true;   // drop a mine while fleeing
      return c;
    }

    /* ----- gameplay ----- */
    _shipBlocked(tx, ty) {
      if (tx < 0 || ty < 0 || tx >= this.map.N || ty >= this.map.N) return true;
      if (mapOb(this.map, tx, ty)) return true;
      return mapH(this.map, tx, ty) >= 1;   // ships can't climb islands
    }

    _moveShip(t, c, dt) {
      const turn = (c.r ? 1 : 0) - (c.l ? 1 : 0);
      t.a += turn * dt * 1.9;
      const thr = (c.f ? 1 : 0) - (c.b ? 0.5 : 0);
      if (thr !== 0 || turn !== 0) t.anim += dt * Math.abs(thr || 0.5);
      const shal = mapShallow(this.map, Math.floor(t.x), Math.floor(t.y));
      const spd = 2.7 * (t.speed > 0 ? 1.65 : 1) * (shal ? 0.55 : 1) * thr;
      if (spd !== 0) {
        const nx = t.x + Math.cos(t.a) * spd * dt;
        const ny = t.y + Math.sin(t.a) * spd * dt;
        const r = 0.34;
        const okX = !this._shipBlocked(Math.floor(nx + Math.sign(Math.cos(t.a)) * r), Math.floor(t.y));
        const okY = !this._shipBlocked(Math.floor(t.x), Math.floor(ny + Math.sign(Math.sin(t.a)) * r));
        if (okX) t.x = Math.max(0.4, Math.min(this.map.N - 0.4, nx));
        if (okY) t.y = Math.max(0.4, Math.min(this.map.N - 0.4, ny));
      }
      /* cannon — fires rockets while a rocket pickup lasts */
      if (c.fire && t.cool <= 0 && t.alive) {
        const rk = t.rockets > 0;
        t.cool = rk ? 0.5 : (t.rapid > 0 ? 0.22 : 0.7);
        const spd1 = rk ? 12 : 8.5;
        const b = {
          x: t.x + Math.cos(t.a) * 0.6, y: t.y + Math.sin(t.a) * 0.6,
          dx: Math.cos(t.a) * spd1, dy: Math.sin(t.a) * spd1,
          h: rk ? 0.75 : 0.6, owner: t.i, life: rk ? 1.4 : 3, tp: false, rk, guided: false, target: -1, dmg: 1
        };
        this.bullets.push(b);
        if (rk) { t.rockets--; this.sfx.rocket(); } else this.sfx.cannon();
        for (let s = 0; s < 3; s++) this._spark(b.x, b.y, 0.6, '#ffd9a0');
        if (this.mode === 'net') this.net.send({ t: 'f', x: b.x, y: b.y, dx: b.dx, dy: b.dy, h: b.h, tp: 0, rk: rk ? 1 : 0, g: 0, dmg: 1 });
      }
      /* broadside — a volley from both rails */
      if (c.bs && t.bcool <= 0 && t.alive) {
        t.bcool = 5;
        this._fireBroadside(t.x, t.y, t.a, t.i);
        if (this.mode === 'net') this.net.send({ t: 'bs', x: +t.x.toFixed(3), y: +t.y.toFixed(3), a: +t.a.toFixed(3) });
      }
      /* ship-to-ship missile — ballistic arc onto the target's predicted position */
      if (c.ms && t.mscool <= 0 && t.alive) {
        t.mscool = 8;
        const foe = this.ships[1 - t.i];
        const sp = 6.5;
        let ax = foe ? foe.x : t.x + Math.cos(t.a) * 8, ay = foe ? foe.y : t.y + Math.sin(t.a) * 8;
        if (foe) {
          const T0 = Math.hypot(ax - t.x, ay - t.y) / sp;
          ax += (foe.velx || 0) * T0 * 0.85;
          ay += (foe.vely || 0) * T0 * 0.85;
        }
        let dx = ax - t.x, dy = ay - t.y, d = Math.hypot(dx, dy) || 0.001;
        const maxR = 12;
        if (d > maxR) { dx *= maxR / d; dy *= maxR / d; d = maxR; }
        const T = Math.max(0.5, d / sp);
        const hv = (0.5 * 24 * T * T - 0.7) / T;   // steep mortar arc — clears islands and rocks, lands at sea level at T
        const b = {
          x: t.x, y: t.y, dx: dx / T, dy: dy / T,
          ix: t.x + dx, iy: t.y + dy,
          h: 0.7, hv, owner: t.i, life: T + 0.05, tp: false, rk: false, ms: true,
          guided: false, target: -1, dmg: 2
        };
        this.bullets.push(b);
        this.sfx.rocket();
        this.sfx.noise(0.25, 1400, 0.08);
        for (let s = 0; s < 4; s++) this._spark(b.x, b.y, 0.8, '#ffd9a0');
        if (this.mode === 'net') this.net.send({ t: 'f', x: b.x, y: b.y, dx: b.dx, dy: b.dy, h: b.h, hv: b.hv, life: b.life, ix: b.ix, iy: b.iy, ms: 1, dmg: 2 });
      }
      /* mine key (F / ,) — drops a sea mine astern while a mine pickup lasts */
      if (c.mine && t.mncool <= 0 && t.alive && t.mines > 0) {
        t.mncool = 1.0;
        t.mines--;
        const mn = { id: (t.i + 1) * 100000 + this.mnId++, x: t.x - Math.cos(t.a) * 0.95, y: t.y - Math.sin(t.a) * 0.95, owner: t.i, arm: 1.5, life: 25 };
        this.mines.push(mn);
        this.sfx.blip(300, 110, 0.14, 'sine', 0.1);
        this._splash(mn.x, mn.y, false);
        if (this.mode === 'net') this.net.send({ t: 'mn', id: mn.id, x: +mn.x.toFixed(3), y: +mn.y.toFixed(3) });
      }
      /* torpedo key — always a torpedo, even while carrying mines */
      if (c.torp && t.tcool <= 0 && t.alive) {
        const guided = t.homing > 0;
        t.tcool = 2.8;
        const spd2 = guided ? 4.2 : 4.6;
        const b = {
          x: t.x + Math.cos(t.a) * 0.6, y: t.y + Math.sin(t.a) * 0.6,
          dx: Math.cos(t.a) * spd2, dy: Math.sin(t.a) * spd2,
          h: 0.05, owner: t.i, life: guided ? 6 : 5, tp: true,
          guided, target: guided ? 1 - t.i : -1, dmg: 2
        };
        this.bullets.push(b);
        if (guided) t.homing--;
        this.sfx.torpedo();
        if (this.mode === 'net') this.net.send({ t: 'f', x: b.x, y: b.y, dx: b.dx, dy: b.dy, h: b.h, tp: 1, g: guided ? 1 : 0, dmg: 2 });
      }
    }

    _fireBroadside(x, y, a, owner) {
      for (const side of [-1, 1]) {
        const pa = a + side * Math.PI / 2;
        for (const off of [-0.45, 0, 0.45]) {
          const bx = x + Math.cos(a) * off + Math.cos(pa) * 0.55;
          const by = y + Math.sin(a) * off + Math.sin(pa) * 0.55;
          const sa2 = pa + off * 0.18;
          this.bullets.push({
            x: bx, y: by, dx: Math.cos(sa2) * 7.5, dy: Math.sin(sa2) * 7.5,
            h: 0.55, owner, life: 3, tp: false, guided: false, target: -1, dmg: 1
          });
          this._spark(bx, by, 0.55, '#ffd9a0');
        }
      }
      this.sfx.cannon(); this.sfx.cannon();
      this.sfx.noise(0.3, 700, 0.12);
    }

    _mineBoom(mn, broadcast) {
      for (let s = 0; s < 12; s++) this._spark(mn.x, mn.y, 0.4, s % 2 ? '#ffb35c' : '#4a5560');
      this._splash(mn.x, mn.y, true);
      this.shake = Math.max(this.shake || 0, 0.4);
      this.sfx.boom();
      if (broadcast && this.mode === 'net') this.net.send({ t: 'mnx', id: mn.id });
    }

    _missileBlast(b) {
      for (let s = 0; s < 22; s++) this._spark(b.x, b.y, 0.4, s % 3 ? '#ffb35c' : '#4a5560');
      this.parts.push({ x: b.x, y: b.y, h: 0, vx: 0, vy: 0, vh: 0, life: 0.45, t: 0, color: 'rgba(255,255,255,0.9)', size: 62, ring: true });
      this._splash(b.x, b.y, true);
      this.shake = Math.max(this.shake || 0, 0.5);
      this.sfx.boom();
      for (const t of this.ships) {
        if (!t.alive || Math.hypot(t.x - b.x, t.y - b.y) > 1.15) continue;
        const mine = this.mode !== 'net' || t.i === this.myIdx;
        if (mine) this._damageMe(t, b.dmg);
      }
    }

    _destroyObstacle(tx, ty, broadcast) {
      const ob = mapOb(this.map, tx, ty);
      if (!ob) return;
      this.map.obst[ty * this.map.N + tx] = null;
      for (let i = 0; i < 14; i++) this._spark(tx + 0.5, ty + 0.5, 0.5, '#9aa0a6');
      this.sfx.thunk();
      if (broadcast && this.mode === 'net') this.net.send({ t: 'ob', x: tx, y: ty });
    }

    _setTileH(x, y, nh) {
      const N = this.map.N, idx = y * N + x;
      this.map.h[idx] = nh;
      if (nh === 0) {
        this.map.shallow[idx] = 1;   // eroded islands leave a sandbar shoal
        for (let i = this.map.deco.length - 1; i >= 0; i--) {
          if (this.map.deco[i].x === x && this.map.deco[i].y === y) this.map.deco.splice(i, 1);
        }
      }
    }

    // Cannon fire erodes islands — flattens cover, deterministic across peers:
    // the owner peer lowers + broadcasts absolute heights; the other peer SETS them.
    _terraform(tx, ty, power, broadcast) {
      const N = this.map.N, changes = [];
      const lower = (x, y, amt) => {
        if (x < 0 || y < 0 || x >= N || y >= N) return;
        const idx = y * N + x, nh = Math.max(0, this.map.h[idx] - amt);
        if (nh !== this.map.h[idx]) {
          this._setTileH(x, y, nh);
          changes.push({ x, y, h: nh });
          this._spark(x + 0.5, y + 0.5, nh + 0.6, '#c9b071');   // kicked-up sand
        }
      };
      lower(tx, ty, power);
      if (power >= 2) { lower(tx + 1, ty, 1); lower(tx - 1, ty, 1); lower(tx, ty + 1, 1); lower(tx, ty - 1, 1); }
      if (changes.length) {
        this.sfx.thunk();
        if (broadcast && this.mode === 'net') this.net.send({ t: 'tf', c: changes });
      }
    }

    _spark(x, y, h, color) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 3;
      this.parts.push({ x, y, h, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vh: 1.5 + Math.random() * 3, life: 0.5 + Math.random() * 0.5, t: 0, color, size: 2.5 + Math.random() * 3.5 });
    }
    _splash(x, y, big) {
      const n = big ? 16 : 8;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * (big ? 2.2 : 1.4);
        this.parts.push({ x, y, h: 0.05, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vh: 2 + Math.random() * (big ? 4 : 2.5), life: 0.4 + Math.random() * 0.4, t: 0, color: i % 3 ? '#e8f6fc' : '#aadcf0', size: 2 + Math.random() * 3.5 });
      }
      this.sfx.splash();
    }
    _explodeShip(t) {
      const cols = [t.i === 0 ? '#e84c3d' : '#3a7bd5', '#f5a623', '#4a5560', '#ffd9a0'];
      // debris: more, faster, bigger
      for (let i = 0; i < 64; i++) {
        const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 5;
        this.parts.push({
          x: t.x, y: t.y, h: 0.4 + Math.random() * 0.4,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vh: 2 + Math.random() * 5,
          life: 0.55 + Math.random() * 0.7, t: 0, color: cols[i % 4], size: 3 + Math.random() * 5
        });
      }
      // fireball flash at the core
      for (let i = 0; i < 6; i++) {
        this.parts.push({
          x: t.x, y: t.y, h: 0.5, vx: (Math.random() - 0.5) * 1.2, vy: (Math.random() - 0.5) * 1.2, vh: 0.6,
          life: 0.2 + Math.random() * 0.2, t: 0, color: i % 2 ? '#ffffff' : '#ffcf5c', size: 11 + Math.random() * 9
        });
      }
      // expanding shockwave rings on the water
      this.parts.push({ x: t.x, y: t.y, h: 0, vx: 0, vy: 0, vh: 0, life: 0.5, t: 0, color: 'rgba(255,255,255,0.95)', size: 95, ring: true });
      this.parts.push({ x: t.x, y: t.y, h: 0, vx: 0, vy: 0, vh: 0, life: 0.85, t: 0, color: t.i === 0 ? 'rgba(255,140,120,0.8)' : 'rgba(140,180,255,0.8)', size: 135, ring: true });
      this._splash(t.x, t.y, true);
      this.shake = Math.max(this.shake || 0, 1);
      this.sfx.bigBoom();
    }

    _damageMe(t, dmg) {
      if (t.inv > 0 || !t.alive) return;
      if (t.shield > 0) { this.sfx.thunk(); return; }
      t.hp -= dmg;
      this.sfx.thunk();
      if (t.hp <= 0) {
        t.hp = 0;
        t.alive = false;
        t.respawn = 2.4;
        this._explodeShip(t);
        // credit the sinking locally on BOTH peers so the loser also detects game-over
        this.ships[1 - t.i].score++;
        if (this.mode === 'net') this.net.send({ t: 'd' });
        this._checkWin();
      }
    }

    _respawn(t) {
      const s = this.map.spawns[t.i];
      // pick a guaranteed-clear berth near own spawn, keeping distance from the enemy
      const foe = this.ships[1 - t.i];
      const foeD = (x, y) => (foe && foe.alive) ? Math.hypot(foe.x - x, foe.y - y) : 99;
      let bx = s.x, by = s.y, bestScore = -Infinity;
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
        const x = Math.floor(s.x) + dx + 0.5, y = Math.floor(s.y) + dy + 0.5;
        if (x < 1 || y < 1 || x > this.map.N - 1 || y > this.map.N - 1) continue;
        if (this._shipBlocked(Math.floor(x), Math.floor(y))) continue;
        const score = Math.min(foeD(x, y), 5) - Math.hypot(dx, dy) * 0.4;
        if (score > bestScore) { bestScore = score; bx = x; by = y; }
      }
      t.x = bx; t.y = by;
      t.a = Math.atan2(this.map.N / 2 - by, this.map.N / 2 - bx);
      t.hp = 5; t.alive = true; t.inv = 2.2;
      t.shield = 0; t.speed = 0; t.rapid = 0; t.homing = 0; t.rockets = 0; t.mines = 0; t.tcool = 0; t.bcool = 0; t.mscool = 0; t.mncool = 0;
    }

    _spawnPu() {
      for (let tries = 0; tries < 30; tries++) {
        const x = 1 + Math.floor(Math.random() * (this.map.N - 2));
        const y = 1 + Math.floor(Math.random() * (this.map.N - 2));
        if (mapOb(this.map, x, y) || mapH(this.map, x, y) > 0) continue;
        if (this.map.spawns.some(s => Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) < 3)) continue;
        const pu = { id: this.puId++, x: x + 0.5, y: y + 0.5, k: PU_KINDS[(Math.random() * PU_KINDS.length) | 0] };
        this.pus.push(pu);
        if (this.mode === 'net') this.net.send({ t: 'pu', id: pu.id, x: pu.x, y: pu.y, k: pu.k });
        return;
      }
    }

    _update(dt) {
      if (this.state !== 'play') {
        this._updParts(dt);
        return;
      }
      const localIdxs = this.mode === 'net' ? [this.myIdx] : [0, 1];
      for (const t of this.ships) {
        t.cool -= dt; t.tcool -= dt; t.bcool -= dt; t.mscool -= dt; t.mncool -= dt; t.inv = Math.max(0, t.inv - dt);
        for (const b of ['shield', 'speed', 'rapid']) if (typeof t[b] === 'number') t[b] = Math.max(0, t[b] - dt);
        if (localIdxs.includes(t.i)) {
          if (t.alive) this._moveShip(t, this._controlOf(t.i), dt);
          else { t.respawn -= dt; if (t.respawn <= 0) this._respawn(t); }
        } else if (t.net) {
          const k = Math.min(1, dt * 12);
          t.x += (t.net.x - t.x) * k; t.y += (t.net.y - t.y) * k;
          let da = t.net.a - t.a;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          t.a += da * k;
          t.anim += dt * (Math.hypot(t.net.x - t.x, t.net.y - t.y) > 0.01 ? 1 : 0);
        }
        /* wake foam behind moving ships */
        const moved = Math.hypot(t.x - t.px, t.y - t.py);
        t.velx = dt > 0 ? (t.x - t.px) / dt : 0;
        t.vely = dt > 0 ? (t.y - t.py) / dt : 0;
        t.wakeT -= dt;
        if (t.alive && moved > 0.004 && t.wakeT <= 0) {
          t.wakeT = 0.07;
          const wx = t.x - Math.cos(t.a) * 0.42 + (Math.random() - 0.5) * 0.16;
          const wy = t.y - Math.sin(t.a) * 0.42 + (Math.random() - 0.5) * 0.16;
          this.parts.push({ x: wx, y: wy, h: 0.02, vx: 0, vy: 0, vh: 0.15, life: 0.7 + Math.random() * 0.4, t: 0, color: '#e8f6fc', size: 2 + Math.random() * 2.5 });
        }
        t.px = t.x; t.py = t.y;
      }

      /* shells & torpedoes */
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        // seek: homing torpedoes turn hard, plain torpedoes get a gentle nudge; missiles are ballistic
        const seek = b.guided ? 2.2 : (b.tp ? 0.6 : 0);
        if (seek > 0) {
          const tgt = this.ships[b.target >= 0 ? b.target : 1 - b.owner];
          if (tgt && tgt.alive) {
            const desired = Math.atan2(tgt.y - b.y, tgt.x - b.x);
            let cur = Math.atan2(b.dy, b.dx), da = desired - cur;
            while (da > Math.PI) da -= Math.PI * 2;
            while (da < -Math.PI) da += Math.PI * 2;
            // plain torpedoes only track targets roughly ahead and reasonably close
            if (b.guided || (Math.abs(da) < 0.85 && Math.hypot(tgt.x - b.x, tgt.y - b.y) < 7)) {
              const maxTurn = seek * dt;
              da = da > maxTurn ? maxTurn : da < -maxTurn ? -maxTurn : da;
              cur += da;
              const sp = Math.hypot(b.dx, b.dy) || 4.2;
              b.dx = Math.cos(cur) * sp; b.dy = Math.sin(cur) * sp;
            }
          }
        }
        if (b.tp) {   // torpedo bubble trail
          b.tr = (b.tr || 0) - dt;
          if (b.tr <= 0) {
            b.tr = 0.06;
            this.parts.push({ x: b.x, y: b.y, h: 0.03, vx: 0, vy: 0, vh: 0.4, life: 0.5, t: 0, color: b.guided ? '#d9c2ff' : '#d5eefa', size: 1.6 + Math.random() * 1.8 });
          }
        } else if (b.rk || b.ms) {   // rocket/missile smoke trail
          b.tr = (b.tr || 0) - dt;
          if (b.tr <= 0) {
            b.tr = 0.04;
            this.parts.push({ x: b.x, y: b.y, h: b.h, vx: 0, vy: 0, vh: 0.3, life: 0.4, t: 0, color: Math.random() < 0.5 ? '#ffb35c' : '#d9d3be', size: 1.8 + Math.random() * 2 });
          }
        }
        b.x += b.dx * dt; b.y += b.dy * dt;
        if (b.ms) { b.h += b.hv * dt; b.hv -= 24 * dt; }   // missile climbs steeply then dives
        else if (!b.tp && !b.rk) b.h -= 0.5 * dt;   // cannon shells arc down
        b.life -= dt;
        let dead = b.life <= 0 || b.x < 0 || b.y < 0 || b.x >= this.map.N || b.y >= this.map.N;
        if (dead && b.life <= 0 && !b.ms && b.x >= 0 && b.y >= 0 && b.x < this.map.N && b.y < this.map.N) {
          this._splash(b.x, b.y, b.tp);   // ran out of steam — plop
        }
        if (!dead) {
          const tx = Math.floor(b.x), ty = Math.floor(b.y);
          const ob = mapOb(this.map, tx, ty);
          const th = mapH(this.map, tx, ty);
          if (ob && (b.tp || b.h < 0.9)) {
            dead = true;
            for (let s = 0; s < 5; s++) this._spark(b.x, b.y, Math.max(0.2, b.h), '#9aa0a6');
            this.sfx.thunk();
          } else if (th > b.h) {
            // slammed into an island
            dead = true;
            if (b.tp) {
              for (let s = 0; s < 8; s++) this._spark(b.x, b.y, 0.4, '#c9b071');
              this.sfx.thunk();
            } else {
              for (let s = 0; s < 5; s++) this._spark(b.x, b.y, th, '#c9b071');
              if (localIdxs.includes(b.owner)) this._terraform(tx, ty, (b.rk || b.ms) ? 2 : 1, true);
            }
          } else if (!b.tp && b.h <= 0) {
            // shell dropped into the sea
            dead = true;
            if (!b.ms) this._splash(b.x, b.y, false);
          }
        }
        if (!dead) {
          for (const t of this.ships) {
            if (!t.alive || t.i === b.owner) continue;
            const rad = b.tp ? 0.62 : 0.55;
            if (Math.hypot(t.x - b.x, t.y - b.y) < rad && b.h < 1.2) {
              dead = true;
              for (let s = 0; s < 6; s++) this._spark(b.x, b.y, 0.5, b.tp ? '#ffb35c' : '#ffd76e');
              if (b.tp) this._splash(b.x, b.y, true);
              const mine = this.mode !== 'net' || t.i === this.myIdx;
              if (mine && !b.ms) this._damageMe(t, b.dmg);   // missiles damage via their blast
              break;
            }
          }
        }
        if (dead) {
          if (b.ms && b.x >= 0 && b.y >= 0 && b.x < this.map.N && b.y < this.map.N) this._missileBlast(b);
          this.bullets.splice(i, 1);
        }
      }

      /* the sea monster — lurks at its lair; the bubbling dark shadow is the hint. Stray in and it strikes */
      const mo = this.monster;
      if (mo) {
        mo.t += dt;
        if (mo.state === 'lurk') {
          mo.cool -= dt;
          mo.bubT -= dt;
          if (mo.bubT <= 0) {   // tell-tale bubbles over the lair
            mo.bubT = 0.45 + Math.random() * 0.85;
            const a = Math.random() * Math.PI * 2, r = Math.random() * 0.55;
            this.parts.push({ x: mo.x + Math.cos(a) * r, y: mo.y + Math.sin(a) * r, h: 0.02, vx: 0, vy: 0, vh: 0.28, life: 0.9 + Math.random() * 0.6, t: 0, color: 'rgba(225,246,252,0.9)', size: 1.5 + Math.random() * 2.2 });
          }
          if (mo.cool <= 0 && this.ships.some(t => t.alive && t.inv <= 0 && Math.hypot(t.x - mo.x, t.y - mo.y) < 1.7)) {
            mo.state = 'rise'; mo.t = 0;
            this._splash(mo.x, mo.y, false);
            this.sfx.blip(95, 45, 0.5, 'sawtooth', 0.1);
          }
        } else if (mo.state === 'rise') {
          if (mo.t > 0.55) {
            mo.state = 'attack'; mo.t = 0;
            this._splash(mo.x, mo.y, true);
            this.shake = Math.max(this.shake || 0, 0.7);
            this.sfx.roar();
            for (const t of this.ships) {
              if (!t.alive || Math.hypot(t.x - mo.x, t.y - mo.y) > 2.2) continue;
              const own = this.mode !== 'net' || t.i === this.myIdx;
              if (own) this._damageMe(t, 2);
            }
            if (!mo.warned) { mo.warned = true; this._toast('Sea monster! Steer clear of the bubbles!'); }
          }
        } else if (mo.state === 'attack') {
          if (mo.t > 0.9) { mo.state = 'sink'; mo.t = 0; }
        } else if (mo.state === 'sink') {
          if (mo.t > 0.7) { mo.state = 'lurk'; mo.t = 0; mo.cool = 8 + Math.random() * 5; this._splash(mo.x, mo.y, false); }
        }
      }

      /* sea mines */
      for (let i = this.mines.length - 1; i >= 0; i--) {
        const mn = this.mines[i];
        mn.arm -= dt; mn.life -= dt;
        if (mn.life <= 0) { this._splash(mn.x, mn.y, false); this.mines.splice(i, 1); continue; }
        if (mn.arm > 0) continue;
        for (const t of this.ships) {
          if (!t.alive || t.inv > 0) continue;
          if (t.i === mn.owner && mn.life > 22) continue;   // grace period to clear your own drop
          if (Math.hypot(t.x - mn.x, t.y - mn.y) < 0.62) {
            const mine = this.mode !== 'net' || t.i === this.myIdx;
            if (!mine) continue;   // the ship's own peer detonates authoritatively
            this._mineBoom(mn, true);
            this.mines.splice(i, 1);
            this._damageMe(t, 2);
            break;
          }
        }
      }

      /* power-ups */
      const spawner = this.mode !== 'net' || this.myIdx === 0;
      if (spawner) {
        this.puNext -= dt;
        if (this.puNext <= 0 && this.pus.length < 3) { this._spawnPu(); this.puNext = 8 + Math.random() * 5; }
      }
      for (let i = this.pus.length - 1; i >= 0; i--) {
        const p = this.pus[i];
        for (const idx of localIdxs) {
          const t = this.ships[idx];
          if (t.alive && Math.hypot(t.x - p.x, t.y - p.y) < 0.6) {
            if (p.k === 'wind') t.speed = 8;
            if (p.k === 'hull') t.shield = 6;
            if (p.k === 'quick') t.rapid = 8;
            if (p.k === 'homing') t.homing = 3;
            if (p.k === 'rocket') t.rockets = 3;
            if (p.k === 'mine') t.mines = 3;
            this.sfx.pick();
            const who = this.mode === 'ai' ? (idx === 0 ? 'You' : 'Computer') : (idx === 0 ? 'Red' : 'Blue');
            this._toast(who + ' got ' + PU_NAME[p.k]);
            this.pus.splice(i, 1);
            if (this.mode === 'net') this.net.send({ t: 'pug', id: p.id });
            break;
          }
        }
      }

      this._updParts(dt);

      /* net state broadcast */
      if (this.mode === 'net') {
        this.sendT -= dt;
        if (this.sendT <= 0) {
          this.sendT = 1 / 15;
          const t = this.ships[this.myIdx];
          this.net.send({ t: 's', x: +t.x.toFixed(3), y: +t.y.toFixed(3), a: +t.a.toFixed(3), hp: t.hp, al: t.alive, sc: t.score, inv: t.inv, sh: t.shield, ho: t.homing, ro: t.rockets, mn: t.mines });
        }
      }

      this._updateHud();
    }

    _updParts(dt) {
      this.shake = Math.max(0, (this.shake || 0) - dt * 2);
      for (let i = this.parts.length - 1; i >= 0; i--) {
        const p = this.parts[i];
        p.t += dt;
        if (p.t >= p.life) { this.parts.splice(i, 1); continue; }
        if (p.ring) continue;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vh -= 9 * dt; p.h += p.vh * dt;
        if (p.h < 0) { p.h = 0; p.vh *= -0.4; }
      }
    }

    _updateHud() {
      for (let i = 0; i < 2; i++) {
        const t = this.ships[i], card = this.$('#pc' + i);
        card.querySelector('.score').textContent = t.score;
        const bar = card.querySelector('.hpbar');
        if (bar.children.length !== 5) {
          bar.innerHTML = '';
          for (let j = 0; j < 5; j++) { const d = document.createElement('span'); d.className = 'hp'; bar.appendChild(d); }
        }
        for (let j = 0; j < 5; j++) bar.children[j].className = 'hp' + (t.alive && j < t.hp ? ' f' + i : '');
        const buffs = [];
        if (t.speed > 0) buffs.push(['TAILWIND', PU_COLOR.wind]);
        if (t.shield > 0) buffs.push(['IRON HULL', PU_COLOR.hull]);
        if (t.rapid > 0) buffs.push(['QUICK LOAD', PU_COLOR.quick]);
        if (t.homing > 0) buffs.push(['HOMING ×' + t.homing, PU_COLOR.homing]);
        if (t.rockets > 0) buffs.push(['ROCKETS ×' + t.rockets, PU_COLOR.rocket]);
        if (t.mines > 0) buffs.push(['MINES ×' + t.mines, PU_COLOR.mine]);
        if (!t.alive) buffs.push(['REFITTING…', '#8a8168']);
        const bhtml = buffs.map(b => `<span class="buff" style="background:${b[1]}">${b[0]}</span>`).join('');
        const bel = card.querySelector('.buffs');
        if (bel.innerHTML !== bhtml) bel.innerHTML = bhtml;
      }
    }

    /* ----- rendering ----- */
    _depthBand(x, y, eh) {
      const fx = Math.floor(x), fy = Math.floor(y);
      const base = fx + fy;
      const hF = Math.max(
        mapH(this.map, fx + 1, fy),
        mapH(this.map, fx, fy + 1),
        mapH(this.map, fx + 1, fy + 1)
      );
      return base + (hF <= eh + 0.05 ? 1 : 0);
    }

    _render() {
      const cv = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = this.clientWidth || 800, H = this.clientHeight || 600;
      if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // play-table backdrop: sunny sea
      const g = ctx.createRadialGradient(W / 2, H * 0.35, 60, W / 2, H / 2, Math.max(W, H) * 0.8);
      g.addColorStop(0, '#9fd4ef');
      g.addColorStop(1, '#4a92c4');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      const N = this.map.N;
      const mapW = N * TILE_W + 16, mapHt = N * TILE_H + HSTEP * 3 + 50;
      const scale = Math.min(W * 0.99 / mapW, (H - 44) * 0.99 / mapHt);
      ctx.save();
      const shk = (this.shake || 0) > 0 ? this.shake * this.shake * 13 : 0;
      ctx.translate(
        W / 2 + (Math.random() - 0.5) * shk * 2,
        40 + ((H - 44) - (N * TILE_H + HSTEP * 3) * scale) / 2 + HSTEP * 3 * scale + (Math.random() - 0.5) * shk * 2
      );
      ctx.scale(scale, scale);

      const iso = (x, y, h) => [(x - y) * TILE_W / 2, (x + y) * TILE_H / 2 - h * HSTEP];

      // soft drop shadow under the whole diorama slab
      ctx.save();
      const [sx0, sy0] = iso(N / 2, N / 2, 0);
      ctx.translate(sx0, sy0 + 26);
      ctx.scale(1, 0.5);
      ctx.fillStyle = 'rgba(12,40,66,0.3)';
      ctx.beginPath();
      ctx.arc(0, 0, N * TILE_W / 2 * 0.78, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // collect entities keyed by depth row
      const ents = [];
      const db = (x, y, h) => this._depthBand(x, y, h);
      for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
        const ob = this.map.obst[ty * N + tx];
        if (ob) ents.push({ d: db(tx + 0.5, ty + 0.5, this.map.h[ty * N + tx]), z: tx + ty, kind: 'ob', tx, ty, ob });
      }
      for (const dc of this.map.deco) {
        ents.push({ d: db(dc.x + 0.5, dc.y + 0.5, this.map.h[dc.y * N + dc.x]), z: dc.x + dc.y, kind: 'palm', dc });
      }
      if (this.state === 'play' || this.state === 'over') {
        for (const t of this.ships) if (t.alive) ents.push({ d: db(t.x, t.y, 0), z: t.x + t.y, kind: 'ship', t });
      }
      for (const b of this.bullets) ents.push({ d: db(b.x, b.y, b.h), z: b.x + b.y, kind: 'bullet', b });
      for (const p of this.pus) ents.push({ d: db(p.x, p.y, 0), z: p.x + p.y, kind: 'pu', p });
      for (const mn of this.mines) ents.push({ d: db(mn.x, mn.y, 0), z: mn.x + mn.y, kind: 'mine', mn });
      if (this.monster && (this.state === 'play' || this.state === 'over')) {
        ents.push({ d: db(this.monster.x, this.monster.y, 0), z: this.monster.x + this.monster.y, kind: 'monster', mo: this.monster });
      }
      for (const p of this.parts) ents.push({ d: db(p.x, p.y, p.h), z: p.x + p.y, kind: 'part', p });
      ents.sort((a, b2) => a.d - b2.d || a.z - b2.z);
      let ei = 0;

      for (let d = 0; d <= (N - 1) * 2; d++) {
        for (let tx = Math.max(0, d - N + 1); tx <= Math.min(N - 1, d); tx++) {
          const ty = d - tx;
          this._drawTile(ctx, iso, tx, ty);
        }
        while (ei < ents.length && ents[ei].d === d) { this._drawEnt(ctx, iso, ents[ei]); ei++; }
      }
      while (ei < ents.length) { this._drawEnt(ctx, iso, ents[ei]); ei++; }

      ctx.restore();
    }

    _drawTile(ctx, iso, tx, ty) {
      const map = this.map, N = map.N;
      const h = map.h[ty * N + tx];
      const tint = map.tint[ty * N + tx];
      const shal = map.shallow[ty * N + tx];
      const a = iso(tx, ty, h), b = iso(tx + 1, ty, h), c = iso(tx + 1, ty + 1, h), dd = iso(tx, ty + 1, h);
      if (h === 0) {
        // water: plastic sea, gentle moving shimmer
        const wave = Math.sin(this.time * 1.6 + tx * 0.9 - ty * 0.6) * 2.5;
        if (shal) {
          ctx.fillStyle = `hsl(${185 - tint * 8}, 58%, ${58 + ((tx + ty) % 2 ? 2 : 0) + tint * 3 + wave * 0.6}%)`;
        } else {
          ctx.fillStyle = `hsl(${205 - tint * 10}, ${58 + tint * 6}%, ${42 + ((tx + ty) % 2 ? 2.5 : 0) + tint * 3 + wave}%)`;
        }
      } else {
        // island: sand at shore level, grass higher up
        if (h === 1) ctx.fillStyle = `hsl(${44 - tint * 6}, ${58 + tint * 6}%, ${66 + ((tx + ty) % 2 ? 2 : 0) + tint * 3}%)`;
        else ctx.fillStyle = `hsl(${112 - h * 6 - tint * 8}, ${48 + h * 4}%, ${38 + h * 4 + ((tx + ty) % 2 ? 3 : 0) + tint * 4}%)`;
      }
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(dd[0], dd[1]);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = h === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // foam sparkle on shoals
      if (shal) {
        ctx.strokeStyle = `rgba(255,255,255,${0.1 + 0.08 * Math.sin(this.time * 2.2 + tx * 1.7 + ty * 1.1)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo((a[0] + dd[0]) / 2, (a[1] + dd[1]) / 2);
        ctx.lineTo((b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
        ctx.stroke();
      }
      // side faces
      const edge = -0.7;
      const hR = tx + 1 >= N ? edge : map.h[ty * N + tx + 1];
      const hD = ty + 1 >= N ? edge : map.h[(ty + 1) * N + tx];
      if (h > hR) {
        const b2 = iso(tx + 1, ty, hR), c2 = iso(tx + 1, ty + 1, hR);
        ctx.fillStyle = h === 0 ? 'hsl(210, 55%, 28%)' : `hsl(40, 42%, ${38 + h * 4}%)`;
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(b2[0], b2[1]);
        ctx.closePath(); ctx.fill();
      }
      if (h > hD) {
        const c2 = iso(tx + 1, ty + 1, hD), d2 = iso(tx, ty + 1, hD);
        ctx.fillStyle = h === 0 ? 'hsl(212, 55%, 24%)' : `hsl(36, 38%, ${32 + h * 4}%)`;
        ctx.beginPath();
        ctx.moveTo(dd[0], dd[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(d2[0], d2[1]);
        ctx.closePath(); ctx.fill();
      }
    }

    _drawEnt(ctx, iso, e) {
      if (e.kind === 'ob') this._drawRock(ctx, iso, e);
      else if (e.kind === 'palm') this._drawPalm(ctx, iso, e.dc);
      else if (e.kind === 'ship') this._drawShip(ctx, iso, e.t);
      else if (e.kind === 'bullet') this._drawBullet(ctx, iso, e.b);
      else if (e.kind === 'pu') this._drawPu(ctx, iso, e.p);
      else if (e.kind === 'mine') this._drawMine(ctx, iso, e.mn);
      else if (e.kind === 'monster') this._drawMonster(ctx, iso, e.mo);
      else if (e.kind === 'part') this._drawPart(ctx, iso, e.p);
    }

    _shadow(ctx, x, y, r) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, 0.5);
      ctx.fillStyle = 'rgba(10,35,55,0.3)';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    _gloss(ctx, x, y, r) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(x - r * 0.3, y - r * 0.35, r * 0.32, r * 0.2, -0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    _drawRock(ctx, iso, e) {
      const [px, py] = iso(e.tx + 0.5, e.ty + 0.5, 0);
      // foam ring around a sea rock
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(1, 0.5);
      ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.12 * Math.sin(this.time * 2 + e.tx)})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      const grad = ctx.createRadialGradient(px - 6, py - 14, 3, px, py - 8, 22);
      grad.addColorStop(0, '#c7cdd4');
      grad.addColorStop(1, '#7c8590');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(px, py - 8, 19, 13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(px + 8, py - 14, 9, 7, 0.3, 0, Math.PI * 2);
      ctx.fill();
      this._gloss(ctx, px - 4, py - 12, 12);
    }

    _drawPalm(ctx, iso, dc) {
      const h = mapH(this.map, dc.x, dc.y);
      const [px, py] = iso(dc.x + 0.5, dc.y + 0.5, h);
      const lean = (dc.v - 0.5) * 0.5;
      this._shadow(ctx, px, py, 13);
      // curved trunk
      ctx.strokeStyle = '#a0743f';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + lean * 18, py - 14, px + lean * 26, py - 26);
      ctx.stroke();
      // fronds
      const cx = px + lean * 26, cy = py - 26;
      ctx.strokeStyle = '#3f9b3f';
      ctx.lineWidth = 4;
      for (let i = 0; i < 5; i++) {
        const ang = -Math.PI / 2 + (i - 2) * 0.62 + lean * 0.3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(cx + Math.cos(ang) * 12, cy + Math.sin(ang) * 12 - 4, cx + Math.cos(ang) * 19, cy + Math.sin(ang) * 19 + 5);
        ctx.stroke();
      }
      ctx.fillStyle = '#7ed957';
      ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.lineCap = 'butt';
    }

    _drawShip(ctx, iso, t) {
      const [px0, py0] = iso(t.x, t.y, 0);
      const bob = Math.sin(this.time * 2.2 + t.i * 1.7) * 1.6;
      const px = px0, py = py0 + bob * 0.4;
      const col = t.i === 0
        ? { body: '#e84c3d', dark: '#b03225', deck: '#f4e9d4' }
        : { body: '#3a7bd5', dark: '#2757a0', deck: '#eaf0f6' };
      if (t.inv > 0 && Math.floor(this.time * 8) % 2 === 0) ctx.globalAlpha = 0.35;
      this._shadow(ctx, px, py + 4, 30);
      // screen-space heading
      const vx = (Math.cos(t.a) - Math.sin(t.a)) * TILE_W / 2;
      const vy = (Math.cos(t.a) + Math.sin(t.a)) * TILE_H / 2;
      const sa = Math.atan2(vy, vx);
      ctx.save();
      ctx.translate(px, py - 8);
      ctx.scale(1, 0.78);
      ctx.rotate(sa);
      ctx.scale(1.3, 1.3);
      // hull
      const hullPath = (s) => {
        ctx.beginPath();
        ctx.moveTo(27 * s, 0);
        ctx.quadraticCurveTo(18 * s, -10 * s, 2 * s, -10.5 * s);
        ctx.lineTo(-16 * s, -10.5 * s);
        ctx.quadraticCurveTo(-25 * s, -10.5 * s, -25 * s, 0);
        ctx.quadraticCurveTo(-25 * s, 10.5 * s, -16 * s, 10.5 * s);
        ctx.lineTo(2 * s, 10.5 * s);
        ctx.quadraticCurveTo(18 * s, 10 * s, 27 * s, 0);
        ctx.closePath();
      };
      const bg = ctx.createLinearGradient(0, -12, 0, 12);
      bg.addColorStop(0, col.body);
      bg.addColorStop(1, col.dark);
      ctx.fillStyle = bg;
      hullPath(1); ctx.fill();
      // deck
      ctx.fillStyle = col.deck;
      hullPath(0.74); ctx.fill();
      // superstructure
      ctx.fillStyle = col.body;
      this._rr(ctx, -14, -4.5, 12, 9, 3); ctx.fill();
      this._gloss(ctx, -8, -2, 7);
      // funnel
      ctx.fillStyle = '#3d4652';
      ctx.beginPath(); ctx.arc(-8, 0, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#20262e';
      ctx.beginPath(); ctx.arc(-8, 0, 1.7, 0, Math.PI * 2); ctx.fill();
      // bow turret + barrel
      ctx.fillStyle = col.dark;
      this._rr(ctx, 11, -2.3, 17, 4.6, 2.3); ctx.fill();
      const tg = ctx.createRadialGradient(6, -3, 2, 9, 0, 10);
      tg.addColorStop(0, '#ffffff');
      tg.addColorStop(0.25, col.body);
      tg.addColorStop(1, col.dark);
      ctx.fillStyle = tg;
      ctx.beginPath(); ctx.arc(9, 0, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(27, 0, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // shield bubble
      if (t.shield > 0) {
        ctx.strokeStyle = 'rgba(90,220,240,0.85)';
        ctx.fillStyle = 'rgba(120,225,240,0.18)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(px, py - 9, 41, 30, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // hp pips
      const w = 42, x0 = px - w / 2;
      ctx.fillStyle = 'rgba(8,30,50,0.4)';
      this._rr(ctx, x0 - 2, py - 47, w + 4, 8, 4); ctx.fill();
      for (let j = 0; j < 5; j++) {
        ctx.fillStyle = j < t.hp ? (t.i === 0 ? '#ff6f61' : '#6fa8ff') : 'rgba(255,255,255,0.25)';
        this._rr(ctx, x0 + j * (w / 5) + 0.5, py - 45.5, w / 5 - 2, 5, 2.5); ctx.fill();
      }
      // weapon reload gauges under the ship: white = torpedo, orange = missile, gold = broadside, grey = mines
      if (t.alive) {
        const gauge = (x, cool, max, color) => {
          const y = py + 19;
          if (cool <= 0) {
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
          } else {
            const f = 1 - Math.min(1, Math.max(0, cool) / max);
            ctx.lineWidth = 2.2;
            ctx.strokeStyle = 'rgba(10,30,50,0.4)';
            ctx.beginPath(); ctx.arc(x, y, 3.3, 0, Math.PI * 2); ctx.stroke();
            ctx.strokeStyle = color;
            ctx.beginPath(); ctx.arc(x, y, 3.3, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
          }
        };
        gauge(px - 11, t.tcool, 2.8, 'rgba(255,255,255,0.8)');
        gauge(px, t.mscool, 8, 'rgba(255,125,80,0.95)');
        gauge(px + 11, t.bcool, 5, 'rgba(255,214,110,0.95)');
        if (t.mines > 0) gauge(px - 22, t.mncool, 1.0, 'rgba(150,165,180,0.95)');
      }
    }

    _drawBullet(ctx, iso, b) {
      const [px, py] = iso(b.x, b.y, b.h);
      if (b.ms) {
        // impact reticle where the missile will land
        if (b.ix !== undefined) {
          const [rx, ry] = iso(b.ix, b.iy, 0);
          const pul = 0.6 + 0.4 * Math.sin(this.time * 6);
          ctx.save();
          ctx.translate(rx, ry);
          ctx.scale(1, 0.5);
          ctx.strokeStyle = 'rgba(232,76,61,' + (0.35 + 0.3 * pul).toFixed(3) + ')';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 5]);
          ctx.beginPath(); ctx.arc(0, 0, 14 + pul * 3, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
        // ship-to-ship missile: finned dart with an exhaust flame
        const vx = (b.dx - b.dy) * TILE_W / 2, vy = (b.dx + b.dy) * TILE_H / 2;
        const sa = Math.atan2(vy, vx);
        const [sx, sy] = iso(b.x, b.y, 0);
        this._shadow(ctx, sx, sy, 5);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(sa);
        ctx.fillStyle = '#e8e4d8';
        this._rr(ctx, -8, -2.6, 14, 5.2, 2.6); ctx.fill();
        ctx.fillStyle = '#e8563a';
        ctx.beginPath(); ctx.moveTo(6, -2.6); ctx.quadraticCurveTo(11.5, 0, 6, 2.6); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#4a5560';
        ctx.beginPath(); ctx.moveTo(-8, -2.6); ctx.lineTo(-11, -4.4); ctx.lineTo(-8, 0); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-8, 2.6); ctx.lineTo(-11, 4.4); ctx.lineTo(-8, 0); ctx.closePath(); ctx.fill();
        ctx.fillStyle = Math.random() < 0.5 ? '#ffb35c' : '#ffd9a0';
        ctx.beginPath(); ctx.moveTo(-8, -1.6); ctx.lineTo(-13 - Math.random() * 3, 0); ctx.lineTo(-8, 1.6); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (b.tp) {
        // torpedo: half-submerged capsule pointing along its heading
        const vx = (b.dx - b.dy) * TILE_W / 2, vy = (b.dx + b.dy) * TILE_H / 2;
        const sa = Math.atan2(vy, vx);
        ctx.save();
        ctx.translate(px, py - 2);
        ctx.scale(1, 0.78);
        ctx.rotate(sa);
        ctx.fillStyle = '#4a5560';
        this._rr(ctx, -9, -3, 18, 6, 3); ctx.fill();
        ctx.fillStyle = b.guided ? '#b06bff' : '#e8a15a';
        ctx.beginPath(); ctx.arc(9, 0, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.ellipse(-2, -1.4, 5, 1.4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else {
        const [sx, sy] = iso(b.x, b.y, 0);
        this._shadow(ctx, sx, sy, 5);
        const grad = ctx.createRadialGradient(px - 1.5, py - 1.5, 0.5, px, py, 5);
        grad.addColorStop(0, b.rk ? '#ffb35c' : '#6a7076');
        grad.addColorStop(1, b.rk ? '#c23a1e' : '#22262a');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py, 4.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath(); ctx.arc(px - 1.4, py - 1.6, 1.2, 0, Math.PI * 2); ctx.fill();
      }
    }

    _drawPu(ctx, iso, p) {
      const [px, py0] = iso(p.x, p.y, 0);
      const py = py0 + Math.sin(this.time * 2.5 + p.id * 2.1) * 2;
      this._shadow(ctx, px, py0 + 2, 12);
      // buoy ring
      ctx.save();
      ctx.translate(px, py - 6);
      ctx.scale(1, 0.6);
      ctx.lineWidth = 8;
      ctx.strokeStyle = PU_COLOR[p.k];
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 8.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(0, 0, 11, -0.5, 0.6); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 11, Math.PI - 0.5, Math.PI + 0.6); ctx.stroke();
      ctx.restore();
      // little flag pole
      ctx.strokeStyle = '#5c5647';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, py - 10); ctx.lineTo(px, py - 24); ctx.stroke();
      ctx.fillStyle = PU_COLOR[p.k];
      ctx.beginPath();
      ctx.moveTo(px, py - 24); ctx.lineTo(px + 11, py - 20.5); ctx.lineTo(px, py - 17);
      ctx.closePath(); ctx.fill();
    }

    _drawMine(ctx, iso, mn) {
      const [px, py0] = iso(mn.x, mn.y, 0);
      const py = py0 + Math.sin(this.time * 2.8 + mn.id) * 1.5;
      this._shadow(ctx, px, py0 + 2, 9);
      ctx.fillStyle = '#39424c';
      ctx.beginPath(); ctx.arc(px, py - 5, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#39424c';
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + 0.3;
        ctx.beginPath();
        ctx.moveTo(px + Math.cos(a) * 7, py - 5 + Math.sin(a) * 7);
        ctx.lineTo(px + Math.cos(a) * 11, py - 5 + Math.sin(a) * 11);
        ctx.stroke();
      }
      this._gloss(ctx, px, py - 7, 6);
      const armed = mn.arm <= 0;
      ctx.fillStyle = armed && Math.floor(this.time * 4) % 2 === 0 ? '#ff4136' : '#7a2a24';
      ctx.beginPath(); ctx.arc(px, py - 13.5, 2.2, 0, Math.PI * 2); ctx.fill();
    }

    _drawMonster(ctx, iso, mo) {
      const [px, py] = iso(mo.x, mo.y, 0);
      const st = mo.state;
      // dark shape gliding under the water — the lair hint
      const pulse = 0.5 + Math.sin(this.time * 1.7) * 0.5;
      ctx.save();
      ctx.translate(px + Math.sin(this.time * 0.9) * 5, py + 2);
      ctx.scale(1, 0.5);
      ctx.fillStyle = 'rgba(13,54,64,' + (st === 'lurk' ? (0.14 + 0.09 * pulse).toFixed(3) : '0.3') + ')';
      ctx.beginPath(); ctx.arc(0, 0, 23 + pulse * 5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (st === 'lurk') return;
      let e = st === 'rise' ? mo.t / 0.55 : st === 'attack' ? 1 : 1 - mo.t / 0.7;
      e = Math.max(0, Math.min(1, e));
      e = e * e * (3 - 2 * e);
      const up = (1 - e) * 48;   // slides down below the waterline
      const bob = Math.sin(this.time * 5) * 2.5 * e;
      const body = '#2f6b5f';
      ctx.save();
      ctx.beginPath(); ctx.rect(px - 75, py - 95, 150, 100); ctx.clip();   // nothing shows below the waterline
      // neck + head
      ctx.strokeStyle = body; ctx.lineWidth = 15; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(px - 16, py + 2 + up); ctx.quadraticCurveTo(px - 26, py - 16 + up, px - 24, py - 28 + up + bob); ctx.stroke();
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.arc(px - 24, py - 30 + up + bob, 10.5, 0, Math.PI * 2); ctx.fill();
      // snout
      ctx.beginPath(); ctx.arc(px - 33, py - 27 + up + bob, 6, 0, Math.PI * 2); ctx.fill();
      // eyes
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(px - 27, py - 34 + up + bob, 3, 0, Math.PI * 2); ctx.arc(px - 20, py - 34 + up + bob, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#12262e';
      ctx.beginPath(); ctx.arc(px - 28, py - 34 + up + bob, 1.4, 0, Math.PI * 2); ctx.arc(px - 21, py - 34 + up + bob, 1.4, 0, Math.PI * 2); ctx.fill();
      // humps trailing behind, each with a little fin
      const humps = [[2, -6, 12], [20, -4, 9.5], [35, -2, 7]];
      for (let i = 0; i < humps.length; i++) {
        const hx = px + humps[i][0], hy = py + humps[i][1] + up + Math.sin(this.time * 5 + i * 1.4) * 2 * e, r = humps[i][2];
        ctx.fillStyle = body;
        ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(hx - 2, hy - r + 1); ctx.lineTo(hx + 2, hy - r - 6); ctx.lineTo(hx + 6, hy - r + 2);
        ctx.closePath(); ctx.fill();
        this._gloss(ctx, hx - r * 0.3, hy - r * 0.45, r * 0.7);
      }
      this._gloss(ctx, px - 27, py - 30 + up + bob, 7);
      ctx.restore();
      // foam at the waterline while surfaced
      if (e > 0.15) {
        ctx.save();
        ctx.translate(px, py + 2);
        ctx.scale(1, 0.5);
        ctx.globalAlpha = 0.7 * e;
        ctx.strokeStyle = '#e8f6fc'; ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.arc(0, 0, 30 + Math.sin(this.time * 4) * 3, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    _drawPart(ctx, iso, p) {
      if (p.ring) {
        const [px, py] = iso(p.x, p.y, 0);
        const f = p.t / p.life;
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(1, 0.5);
        ctx.globalAlpha = Math.max(0, 1 - f) * 0.85;
        ctx.lineWidth = 6 * (1 - f) + 1.5;
        ctx.strokeStyle = p.color;
        ctx.beginPath(); ctx.arc(0, 0, 8 + p.size * f, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = 1;
        return;
      }
      const [px, py] = iso(p.x, p.y, p.h);
      const f = 1 - p.t / p.life;
      ctx.globalAlpha = Math.max(0, f);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(px, py, p.size * (0.5 + f * 0.5), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    _rr(ctx, x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  customElements.define('battleship-game', BattleshipGame);
})();
