'use strict';
// ===== 音声エンジン: クリップを音程変更して鳴らす =====

const pitchRate = (note, clip) => Math.pow(2, (note.pitch - clip.basePitch) / 12);

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffer = null;
    this.sources = [];
    this.playing = false;
    this.t0 = 0;
    this.fromBeat = 0;
    this.spb = 0.5;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async decode(arrayBuffer) {
    this.ensure();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.buffer;
  }

  // ctx / dest を引数にすることでリアルタイム再生とオフライン書き出しで共用する
  static schedule(ctx, dest, project, buffer, fromBeat, t0, sink) {
    const spb = 60 / project.bpm;
    for (const note of project.notes) {
      const clip = project.clips.find((c) => c.name === note.lyric);
      if (!clip) continue;
      if (note.start + note.length <= fromBeat) continue;
      const rate = pitchRate(note, clip);
      const clipLen = clip.end - clip.start;
      if (clipLen <= 0) continue;
      const offsetBeats = Math.max(0, fromBeat - note.start);
      const when = t0 + Math.max(0, note.start - fromBeat) * spb;
      const durSec = (note.length - offsetBeats) * spb;
      let bufOffset = offsetBeats * spb * rate;
      const loop = project.loopShortClips;
      if (loop) bufOffset %= clipLen;
      else if (bufOffset >= clipLen) continue;
      const playSec = loop ? durSec : Math.min(durSec, (clipLen - bufOffset) / rate);
      if (playSec <= 0) continue;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      if (loop) {
        src.loop = true;
        src.loopStart = clip.start;
        src.loopEnd = clip.end;
      }
      // クリック音防止の短いフェード
      const g = ctx.createGain();
      const vol = note.volume ?? 1;
      const fade = Math.min(0.006, playSec / 4);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vol, when + fade);
      g.gain.setValueAtTime(vol, when + playSec - fade);
      g.gain.linearRampToValueAtTime(0, when + playSec);
      src.connect(g).connect(dest);
      src.start(when, clip.start + bufOffset);
      src.stop(when + playSec);
      if (sink) sink.push(src);
    }
  }

  play(project, fromBeat) {
    if (!this.buffer) return false;
    this.ensure();
    this.stop();
    this.spb = 60 / project.bpm;
    this.fromBeat = fromBeat;
    this.t0 = this.ctx.currentTime + 0.05;
    AudioEngine.schedule(this.ctx, this.master, project, this.buffer, fromBeat, this.t0, this.sources);
    this.playing = true;
    return true;
  }

  stop() {
    this.sources.forEach((s) => { try { s.stop(); } catch (e) { /* 既に停止 */ } });
    this.sources = [];
    this.playing = false;
  }

  currentBeat() {
    if (!this.playing) return this.fromBeat;
    return this.fromBeat + Math.max(0, this.ctx.currentTime - this.t0) / this.spb;
  }

  // 単発試聴（鍵盤クリックやクリップ試聴）
  preview(clip, pitch, maxSec = 1.5) {
    if (!this.buffer || !clip) return;
    this.ensure();
    const project = { bpm: 60, loopShortClips: false, clips: [clip], notes: [{ lyric: clip.name, pitch, start: 0, length: maxSec, volume: 1 }] };
    AudioEngine.schedule(this.ctx, this.master, project, this.buffer, 0, this.ctx.currentTime + 0.01, this.sources);
  }

  async renderOffline(project) {
    if (!this.buffer) throw new Error('素材が読み込まれていません');
    const sr = this.buffer.sampleRate;
    const seconds = store.endBeat() * (60 / project.bpm) + 0.5;
    const off = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
    AudioEngine.schedule(off, off.destination, project, this.buffer, 0, 0, null);
    return off.startRendering();
  }

  // 自己相関による簡易ピッチ推定。MIDIノート番号を返す
  detectPitch(start, end) {
    if (!this.buffer) return null;
    const sr = this.buffer.sampleRate;
    const data = this.buffer.getChannelData(0);
    const size = Math.min(4096, Math.floor((end - start) * sr));
    if (size < 512) return null;
    const mid = Math.floor(((start + end) / 2) * sr);
    const from = Math.max(0, mid - (size >> 1));
    const frame = data.subarray(from, from + size);
    const minLag = Math.floor(sr / 1000);
    const maxLag = Math.min(Math.floor(sr / 60), size >> 1);
    // YIN の差分関数（累積平均正規化）
    const d = new Float32Array(maxLag + 1);
    let running = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < size - maxLag; i++) {
        const diff = frame[i] - frame[i + lag];
        sum += diff * diff;
      }
      running += sum;
      d[lag] = running > 0 ? (sum * lag) / running : 1;
    }
    // 閾値を下回った最初の谷を採用。見つからなければ最小値
    let bestLag = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (d[lag] < 0.15) {
        while (lag + 1 <= maxLag && d[lag + 1] < d[lag]) lag++;
        bestLag = lag;
        break;
      }
    }
    if (bestLag < 0) {
      let min = Infinity;
      for (let lag = minLag; lag <= maxLag; lag++) if (d[lag] < min) { min = d[lag]; bestLag = lag; }
    }
    if (bestLag <= 0) return null;
    const freq = sr / bestLag;
    return Math.round(69 + 12 * Math.log2(freq / 440));
  }
}

function encodeWav(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const sr = audioBuffer.sampleRate;
  const buf = new ArrayBuffer(44 + len * ch * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * ch * 2, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(audioBuffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// 素材がなくても試せるよう「あいうえお」っぽいフォルマント合成音を作る
async function synthesizeDemoVowels() {
  const sr = 44100;
  const seg = 0.6;
  const vowels = [
    ['あ', 800, 1200], ['い', 300, 2300], ['う', 320, 1300], ['え', 500, 1900], ['お', 500, 850],
  ];
  const off = new OfflineAudioContext(1, Math.ceil(sr * seg * vowels.length), sr);
  vowels.forEach(([, f1, f2], i) => {
    const t = i * seg;
    const osc = off.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220; // A3
    const env = off.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.45, t + 0.02);
    env.gain.setValueAtTime(0.45, t + seg - 0.08);
    env.gain.linearRampToValueAtTime(0, t + seg - 0.02);
    const mix = off.createGain();
    mix.gain.value = 1;
    [f1, f2].forEach((f, k) => {
      const bp = off.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = 6;
      const g = off.createGain();
      g.gain.value = k === 0 ? 2.5 : 1.5;
      osc.connect(bp).connect(g).connect(mix);
    });
    mix.connect(env).connect(off.destination);
    osc.start(t);
    osc.stop(t + seg);
  });
  const buffer = await off.startRendering();
  const clips = vowels.map(([name], i) => ({
    id: uid('c'), name, start: i * seg + 0.03, end: (i + 1) * seg - 0.03, basePitch: 57, color: clipColor(i),
  }));
  return { buffer, clips };
}
