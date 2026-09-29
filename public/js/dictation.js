/* Dictation: mic button in the composer, Web Speech API for transcription,
   and a pulsing dot + timer while recording. Self-contained — no globals,
   no top-level collisions with the other public/js modules. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const micBtn = $('mic-btn');
  const bar = $('dictation-bar');
  const timeEl = $('dictation-time');
  const composer = $('composer');
  const input = () => $('composer-input');
  const notify = (msg, kind) => { if (typeof toast === 'function') toast(msg, kind); };

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (micBtn) micBtn.hidden = true; // unsupported browser: no button at all
    return;
  }

  let dictating = false;
  let rec = null;
  let timerId = 0;
  let startTs = 0;
  let baseText = '';
  let finalText = '';

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

  function start() {
    if (dictating) return;

    // Dictation appends to whatever draft is already there.
    baseText = input().value;
    if (baseText && !/\s$/.test(baseText)) baseText += ' ';
    finalText = '';

    rec = new SR();
    // Android Chrome drops recognition results when continuous=true —
    // use single-utterance mode there and restart onend instead.
    rec.continuous = !/Android/i.test(navigator.userAgent || '');
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    let lastError = '';
    let instantDeaths = 0;
    let turnStart = 0;
    const markTurnStart = () => { turnStart = Date.now(); };
    rec.onresult = (e) => {
      instantDeaths = 0; // results are flowing — the service is alive
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      setInput(baseText + finalText + interim);
    };
    rec.onerror = (e) => {
      lastError = e.error || 'unknown';
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        notify('Microphone blocked — allow mic access to dictate.', 'error');
        stop();
      }
      // Other errors ('no-speech', 'aborted', 'network', …) just end the
      // turn; onend decides whether to restart or give up.
    };
    // Chrome ends recognition after a pause even in continuous mode —
    // restart it so dictation keeps going until the user stops it.
    // But if the service dies instantly and repeatedly (dies <1s after
    // start, no results), it's broken — stop and say why instead of
    // leaving a dead indicator with no text.
    rec.onend = () => {
      if (!dictating || !rec) return;
      const livedMs = Date.now() - turnStart;
      if (livedMs < 1000 && !finalText) {
        instantDeaths++;
        if (instantDeaths >= 3) {
          notify(`Dictation failed (${lastError || 'speech service unavailable'}).`, 'error');
          stop();
          return;
        }
      } else {
        instantDeaths = 0;
      }
      try { rec.start(); markTurnStart(); } catch (e) { /* already running */ }
    };

    dictating = true;
    try {
      rec.start();
      markTurnStart();
    } catch (e) {
      stop();
      return;
    }

    micBtn.classList.add('recording');
    micBtn.setAttribute('aria-label', 'Stop dictation');
    micBtn.setAttribute('title', 'Stop dictation');
    bar.hidden = false;
    startTs = Date.now();
    tick();
    timerId = setInterval(tick, 250);
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
  }

  function stop() {
    if (!dictating && !rec) return;
    dictating = false;
    try { if (rec) rec.stop(); } catch (e) {}
    rec = null;
    clearInterval(timerId);
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
})();
