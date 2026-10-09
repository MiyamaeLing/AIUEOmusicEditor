'use strict';
// ===== プロジェクト状態と Undo/Redo =====

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

let _uidCounter = 0;
const uid = (prefix) => prefix + Date.now().toString(36) + (_uidCounter++).toString(36);

const clipColor = (index) => `hsl(${(index * 47) % 360}, 65%, 55%)`;

function createProject() {
  return {
    version: 1,
    bpm: 120,
    beatsPerBar: 4,
    mediaName: null,
    loopShortClips: false,
    holdLastFrame: true,
    showLyrics: false,
    clips: [],
    notes: [],
  };
}

const AUTOSAVE_KEY = 'aiueo-music-editor:autosave';

const store = {
  project: createProject(),
  undoStack: [],
  redoStack: [],
  listeners: new Set(),

  subscribe(fn) { this.listeners.add(fn); },
  emit() {
    this.listeners.forEach((fn) => fn());
    this.autosave();
  },

  snapshot() { return JSON.stringify(this.project); },
  // 変更の直前に呼ぶ
  checkpoint() { this.pushUndo(this.snapshot()); },
  pushUndo(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  },
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.project = JSON.parse(this.undoStack.pop());
    this.emit();
  },
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.project = JSON.parse(this.redoStack.pop());
    this.emit();
  },
  load(project) {
    this.checkpoint();
    this.project = Object.assign(createProject(), project);
    this.emit();
  },

  // ノートの歌詞と同名のクリップが発音される
  resolveClip(note) {
    return this.project.clips.find((c) => c.name === note.lyric) || null;
  },
  clipById(id) { return this.project.clips.find((c) => c.id === id) || null; },
  noteById(id) { return this.project.notes.find((n) => n.id === id) || null; },
  endBeat() {
    return this.project.notes.reduce((m, n) => Math.max(m, n.start + n.length), 0);
  },

  autosave() {
    try { localStorage.setItem(AUTOSAVE_KEY, this.snapshot()); } catch (e) { /* 保存不可の環境では無視 */ }
  },
  restoreAutosave() {
    try {
      const s = localStorage.getItem(AUTOSAVE_KEY);
      if (s) this.project = Object.assign(createProject(), JSON.parse(s));
    } catch (e) { /* 壊れていたら無視 */ }
  },
};

// 「きゃりー」→ ['きゃ','り','ー'] のように拗音をまとめて分割
function splitLyrics(text) {
  text = text.trim();
  if (!text) return [];
  if (/\s/.test(text)) return text.split(/\s+/);
  const small = 'ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ';
  const out = [];
  for (const ch of text) {
    if (small.includes(ch) && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}
