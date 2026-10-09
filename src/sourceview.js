'use strict';
// ===== 素材の波形表示と範囲選択 =====

class SourceView {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.g = canvas.getContext('2d');
    this.buffer = null;
    this.viewStart = 0;
    this.viewEnd = 1;
    this.sel = null; // { start, end }
    this.clips = [];
    this.activeClipId = null;
    this.drag = null;
    this.onSelectionCommit = () => {};

    canvas.addEventListener('mousedown', (e) => this.mouseDown(e));
    window.addEventListener('mousemove', (e) => this.mouseMove(e));
    window.addEventListener('mouseup', () => this.mouseUp());
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    video.addEventListener('timeupdate', () => this.draw());
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    this.viewStart = 0;
    this.viewEnd = buffer ? buffer.duration : 1;
    this.sel = null;
    this.draw();
  }

  setSelection(start, end) {
    this.sel = start == null ? null : { start, end };
    // 選択範囲が画面外なら寄せる
    if (this.sel && (this.sel.end < this.viewStart || this.sel.start > this.viewEnd)) {
      const span = this.viewEnd - this.viewStart;
      this.viewStart = Math.max(0, this.sel.start - span * 0.1);
      this.viewEnd = this.viewStart + span;
    }
    this.draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(50, r.width);
    this.h = Math.max(30, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
    this.draw();
  }

  xToTime(x) { return this.viewStart + (x / this.w) * (this.viewEnd - this.viewStart); }
  timeToX(t) { return ((t - this.viewStart) / (this.viewEnd - this.viewStart)) * this.w; }
  localX(e) { return e.clientX - this.canvas.getBoundingClientRect().left; }

  mouseDown(e) {
    if (!this.buffer || e.button !== 0) return;
    e.preventDefault();
    const x = this.localX(e);
    const t = this.xToTime(x);
    // 既存選択の端をつかんだら端だけ動かす
    if (this.sel) {
      const xs = this.timeToX(this.sel.start);
      const xe = this.timeToX(this.sel.end);
      if (Math.abs(x - xs) < 6) { this.drag = { edge: 'start' }; return; }
      if (Math.abs(x - xe) < 6) { this.drag = { edge: 'end' }; return; }
    }
    this.drag = { edge: 'new', t0: t, moved: false };
    this.video.currentTime = t;
  }

  mouseMove(e) {
    if (!this.drag || !this.buffer) {
      if (this.sel && e.target === this.canvas) {
        const x = this.localX(e);
        const near = Math.abs(x - this.timeToX(this.sel.start)) < 6 || Math.abs(x - this.timeToX(this.sel.end)) < 6;
        this.canvas.style.cursor = near ? 'ew-resize' : 'text';
      }
      return;
    }
    const t = Math.max(0, Math.min(this.buffer.duration, this.xToTime(this.localX(e))));
    const d = this.drag;
    if (d.edge === 'new') {
      d.moved = true;
      this.sel = { start: Math.min(d.t0, t), end: Math.max(d.t0, t) };
    } else if (d.edge === 'start') {
      this.sel.start = Math.min(t, this.sel.end - 0.005);
    } else {
      this.sel.end = Math.max(t, this.sel.start + 0.005);
    }
    this.draw();
  }

  mouseUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.edge === 'new' && !d.moved) return;
    if (this.sel) this.onSelectionCommit(this.sel.start, this.sel.end);
  }

  wheel(e) {
    if (!this.buffer) return;
    e.preventDefault();
    const dur = this.buffer.duration;
    let span = this.viewEnd - this.viewStart;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const shift = ((e.deltaX || e.deltaY) / this.w) * span;
      this.viewStart += shift;
    } else {
      const t = this.xToTime(this.localX(e));
      const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25;
      const newSpan = Math.max(0.05, Math.min(dur, span * factor));
      this.viewStart = t - ((t - this.viewStart) / span) * newSpan;
      span = newSpan;
    }
    this.viewStart = Math.max(0, Math.min(this.viewStart, dur - span));
    this.viewEnd = this.viewStart + span;
    this.draw();
  }

  draw() {
    if (!this.w) return;
    const g = this.g;
    const { w, h } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#111318';
    g.fillRect(0, 0, w, h);
    if (!this.buffer) {
      g.fillStyle = '#667';
      g.font = '12px sans-serif';
      g.textAlign = 'center';
      g.fillText('素材を読み込むと波形が表示されます', w / 2, h / 2);
      g.textAlign = 'left';
      return;
    }

    // 既存クリップの範囲
    g.font = '11px sans-serif';
    for (const c of this.clips) {
      const x0 = this.timeToX(c.start);
      const x1 = this.timeToX(c.end);
      if (x1 < 0 || x0 > w) continue;
      g.globalAlpha = c.id === this.activeClipId ? 0.35 : 0.18;
      g.fillStyle = c.color;
      g.fillRect(x0, 0, x1 - x0, h);
      g.globalAlpha = 1;
      g.fillStyle = c.color;
      g.fillText(c.name, x0 + 3, 12);
    }

    // 波形（min/max）
    const data = this.buffer.getChannelData(0);
    const sr = this.buffer.sampleRate;
    const mid = h / 2;
    g.fillStyle = '#6fc3ff';
    for (let px = 0; px < w; px++) {
      const i0 = Math.floor(this.xToTime(px) * sr);
      const i1 = Math.min(data.length, Math.floor(this.xToTime(px + 1) * sr));
      if (i0 >= data.length) break;
      let mn = 0;
      let mx = 0;
      const stride = Math.max(1, Math.floor((i1 - i0) / 256));
      for (let i = i0; i < i1; i += stride) {
        const v = data[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      g.fillRect(px, mid - mx * mid, 1, Math.max(1, (mx - mn) * mid));
    }

    // 選択範囲
    if (this.sel) {
      const x0 = this.timeToX(this.sel.start);
      const x1 = this.timeToX(this.sel.end);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = '#ffd34d';
      g.fillRect(x0 - 1, 0, 2, h);
      g.fillRect(x1 - 1, 0, 2, h);
    }

    // 素材動画の現在位置
    const vx = this.timeToX(this.video.currentTime || 0);
    g.fillStyle = '#ff5a5a';
    g.fillRect(vx, 0, 1, h);

    // 表示範囲の時刻
    g.fillStyle = '#889';
    g.fillText(this.viewStart.toFixed(2) + 's', 3, h - 4);
    g.textAlign = 'right';
    g.fillText(this.viewEnd.toFixed(2) + 's', w - 3, h - 4);
    g.textAlign = 'left';
  }
}
