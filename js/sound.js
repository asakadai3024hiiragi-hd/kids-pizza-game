// sound.js - Web Audio APIによるサウンド合成(外部音声ファイル不要)、ON/OFF管理
const SOUND_STORAGE_KEY = 'kg_sound_enabled';

const Sound = (function () {
  let audioCtx = null;

  function isEnabled() {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    return raw === null ? true : raw === '1';
  }

  function setEnabled(enabled) {
    localStorage.setItem(SOUND_STORAGE_KEY, enabled ? '1' : '0');
  }

  function ctx() {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // freq: 周波数(Hz), duration: 秒, delay: 開始までの遅延(秒), type: 波形
  function tone(freq, duration, delay = 0, type = 'sine', volume = 0.15) {
    if (!isEnabled()) return;
    try {
      const c = ctx();
      const start = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = freq;
      osc.type = type;
      gain.gain.setValueAtTime(volume, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + duration);
    } catch (e) {
      // 音声非対応環境は無視
    }
  }

  function playStart() {
    tone(440, 0.12, 0);
    tone(660, 0.16, 0.12);
  }

  function playTap() {
    tone(520, 0.08, 0, 'triangle', 0.12);
  }

  function playSuccess() {
    tone(660, 0.1, 0);
    tone(880, 0.14, 0.1);
  }

  function playClear() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, i * 0.1, 'triangle', 0.16));
  }

  function playGameOver() {
    tone(392, 0.2, 0, 'sawtooth', 0.1);
    tone(330, 0.25, 0.18, 'sawtooth', 0.1);
    tone(262, 0.35, 0.36, 'sawtooth', 0.1);
  }

  function playMiss() {
    tone(220, 0.1, 0, 'sine', 0.08);
  }

  return { isEnabled, setEnabled, playStart, playTap, playSuccess, playClear, playGameOver, playMiss };
})();
