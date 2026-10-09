/* visualizer.js - canvas renderers fed by the player's analyser node */
(function (root) {
  'use strict';

  const MODES = ['bars', 'wave', 'ring', 'particles'];
  const BG = '#07070c';

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  class Visualizer {
    constructor(canvas, player) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.player = player;
      this.mode = 'bars';
      this.hue = 215;
      this.freq = new Uint8Array(1024);
      this.time = new Uint8Array(2048);
      this.bass = 0;
      this.energy = 0;
      this.peaks = new Float32Array(0);
      this.particles = [];
      this.angle = 0;
      this.cover = null;
      this.running = false;
      this.last = performance.now();
      this.sampleRate = 44100;
      this.resize();
      root.addEventListener('resize', () => this.resize());
    }

    resize() {
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      this.w = root.innerWidth;
      this.h = root.innerHeight;
      this.canvas.width = Math.max(1, Math.floor(this.w * dpr));
      this.canvas.height = Math.max(1, Math.floor(this.h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.clear();
    }

    clear() { this.ctx.fillStyle = BG; this.ctx.fillRect(0, 0, this.w, this.h); }

    setMode(m) {
      if (!MODES.includes(m)) return this.mode;
      this.mode = m;
      this.clear();
      return m;
    }
    nextMode() { return this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); }

    setCover(url) {
      this.cover = null;
      if (!url) return;
      const img = new Image();
      img.onload = () => { this.cover = img; };
      img.src = url;
    }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = (t) => {
        if (!this.running) return;
        this.frame(t);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    stop() { this.running = false; }

    sample() {
      const a = this.player.analyser;
      if (a) {
        if (this.freq.length !== a.frequencyBinCount) {
          this.freq = new Uint8Array(a.frequencyBinCount);
          this.time = new Uint8Array(a.fftSize);
        }
        a.getByteFrequencyData(this.freq);
        a.getByteTimeDomainData(this.time);
        this.sampleRate = this.player.ctx.sampleRate;
      } else {
        this.freq.fill(0);
        this.time.fill(128);
      }
      let b = 0;
      for (let i = 1; i < 10; i++) b += this.freq[i];
      b /= 9 * 255;
      this.bass += (b - this.bass) * 0.3;
      let e = 0;
      const step = 4;
      for (let i = 0; i < this.freq.length; i += step) e += this.freq[i];
      e /= (this.freq.length / step) * 255;
      this.energy += (e - this.energy) * 0.2;
    }

    /* n log-spaced bands between lo..hi Hz, each 0..1 */
    bands(n, lo = 30, hi = 16000) {
      const nyq = this.sampleRate / 2, bins = this.freq.length;
      hi = Math.min(hi, nyq);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const f0 = lo * Math.pow(hi / lo, i / n), f1 = lo * Math.pow(hi / lo, (i + 1) / n);
        let b0 = Math.min(bins - 1, Math.floor(f0 / nyq * bins));
        let b1 = Math.min(bins, Math.max(b0 + 1, Math.floor(f1 / nyq * bins)));
        let m = 0;
        for (let k = b0; k < b1; k++) if (this.freq[k] > m) m = this.freq[k];
        out[i] = m / 255;
      }
      return out;
    }

    frame(t) {
      const dt = Math.min(0.05, Math.max(0.001, (t - this.last) / 1000));
      this.last = t;
      this.sample();
      this.hue = (this.hue + dt * (5 + this.energy * 40)) % 360;
      const c = this.ctx;
      switch (this.mode) {
        case 'wave': this.drawWave(c); break;
        case 'ring': this.drawRing(c, dt); break;
        case 'particles': this.drawParticles(c, dt); break;
        default: this.drawBars(c);
      }
    }

    drawBars(c) {
      const { w, h } = this;
      c.fillStyle = BG;
      c.fillRect(0, 0, w, h);
      const g = c.createRadialGradient(w / 2, h * 0.72, 0, w / 2, h * 0.72, Math.max(w, h) * 0.65);
      g.addColorStop(0, `hsla(${this.hue}, 80%, 55%, ${0.06 + this.bass * 0.22})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);

      const n = Math.max(20, Math.min(96, Math.floor(w / 16)));
      const vals = this.bands(n);
      if (this.peaks.length !== n) this.peaks = new Float32Array(n);
      const gap = Math.max(2, w / n * 0.22);
      const bw = (w - gap * (n + 1)) / n;
      const base = h * 0.72, maxH = h * 0.6;
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        const bh = Math.max(2, Math.pow(v, 1.6) * maxH);
        const x = gap + i * (bw + gap);
        const hue = (this.hue + i / n * 150) % 360;
        const grad = c.createLinearGradient(0, base - bh, 0, base);
        grad.addColorStop(0, `hsl(${hue}, 95%, 72%)`);
        grad.addColorStop(1, `hsl(${(hue + 35) % 360}, 90%, 42%)`);
        c.fillStyle = grad;
        roundRect(c, x, base - bh, bw, bh, 4);
        c.fill();
        c.fillStyle = `hsla(${hue}, 90%, 60%, 0.16)`;
        roundRect(c, x, base + 5, bw, bh * 0.3, 4);
        c.fill();
        this.peaks[i] = Math.max(v, this.peaks[i] - 0.011);
        const py = base - Math.max(2, Math.pow(this.peaks[i], 1.6) * maxH) - 7;
        c.fillStyle = `hsla(${hue}, 100%, 88%, 0.9)`;
        c.fillRect(x, py, bw, 2);
      }
    }

    drawWave(c) {
      const { w, h } = this;
      c.fillStyle = 'rgba(7,7,12,0.22)';
      c.fillRect(0, 0, w, h);
      const n = this.time.length, mid = h / 2;
      const amp = h * 0.32 * (0.7 + this.bass * 0.8);
      const step = Math.max(1, Math.floor(n / w));
      c.lineJoin = 'round';
      c.lineCap = 'round';
      c.shadowBlur = 16;
      c.shadowColor = `hsl(${this.hue}, 100%, 60%)`;
      c.strokeStyle = `hsl(${this.hue}, 100%, 66%)`;
      c.lineWidth = 2.4;
      c.beginPath();
      for (let i = 0; i < n; i += step) {
        const x = i / (n - 1) * w, y = mid + (this.time[i] - 128) / 128 * amp;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.strokeStyle = `hsla(${(this.hue + 140) % 360}, 100%, 65%, 0.55)`;
      c.lineWidth = 1.3;
      c.beginPath();
      for (let i = 0; i < n; i += step * 2) {
        const x = i / (n - 1) * w, y = mid - (this.time[i] - 128) / 128 * amp * 0.55;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.shadowBlur = 0;
      c.fillStyle = `hsla(${this.hue}, 80%, 70%, 0.25)`;
      c.fillRect(0, mid, w, 1);
    }

    drawRing(c, dt) {
      const { w, h } = this;
      c.fillStyle = 'rgba(7,7,12,0.28)';
      c.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const base = Math.min(w, h);
      const R = base * 0.17 * (1 + this.bass * 0.16);
      const n = 180;
      const vals = this.bands(n / 2, 40, 14000);
      this.angle += dt * (0.12 + this.energy * 0.5);
      c.lineCap = 'round';
      c.lineWidth = Math.max(2, (2 * Math.PI * R / n) * 0.6);
      for (let i = 0; i < n; i++) {
        const v = vals[i < n / 2 ? i : n - 1 - i];
        const a = this.angle + i / n * Math.PI * 2 - Math.PI / 2;
        const len = 5 + Math.pow(v, 1.7) * base * 0.26;
        const hue = (this.hue + i / n * 360) % 360;
        c.strokeStyle = `hsla(${hue}, 95%, ${55 + v * 30}%, 0.95)`;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * (R + 5), cy + Math.sin(a) * (R + 5));
        c.lineTo(cx + Math.cos(a) * (R + 5 + len), cy + Math.sin(a) * (R + 5 + len));
        c.stroke();
      }
      c.save();
      c.beginPath();
      c.arc(cx, cy, R, 0, Math.PI * 2);
      c.closePath();
      c.clip();
      if (this.cover) {
        const img = this.cover, s = R * 2;
        const k = Math.max(s / img.width, s / img.height);
        const dw = img.width * k, dh = img.height * k;
        c.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
        c.fillStyle = `hsla(${this.hue}, 80%, 50%, ${this.bass * 0.18})`;
        c.fillRect(cx - R, cy - R, s, s);
      } else {
        const g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
        g.addColorStop(0, `hsl(${this.hue}, 80%, ${18 + this.bass * 40}%)`);
        g.addColorStop(1, `hsl(${(this.hue + 60) % 360}, 80%, 8%)`);
        c.fillStyle = g;
        c.fillRect(cx - R, cy - R, R * 2, R * 2);
      }
      c.restore();
      c.strokeStyle = `hsla(${this.hue}, 100%, 78%, 0.8)`;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cx, cy, R, 0, Math.PI * 2);
      c.stroke();
    }

    spawn(anywhere) {
      const { w, h } = this;
      const a = Math.random() * Math.PI * 2;
      const d = anywhere ? Math.random() * Math.max(w, h) * 0.6 : Math.random() * 30;
      return {
        x: w / 2 + Math.cos(a) * d, y: h / 2 + Math.sin(a) * d, a,
        s: 0.4 + Math.random() * 1.3, r: 1 + Math.random() * 2,
        band: Math.floor(Math.random() * 32), life: 4 + Math.random() * 8,
      };
    }

    drawParticles(c, dt) {
      const { w, h } = this;
      c.fillStyle = 'rgba(7,7,12,0.2)';
      c.fillRect(0, 0, w, h);
      const N = w * h > 1.2e6 ? 360 : 240;
      if (this.particles.length !== N) this.particles = Array.from({ length: N }, () => this.spawn(true));
      const cx = w / 2, cy = h / 2;
      const speed = 30 + this.bass * 650 + this.energy * 180;
      const vals = this.bands(32, 40, 12000);
      c.globalCompositeOperation = 'lighter';
      c.lineCap = 'round';
      for (const p of this.particles) {
        const v = vals[p.band];
        const vx = Math.cos(p.a) * speed * p.s, vy = Math.sin(p.a) * speed * p.s;
        p.x += vx * dt;
        p.y += vy * dt;
        p.life -= dt;
        if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20 || p.life <= 0) Object.assign(p, this.spawn(false));
        const dx = p.x - cx, dy = p.y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const r = p.r * (0.6 + v * 2.4);
        const alpha = Math.min(1, d / 120) * (0.3 + v * 0.7);
        const hue = (this.hue + p.band / 32 * 200) % 360;
        c.strokeStyle = `hsla(${hue}, 95%, 65%, ${alpha})`;
        c.lineWidth = r;
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(p.x - vx * dt * (2 + v * 10), p.y - vy * dt * (2 + v * 10));
        c.stroke();
      }
      c.globalCompositeOperation = 'source-over';
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, 70 + this.bass * 220);
      g.addColorStop(0, `hsla(${this.hue}, 90%, 60%, ${0.22 + this.bass * 0.5})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
  }

  Visualizer.MODES = MODES;
  root.Visualizer = Visualizer;
})(window);
