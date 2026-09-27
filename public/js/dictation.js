/* Dictation: mic button in the composer, Web Speech API for transcription,
   and a quantized live soundwave strip while recording. Self-contained —
   no globals, no top-level collisions with the other public/js modules. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const micBtn = $('mic-btn');
  const bar = $('dictation-bar');
  const wave = $('dictation-wave');
  const timeEl = $('dictation-time');
  const composer = $('composer');
  const input = () => $('composer-input');
  const notify = (msg, kind) => { if (typeof toast === 'function') toast(msg, kind); };

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (micBtn) micBtn.hidden = true; // unsupported browser: no button at all
    return;
  }

  const BARS = 32;   // chunky discrete bars — the digital look
  const WAVE_FPS = 30; // fluid motion; the bars are quantized, not the animation
  const ATTACK = 0.6;  // per-tick ease when rising — snappy but smooth
  const RELEASE = 0.2; // per-tick ease when falling — gentle tail

  let dictating = false;
  let rec = null;
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let freq = null;
  let rafId = 0;
  let lastWaveDraw = 0;
  let shown = new Float32Array(BARS); // eased 0..1 bar levels
  let timerId = 0;
  let startTs = 0;
  let baseText = '';
  let finalText = '';
  let ink = '#1c1813';

  function setInput(v) {
    const el = input();
    el.value = v;
    // The composer wires autogrow, send-button state, and draft saving
    // off the input event — dispatch it so everything follows.
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function tick() { timeEl.textContent = fmt(Date.now() - startTs); }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = wave.getBoundingClientRect();
    wave.width = Math.max(1, Math.round(r.width * dpr));
    wave.height = Math.max(1, Math.round(r.height * dpr));
  }

  function drawWave(now) {
    if (!dictating) return;
    rafId = requestAnimationFrame(drawWave);
    if (now - lastWaveDraw < 1000 / WAVE_FPS) return;
    lastWaveDraw = now;
    analyser.getByteFrequencyData(freq);
    const n = freq.length;
    for (let i = 0; i < BARS; i++) {
      const b0 = Math.floor((i * n) / BARS);
      const b1 = Math.max(b0 + 1, Math.floor(((i + 1) * n) / BARS));
      let v = 0;
      for (let b = b0; b < b1 && b < n; b++) if (freq[b] > v) v = freq[b];
      const target = v / 255;
      // Ease toward the target: quick to rise, gentle to fall. Heights stay
      // fluid — the chunkiness comes from the discrete bars, not stepped
      // snapping between levels (that snapping was the glitchy look).
      const k = target > shown[i] ? ATTACK : RELEASE;
      shown[i] += (target - shown[i]) * k;
      if (shown[i] < 0.004 && target < 0.004) shown[i] = 0; // settle to rest
    }
    const ctx = wave.getContext('2d');
    const W = wave.width, H = wave.height;
    ctx.clearRect(0, 0, W, H);
    const slot = W / BARS;
    const gap = Math.max(1, Math.round(slot * 0.28));
    const bw = slot - gap;
    ctx.fillStyle = ink;
    for (let i = 0; i < BARS; i++) {
      const q = shown[i];
      const h = q * H;
      if (h < 1) continue;
      const x = i * slot + gap / 2;
      const y = (H - h) / 2;
      ctx.globalAlpha = 0.3 + 0.7 * q;
      const r = Math.min(bw / 2, 3);
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, bw, h, r);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, bw, h);
      }
    }
    ctx.globalAlpha = 1;
  }

  async function start() {
    if (dictating) return;
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      notify('Microphone blocked — allow mic access to dictate.', 'error');
      return;
    }
    stream = s;
    try {
      ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || ink;
    } catch (e) { /* keep default */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.55;
    freq = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) {} }

    // Dictation appends to whatever draft is already there.
    baseText = input().value;
    if (baseText && !/\s$/.test(baseText)) baseText += ' ';
    finalText = '';

    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      setInput(baseText + finalText + interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        notify('Microphone blocked — allow mic access to dictate.', 'error');
        stop();
      }
      // 'no-speech', 'aborted', 'network' just end the turn; onend restarts.
    };
    // Chrome ends recognition after a pause even in continuous mode —
    // restart it so dictation keeps going until the user stops it.
    rec.onend = () => {
      if (dictating && rec) {
        try { rec.start(); } catch (e) { /* already running */ }
      }
    };

    dictating = true;
    try {
      rec.start();
    } catch (e) {
      stop();
      return;
    }

    micBtn.classList.add('recording');
    micBtn.setAttribute('aria-label', 'Stop dictation');
    micBtn.setAttribute('title', 'Stop dictation');
    bar.hidden = false;
    sizeCanvas();
    startTs = Date.now();
    tick();
    timerId = setInterval(tick, 250);
    shown = new Float32Array(BARS);
    lastWaveDraw = 0;
    rafId = requestAnimationFrame(drawWave);
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
  }

  function stop() {
    if (!dictating && !rec) return;
    dictating = false;
    try { if (rec) rec.stop(); } catch (e) {}
    rec = null;
    cancelAnimationFrame(rafId);
    clearInterval(timerId);
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      stream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) {}
      audioCtx = null;
    }
    analyser = null;
    freq = null;
    bar.hidden = true;
    micBtn.classList.remove('recording');
    micBtn.setAttribute('aria-label', 'Dictate');
    micBtn.setAttribute('title', 'Dictate');
    const el = input();
    if (el) el.focus({ preventScroll: true });
  }

  micBtn.addEventListener('click', () => (dictating ? stop() : start()));
  // Sending ends dictation first so the final words land in the message.
  composer.addEventListener('submit', () => { if (dictating) stop(); });
  window.addEventListener('resize', () => { if (dictating) sizeCanvas(); });
})();
