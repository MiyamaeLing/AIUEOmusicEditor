'use strict';
// ===== VOCALOID 風ピアノロール =====

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

class PianoRoll {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.store = store;
    this.keyW = 64;
    this.rulerH = 26;
    this.rowH = 18;
    this.pxPerBeat = 96;
    this.minPitch = 24; // C1
    this.maxPitch = 96; // C7
    this.scrollX = 0;
    this.scrollY = (this.maxPitch - 76) * this.rowH;
    this.snap = 0.5;
    this.lastLength = 1;
    this.tool = 'draw';
    this.selection = new Set();
    this.playhead = 0;
    this.drag = null;
    this.dirty = true;

    // コールバック（main.js で設定）
    this.onSeek = () => {};
    this.onPreviewNote = () => {};
    this.onEditLyric = () => {};
    this.onSelectionChange = () => {};
    this.defaultLyric = () => 'あ';

    canvas.addEventListener('mousedown', (e) => this.mouseDown(e));
    window.addEventListener('mousemove', (e) => this.mouseMove(e));
    window.addEventListener('mouseup', (e) => this.mouseUp(e));
    canvas.addEventListener('dblclick', (e) => this.dblClick(e));
    canvas.addEventListener('contextmenu', (e) => this.contextMenu(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  get project() { return this.store.project; }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(100, rect.width);
    this.h = Math.max(100, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.dpr = dpr;
    this.clampScroll();
    this.invalidate();
  }

  invalidate() { this.dirty = true; }

  // ---- 座標変換 ----
  beatToX(b) { return this.keyW + b * this.pxPerBeat - this.scrollX; }
  xToBeat(x) { return (x - this.keyW + this.scrollX) / this.pxPerBeat; }
  pitchToY(p) { return this.rulerH + (this.maxPitch - p) * this.rowH - this.scrollY; }
  yToPitch(y) { return this.maxPitch - Math.floor((y - this.rulerH + this.scrollY) / this.rowH); }
  snapRound(b) { return this.snap ? Math.round(b / this.snap) * this.snap : b; }
  snapFloor(b) { return this.snap ? Math.floor(b / this.snap) * this.snap : b; }
  minLen() { return this.snap || 1 / 16; }

  noteRect(n) {
    return { x: this.beatToX(n.start), y: this.pitchToY(n.pitch), w: n.length * this.pxPerBeat, h: this.rowH };
  }

  clampScroll() {
    const totalH = (this.maxPitch - this.minPitch + 1) * this.rowH;
    const viewH = this.h - this.rulerH;
    this.scrollY = Math.max(0, Math.min(this.scrollY, totalH - viewH));
    this.scrollX = Math.max(0, this.scrollX);
  }

  ensureVisible(beat) {
    const x = this.beatToX(beat);
    if (x > this.w - 40 || x < this.keyW) {
      this.scrollX = Math.max(0, beat * this.pxPerBeat - (this.w - this.keyW) * 0.1);
      this.invalidate();
    }
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hitNote(x, y) {
    const notes = this.project.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const r = this.noteRect(notes[i]);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y < r.y + r.h) {
        const edge = x > r.x + r.w - Math.min(8, r.w / 3) ? 'right' : 'body';
        return { note: notes[i], edge };
      }
    }
    return null;
  }

  setSelection(ids) {
    this.selection = new Set(ids);
    this.onSelectionChange();
    this.invalidate();
  }

  selectedNotes() {
    return this.project.notes.filter((n) => this.selection.has(n.id));
  }

  // ---- マウス操作 ----
  mouseDown(e) {
    const { x, y } = this.local(e);
    if (e.button !== 0) return;
    e.preventDefault();
    this.canvas.focus();

    if (y < this.rulerH && x > this.keyW) {
      this.drag = { mode: 'seek' };
      this.onSeek(Math.max(0, this.xToBeat(x)));
      return;
    }
    if (x < this.keyW) {
      const pitch = this.yToPitch(y);
      this.onPreviewNote({ lyric: this.defaultLyric(), pitch });
      return;
    }

    const beat = this.xToBeat(x);
    const pitch = this.yToPitch(y);
    const hit = this.hitNote(x, y);
    const snap = this.store.snapshot();

    if (hit) {
      const n = hit.note;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const s = new Set(this.selection);
        if (s.has(n.id)) s.delete(n.id); else s.add(n.id);
        this.setSelection(s);
        if (!s.has(n.id)) return;
      } else if (!this.selection.has(n.id)) {
        this.setSelection([n.id]);
      }
      this.onPreviewNote(n);
      const orig = new Map(this.selectedNotes().map((m) => [m.id, { start: m.start, pitch: m.pitch, length: m.length }]));
      this.drag = {
        mode: hit.edge === 'right' ? 'resize' : 'move',
        anchor: n, startBeat: beat, startPitch: pitch, orig, snap, changed: false,
      };
      return;
    }

    if (this.tool === 'draw' && !e.shiftKey) {
      const start = Math.max(0, this.snapFloor(beat));
      const note = { id: uid('n'), start, length: this.lastLength, pitch, lyric: this.defaultLyric(), volume: 1, flip: false };
      this.store.pushUndo(snap);
      this.project.notes.push(note);
      this.setSelection([note.id]);
      this.onPreviewNote(note);
      this.drag = { mode: 'create', anchor: note, orig: new Map([[note.id, { start, pitch, length: note.length }]]), startBeat: beat, changed: true };
      this.store.emit();
      return;
    }

    this.drag = { mode: 'rubber', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? new Set(this.selection) : new Set() };
    if (!e.shiftKey) this.setSelection([]);
  }

  mouseMove(e) {
    const { x, y } = this.local(e);
    const d = this.drag;
    if (!d) {
      if (e.target === this.canvas) {
        const hit = x > this.keyW && y > this.rulerH ? this.hitNote(x, y) : null;
        this.canvas.style.cursor = hit ? (hit.edge === 'right' ? 'ew-resize' : 'move')
          : (x > this.keyW && y > this.rulerH && this.tool === 'draw' ? 'crosshair' : 'default');
      }
      return;
    }
    const beat = this.xToBeat(x);

    if (d.mode === 'seek') {
      this.onSeek(Math.max(0, beat));
      return;
    }
    if (d.mode === 'rubber') {
      d.x1 = x; d.y1 = y;
      const b0 = this.xToBeat(Math.min(d.x0, x));
      const b1 = this.xToBeat(Math.max(d.x0, x));
      const pHi = this.yToPitch(Math.min(d.y0, y));
      const pLo = this.yToPitch(Math.max(d.y0, y));
      const ids = new Set(d.base);
      for (const n of this.project.notes) {
        if (n.start < b1 && n.start + n.length > b0 && n.pitch <= pHi && n.pitch >= pLo) ids.add(n.id);
      }
      this.setSelection(ids);
      return;
    }

    const markChanged = () => {
      if (!d.changed) { this.store.pushUndo(d.snap); d.changed = true; }
    };

    if (d.mode === 'move') {
      const dBeat = this.snapRound(beat - d.startBeat);
      const dPitch = this.yToPitch(y) - d.startPitch;
      const sel = this.selectedNotes();
      const minStart = Math.min(...sel.map((n) => d.orig.get(n.id).start));
      const db = Math.max(dBeat, -minStart);
      const maxP = Math.max(...sel.map((n) => d.orig.get(n.id).pitch));
      const minP = Math.min(...sel.map((n) => d.orig.get(n.id).pitch));
      const dp = Math.max(this.minPitch - minP, Math.min(this.maxPitch - maxP, dPitch));
      const prevPitch = d.anchor.pitch;
      for (const n of sel) {
        const o = d.orig.get(n.id);
        if (n.start !== o.start + db || n.pitch !== o.pitch + dp) markChanged();
        n.start = o.start + db;
        n.pitch = o.pitch + dp;
      }
      if (d.anchor.pitch !== prevPitch) this.onPreviewNote(d.anchor);
    } else if (d.mode === 'resize' || d.mode === 'create') {
      const o = d.orig.get(d.anchor.id);
      const end = Math.max(o.start + this.minLen(), this.snapRound(beat));
      const delta = end - (o.start + o.length);
      const targets = d.mode === 'create' ? [d.anchor] : this.selectedNotes();
      for (const n of targets) {
        const on = d.orig.get(n.id);
        const len = Math.max(this.minLen(), on.length + delta);
        if (n.length !== len) markChanged();
        n.length = len;
      }
    }
    this.store.emit();
  }

  mouseUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if ((d.mode === 'resize' || d.mode === 'create') && d.changed) this.lastLength = d.anchor.length;
    this.invalidate();
  }

  dblClick(e) {
    const { x, y } = this.local(e);
    const hit = this.hitNote(x, y);
    if (hit) this.onEditLyric(hit.note);
  }

  contextMenu(e) {
    e.preventDefault();
    const { x, y } = this.local(e);
    const hit = this.hitNote(x, y);
    if (!hit) return;
    this.store.checkpoint();
    const ids = this.selection.has(hit.note.id) ? this.selection : new Set([hit.note.id]);
    this.project.notes = this.project.notes.filter((n) => !ids.has(n.id));
    this.setSelection([]);
    this.store.emit();
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const { x } = this.local(e);
      const beat = this.xToBeat(x);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.pxPerBeat = Math.max(12, Math.min(600, this.pxPerBeat * factor));
      this.scrollX = beat * this.pxPerBeat - (x - this.keyW);
    } else if (e.altKey) {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.rowH = Math.max(8, Math.min(40, this.rowH * factor));
    } else if (e.shiftKey) {
      this.scrollX += e.deltaY || e.deltaX;
    } else {
      this.scrollX += e.deltaX;
      this.scrollY += e.deltaY;
    }
    this.clampScroll();
    this.invalidate();
  }

  // ---- 描画 ----
  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const g = this.g;
    const { w, h, keyW, rulerH, rowH } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#1c1f26';
    g.fillRect(0, 0, w, h);

    // 行（白鍵/黒鍵）
    const pTop = this.yToPitch(rulerH);
    const pBottom = this.yToPitch(h);
    for (let p = Math.min(this.maxPitch, pTop); p >= Math.max(this.minPitch, pBottom); p--) {
      const y = this.pitchToY(p);
      g.fillStyle = BLACK_KEYS.has(p % 12) ? '#22262e' : '#2a2f38';
      g.fillRect(keyW, y, w - keyW, rowH);
      g.fillStyle = p % 12 === 0 ? '#4a5160' : '#1a1d23';
      g.fillRect(keyW, y + rowH - 1, w - keyW, 1);
    }

    // 縦グリッド
    const proj = this.project;
    const b0 = Math.max(0, this.xToBeat(keyW));
    const b1 = this.xToBeat(w);
    const step = this.snap && this.snap * this.pxPerBeat >= 6 ? this.snap : 1;
    for (let b = Math.floor(b0 / step) * step; b <= b1; b += step) {
      const x = Math.round(this.beatToX(b)) + 0.5;
      const isBar = Math.abs(b / proj.beatsPerBar - Math.round(b / proj.beatsPerBar)) < 1e-6;
      const isBeat = Math.abs(b - Math.round(b)) < 1e-6;
      g.strokeStyle = isBar ? '#5b6475' : isBeat ? '#3a404c' : '#2c313a';
      g.beginPath(); g.moveTo(x, rulerH); g.lineTo(x, h); g.stroke();
    }

    // ノート
    g.font = `${Math.max(10, Math.min(14, rowH - 4))}px sans-serif`;
    g.textBaseline = 'middle';
    for (const n of proj.notes) {
      const r = this.noteRect(n);
      if (r.x + r.w < keyW || r.x > w || r.y + r.h < rulerH || r.y > h) continue;
      const clip = this.store.resolveClip(n);
      const sel = this.selection.has(n.id);
      g.fillStyle = clip ? clip.color : '#6b6f78';
      g.globalAlpha = clip ? 0.9 : 0.6;
      g.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      g.globalAlpha = 1;
      g.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.5)';
      g.lineWidth = sel ? 2 : 1;
      g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      g.lineWidth = 1;
      g.save();
      g.beginPath(); g.rect(r.x + 2, r.y, r.w - 4, r.h); g.clip();
      g.fillStyle = clip ? '#10131a' : '#ffb3b3';
      const label = n.lyric + (n.flip ? ' ⇋' : '') + (clip ? '' : ' (?)');
      g.fillText(label, r.x + 5, r.y + r.h / 2 + 1);
      g.restore();
    }

    // 範囲選択
    if (this.drag && this.drag.mode === 'rubber') {
      const d = this.drag;
      g.fillStyle = 'rgba(120,170,255,0.15)';
      g.strokeStyle = 'rgba(120,170,255,0.8)';
      g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    // 鍵盤
    g.fillStyle = '#e8e8e8';
    g.fillRect(0, rulerH, keyW, h - rulerH);
    for (let p = Math.min(this.maxPitch, pTop); p >= Math.max(this.minPitch, pBottom); p--) {
      const y = this.pitchToY(p);
      if (BLACK_KEYS.has(p % 12)) {
        g.fillStyle = '#20232a';
        g.fillRect(0, y, keyW * 0.62, rowH);
      }
      g.fillStyle = '#b9bcc2';
      g.fillRect(0, y + rowH - 1, keyW, 1);
      if (p % 12 === 0) {
        g.fillStyle = '#333';
        g.textAlign = 'right';
        g.fillText(midiName(p), keyW - 4, y + rowH / 2 + 1);
        g.textAlign = 'left';
      }
    }

    // ルーラー
    g.fillStyle = '#14161b';
    g.fillRect(0, 0, w, rulerH);
    g.fillStyle = '#aab';
    g.font = '11px sans-serif';
    for (let bar = Math.floor(b0 / proj.beatsPerBar); bar * proj.beatsPerBar <= b1; bar++) {
      const x = this.beatToX(bar * proj.beatsPerBar);
      if (x < keyW) continue;
      g.fillRect(x, rulerH - 10, 1, 10);
      g.fillText(String(bar + 1), x + 3, rulerH / 2);
    }

    // 再生ヘッド
    const px = this.beatToX(this.playhead);
    if (px >= keyW) {
      g.fillStyle = '#ff5a5a';
      g.fillRect(px - 0.5, 0, 2, h);
      g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 7, 0); g.lineTo(px + 0.5, 9); g.fill();
    }
  }
}
