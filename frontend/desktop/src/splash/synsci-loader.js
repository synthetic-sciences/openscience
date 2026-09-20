/* <synsci-loader> v2 "assemble" — particles stream along the atom's three orbits and spiral into the mark.
   <script type="module" src="synsci-loader.js"></script>
   <synsci-loader size="160"></synsci-loader>                     indeterminate: the mark assembles and dissolves in a rotating sweep
   <synsci-loader size="160" progress="0.42" bar></synsci-loader>  determinate: the mark fills as progress goes 0 → 1
   el.progress = 0.8 · el.complete() · el.reset()
   attributes: size · progress (0–1) · caption="Loading" (text underneath, no bar) · bar · label · density (default 1) · speed (default 1) · state="done"
   colour follows CSS `color`; on dark surfaces a few particles pick up warm/cool tints (disable with mono). */
const G = {"d":"M1121.22,577.27c33.62-36.6,51.16-72.98,35.14-96.82-16.02-23.84-56.33-21.34-102.92-4.03-1.2-3.83-2.45-7.56-3.76-11.2-1.15-3.21-2.34-6.34-3.57-9.37-3.57-8.87-7.48-16.98-11.69-24.16-1.35-2.29-2.73-4.5-4.14-6.59-12.18-18.12-26.67-28.64-43.11-27.52-28.65,1.95-46.64,38.12-54.95,87.11-1.44,8.48-2.58,17.34-3.44,26.47-1.18,12.43-1.82,25.37-1.95,38.53-.11,10.84.13,21.83.72,32.83.01.33.03.65.05.98.12,2.31.27,4.63.43,6.94.16,2.31.33,4.62.52,6.93.03.33.05.66.09.99.58,7.02,1.3,14.02,2.16,20.96.48,3.91,1.01,7.8,1.58,11.65.77,5.24,1.61,10.43,2.54,15.54,2.76-1.19,5.54-2.42,8.33-3.7,5.49-2.51,11.02-5.19,16.57-8.02,5.92-3.02,11.85-6.21,17.77-9.55,9.72-5.48,19.4-11.37,28.89-17.57,1.94-1.27,3.88-2.55,5.8-3.84,1.93-1.29,3.84-2.6,5.75-3.92.35-.25.71-.49,1.06-.74,7.97-5.53,15.77-11.27,23.32-17.17-.35-.21-.71-.42-1.07-.63-7.89-4.67-16.01-9.17-24.26-13.46-1.5-.78-3.01-1.56-4.52-2.32-.29-.15-.58-.3-.88-.45-2.07-1.05-4.15-2.09-6.23-3.11-2.08-1.02-4.17-2.03-6.27-3.02-.29-.14-.59-.28-.88-.42-9.96-4.7-20.05-9.08-30.12-13.07-4.88-1.94-9.76-3.78-14.62-5.53.11-3.5.25-6.98.44-10.4.21-3.83.47-7.61.78-11.32.77-9.32,1.86-18.27,3.25-26.77,1.34-8.23,2.97-16.03,4.87-23.3,6.31-24.09,14.66-37.73,21.51-42.34,1.62-1.09,3.16-1.67,4.56-1.77,4.95-.34,12.32,5.08,20.19,17.32,3.84,5.95,7.78,13.53,11.64,22.84.12.3.24.6.36.9,1.35,3.29,2.65,6.71,3.9,10.24,1.29,3.64,2.53,7.4,3.72,11.28,2.53,8.23,4.82,16.96,6.85,26.08,8.45-4,16.76-7.53,24.8-10.58,7.8-2.95,15.37-5.44,22.62-7.43,29.69-8.14,47.12-5.6,51.24.52,4.12,6.13-.12,23.23-18.87,47.64-4.58,5.96-9.74,12.03-15.43,18.14-10.17-7.23-21.06-14.26-32.4-20.95-9.33-5.52-18.97-10.8-28.78-15.78-.29-.15-.58-.3-.88-.45-2.07-1.05-4.15-2.09-6.23-3.11-2.08-1.02-4.17-2.03-6.27-3.02-.29-.14-.59-.28-.88-.42-9.96-4.7-20.05-9.08-30.12-13.07-8.38-3.33-16.75-6.39-25.03-9.14-1.21,7.69-2.17,15.8-2.86,24.13-.08.94-.15,1.89-.22,2.85,9.87,3.43,19.96,7.35,30.14,11.71,7.82,3.35,15.7,6.96,23.57,10.82,5.5,2.7,10.92,5.46,16.21,8.3h0c2.28,1.21,4.54,2.45,6.78,3.69,6.08,3.38,12.01,6.83,17.74,10.34,3.63,2.22,7.18,4.47,10.65,6.74,3.21,2.09,6.35,4.2,9.42,6.33-2.74,2.53-5.57,5.05-8.47,7.55-8.08,7.02-16.72,13.97-25.82,20.77-6.81,5.1-13.88,10.11-21.16,15.01-7.28,4.89-14.59,9.54-21.89,13.92-9.73,5.85-19.44,11.23-28.99,16.06-3.42,1.73-6.81,3.4-10.19,4.99-8.45,3.99-16.75,7.53-24.8,10.58-7.8,2.95-15.37,5.44-22.61,7.43-29.68,8.14-47.13,5.6-51.24-.53-4.11-6.12.12-23.23,18.87-47.64,4.58-5.96,9.74-12.03,15.42-18.14,1.58-1.7,3.21-3.4,4.86-5.1.65-.66,1.3-1.33,1.96-1.99.55-.55,1.1-1.11,1.65-1.66.51-.5,1.01-1.01,1.53-1.51.7-.69,1.4-1.37,2.11-2.06,1.42-1.37,2.86-2.75,4.33-4.12.9-.84,1.81-1.68,2.72-2.52-1.02-.71-2.04-1.42-3.04-2.13-.95-.68-1.9-1.36-2.84-2.03-.86-.62-1.71-1.25-2.56-1.87-.65-.48-1.29-.95-1.93-1.43-.48-.36-.97-.72-1.44-1.08-.5-.37-.99-.74-1.48-1.12-.51-.39-1.02-.78-1.52-1.17-.06-.04-.11-.08-.16-.12-.74-.57-1.47-1.13-2.19-1.71-1.5-1.18-2.97-2.36-4.41-3.54-6.46-5.28-12.4-10.58-17.74-15.87-21.89-21.64-28.41-38.01-25.17-44.64,3.25-6.63,20.18-11.51,50.7-7.48,3.84.51,7.77,1.13,11.79,1.88.87-9.01,2.03-17.77,3.43-26.03.02-.12.04-.25.06-.37-32.8-5.95-60.83-4.83-77.54,6.4-5.32,3.58-9.49,8.19-12.3,13.92-12.63,25.79,9.69,59.45,47.97,91.14-33.62,36.59-51.17,72.98-35.15,96.81,16.02,23.84,56.34,21.34,102.92,4.03,8.06-2.99,16.31-6.43,24.65-10.25,11.35-5.2,22.88-11.11,34.34-17.58,9.72-5.48,19.4-11.37,28.89-17.57,1.94-1.27,3.88-2.55,5.8-3.84,1.93-1.29,3.84-2.6,5.75-3.92,9.33-6.45,18.43-13.18,27.18-20.11,10.32-8.17,20.15-16.61,29.25-25.16,6.46,5.28,12.4,10.58,17.74,15.87,21.89,21.64,28.41,38.01,25.16,44.64-3.25,6.62-20.18,11.51-50.7,7.48-3.83-.5-7.76-1.14-11.78-1.88-3.8-.71-7.69-1.51-11.63-2.41-.91-.21-1.82-.42-2.74-.64-.14-.03-.29-.06-.42-.1-.78-.19-1.56-.38-2.34-.58-.82-.2-1.64-.41-2.46-.62-1.07-.28-2.15-.56-3.22-.85-.9-.24-1.81-.49-2.72-.74-.69-.19-1.37-.38-2.05-.58-3.32-.94-6.68-1.94-10.06-3-.78,9.32-1.86,18.27-3.25,26.77-1.34,8.23-2.97,16.03-4.87,23.3-7.8,29.78-18.71,43.61-26.07,44.11-7.36.5-20.06-11.72-31.82-40.17-1.48-3.57-2.9-7.29-4.27-11.15-8.26,3.76-16.42,7.13-24.26,10.04-.12.04-.24.09-.35.13,14.84,41.38,36.18,69.45,62.52,67.65,6.37-.44,12.21-2.56,17.53-6.14,18.64-12.52,30.96-42.87,37.41-80.98,3.92.87,7.78,1.66,11.58,2.34,32.8,5.95,60.83,4.83,77.54-6.4,5.33-3.58,9.5-8.18,12.31-13.91,12.63-25.79-9.69-59.45-47.97-91.14ZM970.22,575.07c7.34,3.14,14.73,6.52,22.12,10.12-5.58,3.66-11.17,7.17-16.76,10.51-6.52,3.92-13.02,7.62-19.48,11.09-.62-5.98-1.15-12.04-1.56-18.15-.47-6.85-.79-13.64-.98-20.34,5.51,2.12,11.07,4.38,16.66,6.77Z","vb":[780,365,440,440],"cx":998.57,"cy":586.54,"rx":187.33,"ry":44.66,"rots":[-34,26,86],"signs":[-1,1,-1]};
const MARK = new Path2D(G.d), TAU = Math.PI * 2;
const mulberry = (s) => () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
let CAND = null;                                     // mark pixels, sampled once for every instance
function candidates() {
  if (CAND) return CAND;
  const S = 220, c = document.createElement("canvas"); c.width = c.height = S;
  const g = c.getContext("2d"), k = S / G.vb[2]; g.setTransform(k, 0, 0, k, -G.vb[0] * k, -G.vb[1] * k); g.fill(MARK);
  const a = g.getImageData(0, 0, S, S).data, out = [];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (a[(y * S + x) * 4 + 3] > 128) out.push(G.vb[0] + x / k, G.vb[1] + y / k);
  return (CAND = { pts: out, cell: 1 / k });
}
const ease = (x) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

class SynSciLoader extends HTMLElement {
  static get observedAttributes() { return ["size", "density", "bar", "label", "caption", "progress", "state"]; }
  connectedCallback() {
    if (!this.shadowRoot) {
      const r = this.attachShadow({ mode: "open" });
      r.innerHTML = `<style>
        :host{display:inline-flex;flex-direction:column;align-items:center;gap:.9em;line-height:1;vertical-align:middle;font:500 12px/1 ui-sans-serif,system-ui,-apple-system,sans-serif}
        canvas{display:block}
        .bar{display:none;width:var(--w);max-width:100%}:host([bar]) .bar{display:block}
        .track{height:2px;border-radius:2px;background:color-mix(in srgb,currentColor 16%,transparent);overflow:hidden}
        .fill{height:100%;width:100%;background:currentColor;border-radius:2px;transform-origin:0 50%;transform:scaleX(0)}
        .fill.ind{animation:ind 1.6s cubic-bezier(.6,0,.3,1) infinite}
        @keyframes ind{0%{transform:translateX(-100%) scaleX(.35)}100%{transform:translateX(100%) scaleX(.35)}}
        .row{display:flex;justify-content:space-between;margin-top:.7em;opacity:.62;font-variant-numeric:tabular-nums;letter-spacing:.01em}
        .cap{display:none;opacity:.62;letter-spacing:.01em;white-space:nowrap;position:relative}.cap b{position:absolute;left:100%;font-weight:inherit;padding-left:.12em}:host([caption]) .cap{display:block}
        .cap i{font-style:normal;animation:dot 1.4s infinite both}.cap i:nth-child(2){animation-delay:.2s}.cap i:nth-child(3){animation-delay:.4s}
        @keyframes dot{0%,20%{opacity:0}50%,100%{opacity:1}}
        @media (prefers-reduced-motion:reduce){.cap i{animation:none}.fill.ind{animation-duration:4s}}
      </style><canvas role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100"></canvas>
      <div class="cap" aria-hidden="true"><span class="capt"></span><b><i>.</i><i>.</i><i>.</i></b></div>
      <div class="bar"><div class="track"><div class="fill"></div></div><div class="row"><span class="lab"></span><span class="pct"></span></div></div>`;
      this.c = r.querySelector("canvas"); this.g = this.c.getContext("2d");
      this.$fill = r.querySelector(".fill"); this.$pct = r.querySelector(".pct"); this.$lab = r.querySelector(".lab"); this.$cap = r.querySelector(".capt"); this.$dots = r.querySelectorAll(".cap i");
    }
    this.t = 0; this.last = 0; this.shown = 0; this.K = 0; this.burst = -1;
    this.still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.build();
    const tick = (now) => { if (!this.isConnected) return; this.step(Math.min(0.05, (now - (this.last || now)) / 1000)); this.last = now; this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }
  disconnectedCallback() { cancelAnimationFrame(this.raf); }
  attributeChangedCallback(n) { if (!this.c) return; if (n === "size" || n === "density") this.build(); if (n === "state" && this.getAttribute("state") === "done") this.burst = 0; }
  get progress() { return this.hasAttribute("progress") ? Math.max(0, Math.min(1, parseFloat(this.getAttribute("progress")) || 0)) : null; }
  set progress(v) { v == null ? this.removeAttribute("progress") : this.setAttribute("progress", v); }
  complete() { this.setAttribute("state", "done"); }
  reset() { this.removeAttribute("state"); this.K = 0; this.burst = -1; this.shown = 0; for (let i = 0; i < this.N; i++) this.e[i] = 0; }

  build() {
    const s = this.s = parseFloat(this.getAttribute("size")) || 96, dpr = this.dpr = Math.min(3, devicePixelRatio || 1);
    this.c.width = this.c.height = Math.round(s * dpr); this.c.style.width = this.c.style.height = s + "px"; this.style.setProperty("--w", Math.max(120, s) + "px");
    const dens = parseFloat(this.getAttribute("density")) || 1;
    const N = this.N = Math.round(Math.max(260, Math.min(9000, s * s * 0.085)) * dens), rnd = mulberry(1337), C = candidates();
    const f = (n) => new Float32Array(n);
    this.tx = f(N); this.ty = f(N); this.e = f(N); this.a = f(N); this.u0 = f(N); this.w = f(N); this.jr = f(N); this.jn = f(N); this.sw = f(N); this.ph = f(N); this.rate = f(N);
    this.orb = new Uint8Array(N); this.col = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const c = (rnd() * (C.pts.length / 2)) | 0;
      const x = this.tx[i] = C.pts[c * 2] + rnd() * C.cell, y = this.ty[i] = C.pts[c * 2 + 1] + rnd() * C.cell;
      const dx = x - G.cx, dy = y - G.cy;
      this.ang = 0; this.a[i] = Math.atan2(dy, dx) / TAU + 0.5;                        // angle around the mark 0..1 (fill order)
      this.u0[i] = rnd() * TAU; this.w[i] = (0.55 + 0.5 * rnd()) * (rnd() < 0.5 ? 1 : 1);
      this.jr[i] = 1 + (rnd() - 0.5) * 0.34 + (rnd() < 0.12 ? (rnd() - 0.5) * 0.7 : 0);   // radial spread of the stream
      this.jn[i] = (rnd() - 0.5) * 2; this.sw[i] = 1.2 + 1.8 * rnd(); this.ph[i] = rnd() * TAU; this.rate[i] = 0.75 + 0.9 * rnd();
      this.orb[i] = i % 3; const r = rnd(); this.col[i] = r < 0.8 ? 0 : r < 0.91 ? 1 : 2;
    }
  }

  step(dt) {
    const sp = (parseFloat(this.getAttribute("speed")) || 1) * (this.still ? 0.3 : 1); this.t += dt * sp;
    const done = this.getAttribute("state") === "done", p = this.progress;
    const target = done ? 1 : p == null ? 0 : p; this.shown += (target - this.shown) * Math.min(1, dt * 6);
    this.K += ((done ? 1 : 0) - this.K) * Math.min(1, dt * 3.2); if (this.burst >= 0) this.burst += dt;
    const N = this.N, e = this.e, a = this.a, t = this.t, ind = p == null && !done, head = (t * 0.16) % 1;
    for (let i = 0; i < N; i++) {
      let want;
      if (done) want = 1;
      else if (ind) { const d = (a[i] - head + 1) % 1; want = d < 0.42 ? 1 : 0; }               // rotating 42 % sweep
      else want = (a[i] * 0.86 + 0.14 * ((this.ph[i] / TAU))) < this.shown ? 1 : 0;              // angular fill, slightly dithered
      const r = (want ? 1.15 : 0.8) * this.rate[i] * sp * (done ? 1.6 : 1);
      e[i] += Math.max(-r * dt, Math.min(r * dt, want - e[i]));
    }
    this.draw();
    if (this.hasAttribute("bar")) {
      if (ind) { this.$fill.classList.add("ind"); this.$fill.style.transform = ""; this.$pct.textContent = ""; }
      else { this.$fill.classList.remove("ind"); this.$fill.style.transform = `scaleX(${this.shown.toFixed(4)})`; this.$pct.textContent = Math.round(this.shown * 100) + "%"; }
      this.$lab.textContent = done ? (this.getAttribute("done-label") || "Ready") : (this.getAttribute("label") || "Loading");
    }
    if (this.hasAttribute("caption")) {
      const txt = done ? (this.getAttribute("done-label") || this.getAttribute("caption") || "Loading") : (this.getAttribute("caption") || "Loading");
      if (this.$cap.textContent !== txt) this.$cap.textContent = txt; this.$dots.forEach((d) => d.style.display = done ? "none" : "");
    }
    if (p != null) this.c.setAttribute("aria-valuenow", Math.round(this.shown * 100)); else this.c.removeAttribute("aria-valuenow");
  }

  draw() {
    const g = this.g, px = this.c.width, k = px / G.vb[2], t = this.t, N = this.N, K = this.K;
    const cs = getComputedStyle(this).color, m = cs.match(/[\d.]+/g) || [237, 236, 236], R = +m[0], Gc = +m[1], B = +m[2];
    const dark = (0.2126 * R + 0.7152 * Gc + 0.0722 * B) > 140, tint = dark && !this.hasAttribute("mono");
    const COLS = [[R, Gc, B], tint ? [255, 205, 155] : [R, Gc, B], tint ? [150, 190, 255] : [R, Gc, B]];
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.clearRect(0, 0, px, px);
    g.setTransform(k, 0, 0, k, -G.vb[0] * k, -G.vb[1] * k);
    // faint ghost of the mark so the destination always reads
    g.globalAlpha = 0.055 + 0.02 * Math.sin(t * 1.7); g.fillStyle = cs; g.fill(MARK);
    g.globalCompositeOperation = dark ? "lighter" : "source-over";
    const unit = 1 / k, base = Math.max(1.05 * this.dpr, px / 190) * unit;                    // particle edge in mark units
    const B_ = 6, buckets = Array.from({ length: 3 * B_ }, () => []);
    let landed = 0;
    for (let i = 0; i < N; i++) {
      const ee = ease(this.e[i]), o = this.orb[i], th = G.rots[o] * Math.PI / 180, u = this.u0[i] + t * this.w[i] * 1.5;
      const cu = Math.cos(u), su = Math.sin(u), ex = G.rx * this.jr[i] * cu, ey = (G.ry * this.jr[i] + this.jn[i] * 9) * su;
      let x = G.cx + ex * Math.cos(th) - ey * Math.sin(th), y = G.cy + ex * Math.sin(th) + ey * Math.cos(th);
      const zf = 0.5 + 0.5 * G.signs[o] * su;                                                   // pseudo depth on the orbit
      x += (this.tx[i] - x) * ee; y += (this.ty[i] - y) * ee;
      const swl = this.sw[i] * (1 - ee) * (1 - ee) * ee * 2.2, c = Math.cos(swl), s = Math.sin(swl), dx = x - G.cx, dy = y - G.cy;
      x = G.cx + dx * c - dy * s; y = G.cy + dx * s + dy * c;
      if (ee > 0.98) { landed++; x += Math.sin(3.1 * t + this.ph[i]) * 0.55; y += Math.cos(2.6 * t + this.ph[i]) * 0.55; }
      const al = ((0.2 + 0.55 * zf) * (1 - ee) + 0.92 * ee) * (1 - 0.85 * K), sz = base * ((0.85 + 0.75 * zf) * (1 - ee) + 1.0 * ee);
      const b = buckets[this.col[i] * B_ + Math.min(B_ - 1, (al * B_) | 0)]; b.push(x - sz / 2, y - sz / 2, sz);
    }
    for (let q = 0; q < buckets.length; q++) {
      const b = buckets[q]; if (!b.length) continue; const cc = COLS[(q / B_) | 0];
      g.globalAlpha = ((q % B_) + 0.6) / B_; g.fillStyle = `rgb(${cc[0]},${cc[1]},${cc[2]})`; g.beginPath();
      for (let j = 0; j < b.length; j += 3) g.rect(b[j], b[j + 1], b[j + 2], b[j + 2]); g.fill();
    }
    const f = landed / N;                                                                        // halo grows as the mark assembles
    if (f > 0.02 && dark) { g.save(); g.globalAlpha = 0.16 * f * (1 - K) + 0.3 * K; g.shadowColor = cs; g.shadowBlur = 26 * k * this.dpr / this.dpr; g.fillStyle = cs; g.fill(MARK); g.restore(); }
    g.globalCompositeOperation = "source-over";
    if (K > 0.004) { g.globalAlpha = K; g.fillStyle = cs; g.fill(MARK); }                        // complete: the mark goes solid
    if (this.burst >= 0 && this.burst < 1.1) {                                                   // and a shockwave ring leaves it
      const q = this.burst / 1.1, r = 120 + 150 * (1 - Math.pow(1 - q, 3));
      g.globalAlpha = 0.5 * (1 - q) * (1 - q); g.strokeStyle = cs; g.lineWidth = 5 * (1 - q) + 0.6; g.beginPath(); g.arc(G.cx, G.cy, r, 0, TAU); g.stroke();
    }
    g.globalAlpha = 1;
  }
}
if (!customElements.get("synsci-loader")) customElements.define("synsci-loader", SynSciLoader);
export { SynSciLoader };
