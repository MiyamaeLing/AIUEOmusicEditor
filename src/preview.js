'use strict';
// ===== 映像プレビュー: ノートごとに素材映像の該当位置へジャンプして再生 =====

class VideoPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    // 次のノートを先読みシークしておくため 2 つの video を交互に使う
    this.videos = [this.makeVideo(), this.makeVideo()];
    this.hasVideo = false;
    this.current = null; // { noteId, el, note, clip }
    this.prepared = null; // { noteId, el }
    this.lastPlaying = false;
  }

  makeVideo() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    return v;
  }

  load(url) {
    this.hasVideo = false;
    this.current = null;
    this.prepared = null;
    for (const v of this.videos) {
      v.src = url;
      v.onloadedmetadata = () => { this.hasVideo = v.videoWidth > 0; };
    }
  }

  unload() {
    this.hasVideo = false;
    this.current = null;
    this.prepared = null;
    for (const v of this.videos) { v.pause(); v.removeAttribute('src'); v.load(); }
  }

  static activeNoteAt(project, beat) {
    let best = null;
    for (const n of project.notes) {
      if (n.start <= beat && beat < n.start + n.length && project.clips.some((c) => c.name === n.lyric)) {
        if (!best || n.start > best.start || (n.start === best.start && n.pitch > best.pitch)) best = n;
      }
    }
    return best;
  }

  static nextNoteAfter(project, beat) {
    let best = null;
    for (const n of project.notes) {
      if (n.start > beat && project.clips.some((c) => c.name === n.lyric) && (!best || n.start < best.start)) best = n;
    }
    return best;
  }

  sourceTime(project, note, clip, beat) {
    const rate = pitchRate(note, clip);
    let t = (beat - note.start) * (60 / project.bpm) * rate;
    const len = clip.end - clip.start;
    if (project.loopShortClips && len > 0) t %= len;
    else t = Math.min(t, Math.max(0, len - 0.001));
    return clip.start + t;
  }

  update(project, beat, playing) {
    const note = VideoPreview.activeNoteAt(project, beat);
    const clip = note ? project.clips.find((c) => c.name === note.lyric) : null;

    if (!note) {
      if (this.current) this.current.el.pause();
      if (!project.holdLastFrame) this.current = null;
    } else {
      const rate = Math.min(16, Math.max(0.0625, pitchRate(note, clip)));
      const t = this.sourceTime(project, note, clip, beat);
      if (!this.current || this.current.noteId !== note.id || this.current.clip !== clip) {
        let el;
        if (this.prepared && this.prepared.noteId === note.id) el = this.prepared.el;
        else el = this.videos.find((v) => !this.current || v !== this.current.el);
        if (this.current && this.current.el !== el) this.current.el.pause();
        if (Math.abs(el.currentTime - t) > 0.04) el.currentTime = t;
        el.playbackRate = rate;
        if (playing) el.play().catch(() => {});
        else el.pause();
        this.current = { noteId: note.id, el, note, clip };
        this.prepared = null;
      } else {
        const el = this.current.el;
        if (!playing) {
          // 停止中はスクラブ
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - t) > 0.03) el.currentTime = t;
        } else {
          if (!this.lastPlaying) { el.currentTime = t; el.playbackRate = rate; el.play().catch(() => {}); }
          if (el.currentTime >= clip.end) {
            if (project.loopShortClips) el.currentTime = clip.start;
            else el.pause(); // 最終フレームで静止
          }
        }
      }
    }

    // 次のノートを空いている video で先読みシーク
    if (playing) {
      const next = VideoPreview.nextNoteAfter(project, beat);
      if (next && (!this.prepared || this.prepared.noteId !== next.id) && next.start - beat < 4) {
        const nclip = project.clips.find((c) => c.name === next.lyric);
        const el = this.videos.find((v) => !this.current || v !== this.current.el);
        el.pause();
        el.currentTime = nclip.start;
        this.prepared = { noteId: next.id, el };
      }
    }
    this.lastPlaying = playing;
    this.draw(project);
  }

  draw(project) {
    const { g, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const cur = this.current;
    if (!cur) return;

    if (this.hasVideo && cur.el.readyState >= 2) {
      const vw = cur.el.videoWidth;
      const vh = cur.el.videoHeight;
      const s = Math.min(W / vw, H / vh);
      const dw = vw * s;
      const dh = vh * s;
      g.save();
      if (cur.note.flip) { g.translate(W, 0); g.scale(-1, 1); }
      g.drawImage(cur.el, (W - dw) / 2, (H - dh) / 2, dw, dh);
      g.restore();
    } else if (!this.hasVideo) {
      // 音声のみの素材: クリップ色の背景に歌詞を大きく表示
      g.fillStyle = cur.clip.color;
      g.globalAlpha = 0.35;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
      this.drawLyric(cur.note.lyric, H * 0.5, H / 2);
      return;
    }
    if (project.showLyrics) this.drawLyric(cur.note.lyric, H * 0.14, H * 0.88);
  }

  drawLyric(text, size, y) {
    const { g, canvas } = this;
    g.font = `bold ${size}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = size / 10;
    g.strokeStyle = '#000';
    g.strokeText(text, canvas.width / 2, y);
    g.fillStyle = '#fff';
    g.fillText(text, canvas.width / 2, y);
  }
}
