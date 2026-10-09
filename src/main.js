'use strict';
// ===== UI の結線 =====

const $ = (id) => document.getElementById(id);

const engine = new AudioEngine();
const preview = new VideoPreview($('previewCanvas'));
const roll = new PianoRoll($('rollCanvas'), store);
const sourceVideo = $('sourceVideo');
const sourceView = new SourceView($('waveCanvas'), sourceVideo);

let activeClipId = null;
let mediaUrl = null;
let exporting = false;

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const baseName = () => (store.project.mediaName || 'aiueo').replace(/\.[^.]+$/, '');

// ---------- 素材の読み込み ----------
async function loadMedia(file) {
  setStatus(`読み込み中: ${file.name} …`);
  try {
    const arrayBuffer = await file.arrayBuffer();
    await engine.decode(arrayBuffer);
  } catch (e) {
    setStatus(`音声をデコードできませんでした: ${e.message || e}`, true);
    return;
  }
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(file);
  sourceVideo.src = mediaUrl;
  preview.load(mediaUrl);
  sourceView.setBuffer(engine.buffer);
  $('mediaName').textContent = file.name;
  if (store.project.mediaName && store.project.mediaName !== file.name) {
    setStatus(`注意: プロジェクトは「${store.project.mediaName}」用に作られています。`);
  } else {
    setStatus(`${file.name} を読み込みました（${engine.buffer.duration.toFixed(2)} 秒）。波形をドラッグしてクリップを作りましょう。`);
  }
  store.project.mediaName = file.name;
  store.emit();
}

async function loadDemo() {
  engine.ensure();
  const { buffer, clips } = await synthesizeDemoVowels();
  engine.buffer = buffer;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(encodeWav(buffer));
  sourceVideo.src = mediaUrl;
  preview.unload();
  sourceView.setBuffer(buffer);
  $('mediaName').textContent = 'デモ（合成音声）';

  store.checkpoint();
  const p = createProject();
  p.mediaName = 'demo';
  p.bpm = 132;
  p.clips = clips;
  p.showLyrics = true;
  // かえるのうた
  const melody = [
    [60, 1, 'あ'], [62, 1, 'い'], [64, 1, 'う'], [65, 1, 'え'], [64, 1, 'お'], [62, 1, 'え'], [60, 2, 'う'],
    [64, 1, 'お'], [65, 1, 'え'], [67, 1, 'い'], [69, 1, 'あ'], [67, 1, 'い'], [65, 1, 'え'], [64, 2, 'お'],
  ];
  let t = 0;
  for (const [pitch, len, lyric] of melody) {
    p.notes.push({ id: uid('n'), start: t, length: len * 0.95, pitch, lyric, volume: 1, flip: false });
    t += len;
  }
  store.project = p;
  activeClipId = clips[0].id;
  roll.setSelection([]);
  roll.playhead = 0;
  store.emit();
  setStatus('デモ素材を読み込みました。Space で再生できます。');
}

$('mediaInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadMedia(f);
  e.target.value = '';
});
$('demoBtn').addEventListener('click', loadDemo);

// ---------- 再生 ----------
function play() {
  if (exporting) return;
  if (!engine.buffer) { setStatus('先に素材を読み込んでください。', true); return; }
  engine.play(store.project, roll.playhead);
  $('playBtn').textContent = '■';
}
function stop() {
  engine.stop();
  engine.fromBeat = roll.playhead;
  $('playBtn').textContent = '▶';
}
function togglePlay() { if (engine.playing) stop(); else play(); }
function seek(beat) {
  roll.playhead = beat;
  if (engine.playing) engine.play(store.project, beat);
  else engine.fromBeat = beat;
  roll.invalidate();
}

$('playBtn').addEventListener('click', togglePlay);
$('homeBtn').addEventListener('click', () => { seek(0); roll.ensureVisible(0); });
roll.onSeek = seek;

function formatPosition(beat) {
  const bpb = store.project.beatsPerBar;
  const bar = Math.floor(beat / bpb) + 1;
  const b = Math.floor(beat % bpb) + 1;
  const tick = Math.floor((beat % 1) * 100);
  return `${bar} : ${b} . ${String(tick).padStart(2, '0')}`;
}

function frame() {
  if (engine.playing) {
    roll.playhead = engine.currentBeat();
    roll.ensureVisible(roll.playhead);
    roll.invalidate();
    if (!exporting && roll.playhead > store.endBeat() + 1) stop();
  }
  preview.update(store.project, roll.playhead, engine.playing);
  roll.draw();
  $('timeDisplay').textContent = formatPosition(roll.playhead);
  requestAnimationFrame(frame);
}

// ---------- 試聴 ----------
roll.onPreviewNote = (note) => {
  if (engine.playing) return;
  const clip = store.resolveClip(note);
  if (clip) engine.preview(clip, note.pitch, 0.4);
};
roll.defaultLyric = () => {
  const c = store.clipById(activeClipId);
  return c ? c.name : (store.project.clips[0]?.name ?? 'あ');
};

// ---------- 歌詞入力（ダブルクリック / Enter、Tab で次のノートへ） ----------
const lyricInput = $('lyricInput');
let lyricTarget = null;

function editLyric(note) {
  lyricTarget = note;
  roll.setSelection([note.id]);
  const r = roll.noteRect(note);
  Object.assign(lyricInput.style, {
    left: Math.max(roll.keyW, r.x) + 'px',
    top: r.y - 2 + 'px',
    height: r.h + 4 + 'px',
    width: Math.max(70, r.w) + 'px',
  });
  lyricInput.value = note.lyric;
  lyricInput.hidden = false;
  lyricInput.focus();
  lyricInput.select();
}
function commitLyric() {
  if (!lyricTarget) return;
  const v = lyricInput.value.trim();
  const note = store.noteById(lyricTarget.id);
  if (note && v && v !== note.lyric) {
    store.checkpoint();
    note.lyric = v;
    store.emit();
  }
  lyricTarget = null;
  lyricInput.hidden = true;
}
roll.onEditLyric = editLyric;
lyricInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const cur = lyricTarget;
    commitLyric();
    if (e.key === 'Tab') {
      const sorted = [...store.project.notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
      const i = sorted.findIndex((n) => n.id === cur.id);
      const next = sorted[i + (e.shiftKey ? -1 : 1)];
      if (next) { roll.ensureVisible(next.start); roll.draw(); editLyric(next); return; }
    }
    $('rollCanvas').focus();
  } else if (e.key === 'Escape') {
    lyricTarget = null;
    lyricInput.hidden = true;
    $('rollCanvas').focus();
  }
});
lyricInput.addEventListener('blur', commitLyric);

$('lyricPourBtn').addEventListener('click', () => {
  let targets = roll.selectedNotes();
  if (!targets.length) targets = store.project.notes;
  if (!targets.length) { setStatus('ノートがありません。', true); return; }
  const text = prompt('歌詞を入力してください（ひらがなは1文字ずつ、スペース区切りなら単語ごとに割り当て）', '');
  if (text == null) return;
  const parts = splitLyrics(text);
  if (!parts.length) return;
  store.checkpoint();
  const sorted = [...targets].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  sorted.forEach((n, i) => { if (i < parts.length) n.lyric = parts[i]; });
  store.emit();
  setStatus(`${Math.min(parts.length, sorted.length)} 個のノートに歌詞を流し込みました。`);
});

// ---------- ノートプロパティ ----------
function refreshProps() {
  const sel = roll.selectedNotes();
  $('propsEmpty').hidden = sel.length > 0;
  $('propsBody').hidden = sel.length === 0;
  if (!sel.length) return;
  const n = sel[0];
  if (document.activeElement !== $('propLyric')) $('propLyric').value = sel.every((m) => m.lyric === n.lyric) ? n.lyric : '';
  $('propPitch').textContent = sel.length === 1 ? midiName(n.pitch) : '—';
  $('propVolume').value = n.volume ?? 1;
  $('propFlip').checked = !!n.flip;
  $('propCount').textContent = sel.length > 1 ? `${sel.length} 個選択中` : '';
}
roll.onSelectionChange = refreshProps;

function applyToSelection(fn) {
  const sel = roll.selectedNotes();
  if (!sel.length) return;
  store.checkpoint();
  sel.forEach(fn);
  store.emit();
}
$('propLyric').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v) applyToSelection((n) => { n.lyric = v; });
});
$('propVolume').addEventListener('change', (e) => applyToSelection((n) => { n.volume = parseFloat(e.target.value); }));
$('propFlip').addEventListener('change', (e) => applyToSelection((n) => { n.flip = e.target.checked; }));

// ---------- クリップ ----------
function refreshClips() {
  const p = store.project;
  if (activeClipId && !store.clipById(activeClipId)) activeClipId = null;

  const list = $('clipList');
  list.innerHTML = '';
  p.clips.forEach((c) => {
    const li = document.createElement('li');
    li.classList.toggle('active', c.id === activeClipId);
    const used = p.notes.filter((n) => n.lyric === c.name).length;
    li.innerHTML = `<span class="swatch"></span><span class="name"></span><span class="meta"></span>`;
    li.querySelector('.swatch').style.background = c.color;
    li.querySelector('.name').textContent = c.name;
    li.querySelector('.meta').textContent = `${c.start.toFixed(2)}–${c.end.toFixed(2)}s · ${midiName(c.basePitch)} · ${used}ノート`;
    li.addEventListener('click', () => selectClip(c.id, true));
    list.appendChild(li);
  });

  $('clipNames').innerHTML = '';
  p.clips.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.name;
    $('clipNames').appendChild(o);
  });

  const c = store.clipById(activeClipId);
  $('clipEditor').setAttribute('aria-disabled', c ? 'false' : 'true');
  if (c) {
    if (document.activeElement !== $('clipName')) $('clipName').value = c.name;
    $('clipStart').value = c.start.toFixed(3);
    $('clipEnd').value = c.end.toFixed(3);
    $('clipPitch').value = c.basePitch;
    $('clipPitchName').textContent = midiName(c.basePitch);
  }
  sourceView.clips = p.clips;
  sourceView.activeClipId = activeClipId;
  sourceView.draw();
}

function selectClip(id, audition) {
  activeClipId = id;
  const c = store.clipById(id);
  if (c) {
    sourceView.setSelection(c.start, c.end);
    if (sourceVideo.src) sourceVideo.currentTime = c.start;
    if (audition) engine.preview(c, c.basePitch, c.end - c.start);
  }
  refreshClips();
}

sourceView.onSelectionCommit = (start, end) => {
  const c = store.clipById(activeClipId);
  if (!c) { setStatus('範囲を選択しました。「＋ 選択範囲からクリップ作成」でクリップにできます。'); return; }
  store.checkpoint();
  c.start = start;
  c.end = end;
  store.emit();
};

function nextClipName() {
  const kana = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
  for (const ch of kana) if (!store.project.clips.some((c) => c.name === ch)) return ch;
  return 'clip' + (store.project.clips.length + 1);
}

$('newClipBtn').addEventListener('click', () => {
  if (!engine.buffer) { setStatus('先に素材を読み込んでください。', true); return; }
  let start;
  let end;
  if (sourceView.sel) ({ start, end } = sourceView.sel);
  else { start = sourceVideo.currentTime || 0; end = Math.min(engine.buffer.duration, start + 0.4); }
  store.checkpoint();
  const clip = {
    id: uid('c'), name: nextClipName(), start, end, basePitch: 60, color: clipColor(store.project.clips.length),
  };
  const detected = engine.detectPitch(start, end);
  if (detected != null && detected >= 24 && detected <= 96) clip.basePitch = detected;
  store.project.clips.push(clip);
  activeClipId = clip.id;
  store.emit();
  $('clipName').focus();
  $('clipName').select();
  setStatus(`クリップ「${clip.name}」を作成しました（推定音程 ${midiName(clip.basePitch)}）。名前を歌詞と同じにすると発音されます。`);
});

function editActiveClip(fn) {
  const c = store.clipById(activeClipId);
  if (!c) return;
  store.checkpoint();
  fn(c);
  store.emit();
}

$('clipName').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  if (store.project.clips.some((c) => c.name === v && c.id !== activeClipId)) {
    setStatus(`「${v}」という名前のクリップは既にあります。`, true);
    return;
  }
  editActiveClip((c) => {
    // 旧名を使っていたノートの歌詞も追従させる
    store.project.notes.forEach((n) => { if (n.lyric === c.name) n.lyric = v; });
    c.name = v;
  });
});
$('clipStart').addEventListener('change', (e) => editActiveClip((c) => {
  c.start = Math.max(0, Math.min(parseFloat(e.target.value) || 0, c.end - 0.005));
  sourceView.setSelection(c.start, c.end);
}));
$('clipEnd').addEventListener('change', (e) => editActiveClip((c) => {
  c.end = Math.max(c.start + 0.005, parseFloat(e.target.value) || 0);
  sourceView.setSelection(c.start, c.end);
}));
$('clipPitch').addEventListener('change', (e) => editActiveClip((c) => {
  c.basePitch = Math.max(0, Math.min(127, parseInt(e.target.value, 10) || 60));
}));
$('clipPlayBtn').addEventListener('click', () => {
  const c = store.clipById(activeClipId);
  if (c) engine.preview(c, c.basePitch, c.end - c.start);
});
$('clipDetectBtn').addEventListener('click', () => {
  const c = store.clipById(activeClipId);
  if (!c) return;
  const m = engine.detectPitch(c.start, c.end);
  if (m == null) { setStatus('音程を推定できませんでした（範囲が短すぎるか無音です）。', true); return; }
  editActiveClip((cc) => { cc.basePitch = m; });
  setStatus(`推定音程: ${midiName(m)}`);
});
$('clipDeleteBtn').addEventListener('click', () => {
  const c = store.clipById(activeClipId);
  if (!c) return;
  store.checkpoint();
  store.project.clips = store.project.clips.filter((x) => x.id !== c.id);
  activeClipId = null;
  store.emit();
});

// ---------- ツールバー ----------
$('bpmInput').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (!(v >= 20 && v <= 400)) { e.target.value = store.project.bpm; return; }
  store.checkpoint();
  store.project.bpm = v;
  store.emit();
  if (engine.playing) engine.play(store.project, roll.playhead);
});
$('snapSelect').addEventListener('change', (e) => {
  roll.snap = parseFloat(e.target.value);
  if (roll.snap) roll.lastLength = Math.max(roll.snap, Math.round(roll.lastLength / roll.snap) * roll.snap);
  roll.invalidate();
});
function setTool(t) {
  roll.tool = t;
  $('toolDraw').classList.toggle('active', t === 'draw');
  $('toolSelect').classList.toggle('active', t === 'select');
}
$('toolDraw').addEventListener('click', () => setTool('draw'));
$('toolSelect').addEventListener('click', () => setTool('select'));
$('undoBtn').addEventListener('click', () => store.undo());
$('redoBtn').addEventListener('click', () => store.redo());

for (const [id, key] of [['optShowLyrics', 'showLyrics'], ['optHoldFrame', 'holdLastFrame'], ['optLoop', 'loopShortClips']]) {
  $(id).addEventListener('change', (e) => {
    store.checkpoint();
    store.project[key] = e.target.checked;
    store.emit();
  });
}

// ---------- 保存 / 読み込み / 書き出し ----------
$('newBtn').addEventListener('click', () => {
  if (!confirm('新しいプロジェクトを作成しますか？（現在の内容は Ctrl+Z で戻せます）')) return;
  stop();
  const mediaName = store.project.mediaName;
  store.load(Object.assign(createProject(), { mediaName }));
  roll.setSelection([]);
  seek(0);
});
$('saveBtn').addEventListener('click', () => {
  download(new Blob([JSON.stringify(store.project, null, 2)], { type: 'application/json' }), `${baseName()}.aiueo.json`);
  setStatus('プロジェクトを保存しました（素材ファイルは含まれません）。');
});
$('projectInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (!Array.isArray(p.notes) || !Array.isArray(p.clips)) throw new Error('形式が正しくありません');
    stop();
    store.load(p);
    roll.setSelection([]);
    activeClipId = null;
    setStatus(`プロジェクトを開きました。素材「${p.mediaName || '?'}」を読み込んでください。`);
  } catch (err) {
    setStatus(`プロジェクトを開けませんでした: ${err.message}`, true);
  }
});

$('exportWavBtn').addEventListener('click', async () => {
  if (!engine.buffer || !store.project.notes.length) { setStatus('素材とノートが必要です。', true); return; }
  setStatus('WAV をレンダリング中…');
  try {
    const rendered = await engine.renderOffline(store.project);
    download(encodeWav(rendered), `${baseName()}_mad.wav`);
    setStatus('WAV を書き出しました。');
  } catch (err) {
    setStatus(`書き出しに失敗しました: ${err.message}`, true);
  }
});

$('exportVideoBtn').addEventListener('click', () => {
  if (exporting) return;
  if (!engine.buffer || !store.project.notes.length) { setStatus('素材とノートが必要です。', true); return; }
  if (typeof MediaRecorder === 'undefined') { setStatus('このブラウザは動画書き出しに対応していません。', true); return; }
  stop();
  const ctx = engine.ensure();
  const dest = ctx.createMediaStreamDestination();
  engine.master.connect(dest);
  const stream = new MediaStream([
    ...$('previewCanvas').captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    engine.master.disconnect(dest);
    stream.getTracks().forEach((t) => t.stop());
    exporting = false;
    $('exportVideoBtn').disabled = false;
    const type = rec.mimeType || 'video/webm';
    download(new Blob(chunks, { type }), `${baseName()}_mad.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    setStatus('動画を書き出しました。');
  };

  exporting = true;
  $('exportVideoBtn').disabled = true;
  setStatus('動画を書き出し中…（リアルタイム録画です。完了までこのタブを表示したままにしてください）');
  roll.playhead = 0;
  rec.start(500);
  engine.play(store.project, 0);
  $('playBtn').textContent = '■';
  const total = (store.endBeat() * 60) / store.project.bpm + 0.6;
  setTimeout(() => {
    stop();
    rec.stop();
  }, total * 1000 + 100);
});

$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());

// ---------- キーボード ----------
let clipboard = [];

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || $('helpDialog').open) return;
  const mod = e.ctrlKey || e.metaKey;
  const sel = roll.selectedNotes();
  const p = store.project;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.key === 'Home') { seek(0); roll.ensureVisible(0); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); roll.setSelection(p.notes.map((n) => n.id)); return; }
  if (mod && e.key.toLowerCase() === 'c') {
    if (!sel.length) return;
    const min = Math.min(...sel.map((n) => n.start));
    clipboard = sel.map((n) => ({ ...n, start: n.start - min }));
    setStatus(`${sel.length} 個のノートをコピーしました。`);
    return;
  }
  if (mod && e.key.toLowerCase() === 'v') {
    if (!clipboard.length) return;
    e.preventDefault();
    store.checkpoint();
    const at = roll.snapFloor(roll.playhead);
    const pasted = clipboard.map((n) => ({ ...n, id: uid('n'), start: n.start + at }));
    p.notes.push(...pasted);
    roll.setSelection(pasted.map((n) => n.id));
    const len = Math.max(...clipboard.map((n) => n.start + n.length));
    seek(at + len);
    store.emit();
    return;
  }
  if (mod) return;

  if (e.key === 'd' || e.key === 'D') { setTool('draw'); return; }
  if (e.key === 's' || e.key === 'S') { setTool('select'); return; }
  if (!sel.length) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    store.checkpoint();
    p.notes = p.notes.filter((n) => !roll.selection.has(n.id));
    roll.setSelection([]);
    store.emit();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    editLyric(sel.sort((a, b) => a.start - b.start)[0]);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
    if (sel.some((n) => n.pitch + d < roll.minPitch || n.pitch + d > roll.maxPitch)) return;
    applyToSelection((n) => { n.pitch += d; });
    roll.onPreviewNote(sel[0]);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const d = (e.key === 'ArrowRight' ? 1 : -1) * (roll.snap || 0.25);
    if (sel.some((n) => n.start + d < 0)) return;
    applyToSelection((n) => { n.start += d; });
  } else if (e.key === 'f' || e.key === 'F') {
    const v = !sel.every((n) => n.flip);
    applyToSelection((n) => { n.flip = v; });
  }
});

// ---------- 初期化 ----------
function refreshAll() {
  const p = store.project;
  const live = new Set(p.notes.map((n) => n.id));
  const kept = [...roll.selection].filter((id) => live.has(id));
  if (kept.length !== roll.selection.size) roll.selection = new Set(kept);
  $('bpmInput').value = p.bpm;
  $('optShowLyrics').checked = !!p.showLyrics;
  $('optHoldFrame').checked = !!p.holdLastFrame;
  $('optLoop').checked = !!p.loopShortClips;
  $('undoBtn').disabled = !store.undoStack.length;
  $('redoBtn').disabled = !store.redoStack.length;
  refreshClips();
  refreshProps();
  roll.invalidate();
}
store.subscribe(refreshAll);

store.restoreAutosave();
refreshAll();
if (store.project.mediaName && store.project.notes.length) {
  setStatus(`前回の作業を復元しました。素材「${store.project.mediaName}」を開き直してください。`);
}
requestAnimationFrame(frame);
