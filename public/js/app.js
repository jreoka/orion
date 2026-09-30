/* ============================================================
   Orion — single-page app
   Vanilla JS. History routing: /login, /chat, /admin, /settings.
   All server state flows through the /api/* contract.
   ============================================================ */
'use strict';

/* App shell height: measured, not assumed. On some Android Chrome builds
   100dvh resolves to the *large* viewport (toolbar hidden) while the
   toolbar is actually shown — the app then renders ~56px too tall and the
   composer slides off the bottom of the screen. Pin #app to
   window.innerHeight and re-pin on every resize (rotation, toolbar
   show/hide, keyboard). */
function fitAppHeight() {
  // Don't fight the keyboard layout — it owns the height while typing.
  if (kbActive) return;
  const app = document.getElementById('app');
  if (app) app.style.height = window.innerHeight + 'px';
}
/* iOS Safari: interactive-widget=resizes-content is Chrome-only, so the
   keyboard overlays the layout viewport and window.innerHeight never
   shrinks — the composer floats mid-screen above the keyboard. Use the
   visual viewport instead: when it shrinks, the difference is the keyboard
   height, applied as a bottom offset so the composer rides above it. */
/* iOS Safari keyboard: the layout viewport never shrinks (the Chrome-only
   interactive-widget meta is ignored), so the app must track the visual
   viewport instead. Events are unreliable on iOS, so while the composer is
   focused we poll and pin #app to the visible area. */
/* iOS Safari keyboard: pin the composer above the keyboard with fixed
   positioning. Resizing #app proved unreliable — Safari pans the visual
   viewport independently. This anchors the composer to the visual bottom. */
let kbPoller = null;
let kbActive = false;
function fitForKeyboard() {
  const vv = window.visualViewport;
  const app = document.getElementById('app');
  if (!vv || !app) return;
  const kbH = window.innerHeight - vv.height - (vv.offsetTop || 0);
  kbActive = kbH > 40;
  // Shrink the app to the visible area so the header anchors to the top
  // instead of Safari showing the middle of a full-height page.
  if (kbActive) {
    // Extend slightly past the visual height to tuck under iOS's keyboard
    // accessory bar, closing the gap between composer and keyboard.
    app.style.height = (vv.height + 44) + 'px';
    // Safari pans the visual viewport on focus; pull it back to the top.
    if ((vv.offsetTop || 0) > 1 || window.scrollY > 1) window.scrollTo(0, 0);
  } else app.style.height = '';
}
function startKbPoller() {
  if (kbPoller) return;
  fitForKeyboard();
  kbPoller = setInterval(fitForKeyboard, 300);
}

window.addEventListener('resize', fitAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitForKeyboard);
  window.visualViewport.addEventListener('scroll', fitForKeyboard);
}
/* iOS Safari pans the visual viewport on tap-to-focus and the pan is
   read-only afterwards — prevent it by taking over the tap and focusing
   with preventScroll. */
document.addEventListener('touchstart', (e) => {
  const t = e.target.closest && e.target.closest('#composer-input');
  if (!t) return;
  if (document.activeElement === t) return;
  e.preventDefault();
  try { t.focus({ preventScroll: true }); } catch { t.focus(); }
  // Ensure the caret lands where the finger tapped
  try { const v = t.value; t.setSelectionRange(v.length, v.length); } catch {}
}, { passive: false });
/* Always-on watcher: iOS focus events are flaky (accessory taps blur the
   input), so derive everything from the actual keyboard height instead. */
function startKbPoller() {
  if (kbPoller) return;
  kbPoller = setInterval(fitForKeyboard, 300);
}
startKbPoller();
fitAppHeight();

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
}

/* ---------- API ---------- */
let onUnauthorized = null; // set by boot()

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    // Never serve API responses from the browser's HTTP cache: without an
    // explicit Cache-Control the browser may heuristically cache list
    // responses and show stale (e.g. already-deleted) chats until a manual
    // refresh. The service worker already bypasses /api/ entirely.
    cache: 'no-store',
    // Proves to the server this came from our own pages (CSRF check).
    headers: { 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  // A 401 only means "the session died" when the client believed it had one.
  // A wrong password at the login/signup form also 401s — that must fall
  // through to the normal throw below so the form shows the server's error.
  if (res.status === 401 && onUnauthorized && S.me) { onUnauthorized(); return null; }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
  return data;
}

/* ---------- state ---------- */
const S = {
  me: null,
  activeId: null,     // the open conversation's id
  conversations: [],  // [{id, title, running, updated_at}] for the sidebar
  runByConv: {},      // conversation id -> true while a run is known-active there
  doneByConv: {},      // conversation id -> true when a run finished while the user was looking at another chat
  lastSeenAt: {},     // conversation id -> timestamp the user last opened it
  selfDeletedAt: {},  // conversation id -> timestamp of our own delete (echo suppression for conversation_deleted)
  switching: false,   // a conversation switch is in flight
  messages: [],        // [{id, role, content, attachments}]
  runActive: false,    // an agent run is in flight for the open conversation
  activeArchived: false, // the open conversation is archived (read-only banner, composer hidden)
  evt: null,           // EventSource for the open conversation's event bus
  userEvt: null,       // EventSource for the per-user event bus (usage updates)
  userEvtPoll: null,   // safety-net interval re-syncing the conversation list
  evtRetry: 0,         // reconnect backoff step
  liveIds: new Set(),  // assistant message ids currently streaming
  buffers: new Map(),  // message id -> accumulated streamed text
  toolRows: new Map(), // message id -> [{name, el, open}]
  adminSettings: null,
  adminUsers: [],
  pendingByConv: {},   // conv id (or 'none') -> staged file uploads waiting to be sent [{id, filename, mime, size, url, uploading}]
  jumpUnread: 0,       // new messages arrived while the user was scrolled up
  stick: true,         // follow mode: pinned to the bottom; cleared when the user scrolls up
  turns: [],           // [{id, snippet}] every user message in the open conversation, oldest first
  replyTo: null,       // {id, role, excerpt} of the message being quoted in the composer
};

/* ---------- toasts ---------- */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
}

/* ---------- modal ---------- */
function openModal(html) {
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  bd.addEventListener('mousedown', (e) => { if (e.target === bd) closeModal(); });
  $('#modal-root').appendChild(bd);
  const first = bd.querySelector('input');
  if (first) setTimeout(() => first.focus(), 50);
  return bd;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

// Promise-based confirm dialog.
function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const bd = openModal(`
      <h3>${esc(title)}</h3>
      <p class="muted">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn ${danger ? 'danger-ghost' : 'primary'}" data-x="ok">${esc(confirmLabel)}</button>
      </div>`);
    const done = (v) => { bd.remove(); resolve(v); };
    bd.querySelector('[data-x=cancel]').onclick = () => done(false);
    bd.querySelector('[data-x=ok]').onclick = () => done(true);
  });
}

/* Native prompt dialog (replaces window.prompt). Resolves with the entered
   string, or null when cancelled. */
function promptDialog({ title, message = '', label = '', placeholder = '', value = '', okLabel = 'Save', password = false, maxlength = null }) {
  return new Promise((resolve) => {
    // With a label, the input renders as a Paper-style labeled field (like
    // the change-password modal); without one it keeps the bare input.
    const maxAttr = Number.isInteger(maxlength) && maxlength > 0 ? ` maxlength="${maxlength}"` : '';
    const inputHtml = label
      ? `<label class="field"><span>${esc(label)}</span>
           <input id="pd-input" type="${password ? 'password' : 'text'}"${maxAttr} ${password ? 'autocomplete="current-password"' : ''} value="${esc(value)}" placeholder="${esc(placeholder)}">
         </label>`
      : `<label class="fld">
           <input id="pd-input" type="${password ? 'password' : 'text'}"${maxAttr} ${password ? 'autocomplete="current-password"' : ''} value="${esc(value)}" placeholder="${esc(placeholder)}">
         </label>`;
    const bd = openModal(`
      <h3>${esc(title)}</h3>
      ${message ? `<p class="muted">${esc(message)}</p>` : ''}
      <form id="pd-form" autocomplete="off">
        ${inputHtml}
        <div class="modal-actions">
          <button type="button" class="btn" data-x="cancel">Cancel</button>
          <button type="submit" class="btn primary">${esc(okLabel)}</button>
        </div>
      </form>`);
    const done = (v) => { bd.remove(); resolve(v); };
    bd.querySelector('[data-x=cancel]').onclick = () => done(null);
    const input = bd.querySelector('#pd-input');
    input.focus();
    if (value) input.select();
    bd.querySelector('#pd-form').onsubmit = (e) => { e.preventDefault(); done(input.value); };
  });
}

/* Parse a token limit: plain numbers or shorthand like 1K / 1M / 10M / 1B / 3T.
   Empty string means unlimited (null). */
function parseTokenLimit(v) {
  const s = String(v ?? '').trim();
  if (s === '') return { ok: true, value: null };
  const m = /^(\d+(?:\.\d+)?)\s*([kmbt])?$/i.exec(s);
  if (!m) return { ok: false, error: 'Use a number like 1000000 — or shorthand like 1K, 1M, 10M, 1B, 3T.' };
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || '').toLowerCase()] || 1;
  const n = Math.floor(Number(m[1]) * mult);
  if (n <= 0) return { ok: false, error: 'The limit must be a positive number.' };
  return { ok: true, value: n };
}
// Compact display twin of parseTokenLimit: 1000000 → "1M", 1500000 → "1.5M".
// Only shortens when it round-trips exactly through parseTokenLimit.
function formatTokenLimit(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return String(v);
  for (const [mag, sfx] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (n >= mag) {
      const q = n / mag;
      const str = Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/\.?0+$/, '');
      if (Math.floor(Number(str) * mag) === n) return str + sfx;
      break; // right magnitude but not cleanly expressible — show the full number
    }
  }
  return String(n);
}

/* ---------- routing ---------- */
const ROUTES = ['login', 'chat', 'admin', 'settings', 'pending'];
const VIEW_ID = { login: 'view-auth', chat: 'view-chat', admin: 'view-admin', settings: 'view-settings', pending: 'view-pending' };
function route() {
  const p = location.pathname.replace(/^\/+|\/+$/g, '');
  // Push-notification deep links (/chat/123) land on the single chat.
  if (/^chat\/\d+$/.test(p)) return 'chat';
  return ROUTES.includes(p) ? p : 'chat';
}
function go(r) {
  history.pushState({}, '', '/' + r);
  render();
}

async function render() {
  const r = route();
  if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
  if (!S.me && r !== 'login' && r !== 'pending') { go('login'); return; }
  if (S.me && (r === 'login' || r === 'pending')) { go('chat'); return; }
  if (r === 'admin' && S.me && S.me.role !== 'admin') { go('chat'); return; }
  for (const v of ROUTES) { const el = document.getElementById(VIEW_ID[v]); if (el) el.hidden = v !== r; }
  if (r === 'login') renderAuth();
  else if (r === 'chat') renderChat();
  else if (r === 'admin') renderAdmin();
  else if (r === 'settings') renderSettings();
  else if (r === 'pending') renderPending();
}
// pushState fires no event, so go() renders explicitly; back/forward buttons
// arrive here.
window.addEventListener('popstate', () => {
  render();
});

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // NOTE: no reload on controllerchange. sw.js never changes between
    // deploys, so controllerchange only fires on a fresh install — where
    // the page just loaded the latest code and a reload 900ms after load
    // would only interrupt the user (e.g. mid-login). Real deploys are
    // picked up by the checkForDeploy poll below.
    // A push-notification tap while a tab is open: the service worker
    // focuses it and asks it to navigate to the conversation.
    navigator.serviceWorker.addEventListener('message', (event) => {      const data = event.data || {};
      if (data.type === 'orion-navigate') {
        // The service worker posts the push deep-link (e.g. '/chat/123').
        // Honor it instead of always landing on the most recent chat.
        const m = /^\/chat\/(\d+)$/.exec(String(data.url || ''));
        const target = m ? Number(m[1]) : null;
        if (target && target !== S.activeId) {
          if (route() !== 'chat') go('chat'); // show the chat view first
          switchConversation(target);
        } else if (route() !== 'chat') go('chat');
        else renderChat();
      }
    });
  });
}

// ---- deploy awareness -----------------------------------------------------
// A long-lived tab can otherwise keep testing a stale build after a deploy
// and report fixed bugs as still broken. /api/health carries the asset hash
// the server baked into index.html; when it differs from the bundle this
// tab loaded, reload once — deferred to run end so a reload never eats
// live state mid-run.
function myAssetVersion() {
  const s = document.querySelector('script[src*="/js/app.js"]');
  const m = s && /[?&]v=([0-9a-f]+)/.exec(s.src || '');
  return m ? m[1] : null;
}
let deployReloadQueued = false;
async function checkForDeploy() {
  try {
    const h = await api('/api/health');
    const mine = myAssetVersion();
    if (!h || !h.asset || !mine || h.asset === mine || deployReloadQueued) return;
    deployReloadQueued = true;
    const go = () => {
      toast('Orion updated — reloading…');
      setTimeout(() => location.reload(), 1200);
    };
    if (S.runActive) {
      // A run is in flight: wait for it to finish, then reload. The run
      // itself is server-side and unaffected by the client reloading.
      const iv = setInterval(() => {
        if (!S.runActive) { clearInterval(iv); go(); }
      }, 2000);
      // Safety valve: never wait more than 10 minutes.
      setTimeout(() => { clearInterval(iv); go(); }, 600000);
    } else go();
  } catch { /* the next tick retries */ }
}
setInterval(checkForDeploy, 60000);

/* ---------- haptics ---------- */
// navigator.vibrate() is Android-only in practice (iOS Safari doesn't
// expose it) — feature-detect and no-op everywhere else. Default on;
// Settings → Appearance can turn it off.
function hapticsEnabled() {
  try { return localStorage.getItem('orion-haptics') !== 'off'; } catch (e) { return true; }
}
function haptic(pattern) {
  if (!hapticsEnabled()) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}
// One delegated press listener covers every button, link, toggle, chip,
// and tray summary — including ones rendered later — without touching
// each handler. A second vibrate() call replaces the first, so the
// stronger confirm patterns below simply override this light tick.
document.addEventListener('pointerdown', (e) => {
  if (e.target && e.target.closest &&
      e.target.closest('button, a, summary, input, select, textarea, label, [role="button"]')) {
    haptic(8);
  }
}, { passive: true });
const hTap = () => haptic(12);
const hConfirm = () => haptic([14, 40, 22]); // message sent / run stopped: a two-tap nudge

/* ---------- boot ---------- */
async function boot() {
  // Old #/ links (bookmarks, old push taps): convert to the path once.
  const hm = /^#\/([a-z]+(?:\/\d+)?)\/?$/.exec(location.hash || '');
  if (hm) history.replaceState({}, '', '/' + hm[1]);
  onUnauthorized = () => {
    // Session died (or was revoked): scrub every trace of the previous
    // user's state before showing login, so a different user signing in on
    // this device can't see chats rendered from memory. Mirrors the logout
    // cleanup in wireUserMenu, plus the streaming buffers.
    // NOTE: deliberately not setRunActive(false) — that fires
    // loadConversationsQuiet(), whose 401 would re-enter onUnauthorized
    // and recurse forever. The DOM effects are reproduced inline instead.
    closeEventStream();
    closeUserEventStream();
    stopPendingDot();
    S.runActive = false;
    S.me = null; S.activeId = null; S.messages = [];
    try { localStorage.removeItem('orion-active-chat'); } catch {}
    S.conversations = [];
    S.doneByConv = {}; saveDoneFlags();
    S.hasMoreOlder = false; S.loadingOlder = false;
    S.buffers.clear(); S.toolRows.clear(); S.liveIds.clear();
    renderSidebar(); updateComposer();
    const ub2 = $('#usage-box'); if (ub2) ub2.hidden = true;
    if (route() !== 'login') go('login'); else render();
  };
  try {
    S.me = await api('/api/auth/me');
  } catch { S.me = null; }
  // Not signed in: only the login and pending routes are reachable.
  if (!S.me && route() !== 'login' && route() !== 'pending') go('login');
  else if (S.me && (location.pathname === '/' || route() === 'login')) {
    history.replaceState({}, '', '/chat');
  }
  if (S.me) adoptTheme(); // server theme wins; else push up this device's choice
  wireGlobal();
  loadDoneFlags();
  loadRunFlags();
  // Cross-tab sync: if another tab sets/clears a done flag, pick it up live.
  // Without this, a run finishing in tab A never shows the green check in tab B.
  window.addEventListener('storage', (e) => {
    if (e.key === DONE_KEY) {
      loadDoneFlags();
      renderSidebar();
    }
    if (e.key === RUN_KEY) {
      loadRunFlags();
    }
  });
  // Also re-load on focus — catches flags set while this tab was in background
  // in browsers where the storage event is unreliable.
  window.addEventListener('focus', () => {
    const before = JSON.stringify(S.doneByConv);
    loadDoneFlags();
    if (JSON.stringify(S.doneByConv) !== before) renderSidebar();
    refreshPendingDot(); // a request may have arrived while the tab was in background
  });
  await render();
  maybeShowPushNudge();
  if (S.me) { refreshUsage(); startUsageTimer(); openUserEventStream(); startPendingDot(); }
}
document.addEventListener('DOMContentLoaded', boot);

/* Temporary on-device layout diagnostics (?debuglayout). Reports real
   measurements from the phone — do not guess at phone-only layout bugs. */
(function () {
  if (!new URLSearchParams(location.search).has('debuglayout')) return;
  setTimeout(() => {
    const r = (el) => {
      if (!el) return 'missing';
      const cs = getComputedStyle(el);
      const rc = el.getBoundingClientRect();
      return `${el.offsetHeight}px h / ${el.scrollHeight}px scrollH / rectTop ${Math.round(rc.top)} rectBottom ${Math.round(rc.bottom)} (display:${cs.display})`;
    };
    // Tallest children inside #messages — identifies WHAT is too tall.
    const box = document.getElementById('messages');
    let tallest = [];
    if (box) {
      tallest = [...box.children]
        .map((el) => ({
          h: el.offsetHeight,
          cls: el.className && el.className.baseVal !== undefined ? '[svg]' : String(el.className || el.id || el.tagName).slice(0, 60),
          id: el.id || '',
        }))
        .sort((a, b) => b.h - a.h)
        .slice(0, 6)
        .map((t) => `${t.cls}${t.id ? '#' + t.id : ''}: ${t.h}px`);
    }
    const metrics = {
      ua: navigator.userAgent,
      inner: `${window.innerWidth}x${window.innerHeight}`,
      visualViewport: window.visualViewport ? `${Math.round(window.visualViewport.width)}x${Math.round(window.visualViewport.height)}` : 'n/a',
      dpr: window.devicePixelRatio,
      supportsDvh: CSS.supports('height', '100dvh'),
      docScrollH: document.documentElement.scrollHeight,
      bodyScrollH: document.body.scrollHeight,
      app: r(document.getElementById('app')),
      viewChat: r(document.getElementById('view-chat')),
      chatMain: r(document.getElementById('chat-main')),
      messages: r(box),
      messagesScrollTop: box ? box.scrollTop : 'n/a',
      messagesChildren: box ? box.children.length : 'n/a',
      tallestChildren: tallest,
      composerWrap: r(document.querySelector('.composer-wrap')),
      url: location.href,
    };
    fetch('/api/debug/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(metrics),
    }).catch(() => {});
    const lines = [];
    for (const [k, v] of Object.entries(metrics)) {
      lines.push(Array.isArray(v) ? `${k}:\n  ${v.join('\n  ')}` : `${k}: ${v}`);
    }
    const pre = document.createElement('pre');
    pre.textContent = lines.join('\n');
    pre.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#000;color:#0f0;'
      + 'font-size:11px;line-height:1.5;padding:12px;white-space:pre-wrap;margin:0;'
      + 'max-height:85vh;overflow:auto;font-family:monospace;';
    document.body.appendChild(pre);
  }, 2500);
})();

/* ============================================================
   Auth view
   ============================================================ */
let authMode = 'login'; // or 'signup'

async function renderAuth() {
  // Hide the signup tab when public signups are disabled (fail open).
  S.turnstileSiteKey = null;
  try {
    const cfg = await api('/api/auth/config');
    const on = !cfg || cfg.signup_enabled !== false;
    $('#tab-signup').hidden = !on;
    if (!on) authMode = 'login';
    S.turnstileSiteKey = (cfg && cfg.turnstile_site_key) || null;
    S.signupApprovalRequired = !!(cfg && cfg.signup_approval_required);
  } catch (e) { $('#tab-signup').hidden = false; }
  S.turnstileToken = null;
  $('#turnstile-slot').hidden = true;
  setAuthMode(authMode);
  $('#auth-error').hidden = true;
  hide2faStep();
  updatePasskeyBtn();
}

/* Cloudflare Turnstile: the widget is rendered only after the first
   Log in / Create account press, and its success callback fires doAuth()
   automatically — no second click needed. */
let turnstileWidgetId = null;
let turnstileScriptPromise = null;
function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load the captcha — check your connection and try again.'));
      document.head.appendChild(s);
    });
  }
  return turnstileScriptPromise;
}
function showTurnstile() {
  const slot = $('#turnstile-slot');
  slot.hidden = false;
  loadTurnstileScript().then(() => {
    if (turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
      return;
    }
    turnstileWidgetId = window.turnstile.render(slot, {
      sitekey: S.turnstileSiteKey,
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      callback: (token) => {
        // Captcha complete — proceed straight to auth, no second click.
        S.turnstileToken = token;
        slot.hidden = true;
        doAuth();
      },
      'expired-callback': () => { S.turnstileToken = null; },
      'error-callback': () => {
        const err = $('#auth-error');
        err.textContent = 'Captcha error — please try again.';
        err.hidden = false;
        $('#auth-submit').disabled = false;
      },
    });
  }).catch((e) => {
    const err = $('#auth-error');
    err.textContent = e.message;
    err.hidden = false;
    $('#auth-submit').disabled = false;
  });
}
async function doAuth() {
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const err = $('#auth-error');
  const btn = $('#auth-submit');
  btn.disabled = true;
  err.hidden = true;
  try {
    if (authMode === 'signup' && password !== $('#auth-confirm').value) {
      err.textContent = 'Passwords do not match.';
      err.hidden = false;
      return;
    }
    const body = { username, password };
    if (S.turnstileToken) body.turnstile_token = S.turnstileToken;
    const res = await api(authMode === 'login' ? '/api/auth/login' : '/api/auth/signup', {
      method: 'POST', body
    });
    if (res && res.need_2fa) { show2faStep(res.challenge); return; }
    if (res && res.pending) {
      // Approval required: no session — park the request token and go wait.
      sessionStorage.setItem('orion_pending', JSON.stringify({ token: res.request_token, username }));
      // Memory only (never stored): lets the waiting screen sign the user in
      // automatically the moment an admin approves.
      S.pendingUsername = username;
      S.pendingPassword = password;
      $('#auth-password').value = '';
      $('#auth-confirm').value = '';
      go('pending');
      return;
    }
    $('#auth-password').value = '';
    $('#auth-confirm').value = '';
    await afterLogin();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    // Turnstile tokens are single-use — a fresh one is needed for any retry.
    S.turnstileToken = null;
    btn.disabled = false;
  }
}

function updatePasskeyBtn() {
  const pk = $('#passkey-btn');
  if (pk) pk.hidden = !(authMode === 'login' && waSupported());
}

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-signup').classList.toggle('active', mode === 'signup');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  const cw = $('#auth-confirm-wrap');
  cw.hidden = mode !== 'signup';
  $('#auth-confirm').required = mode === 'signup';
  if (mode === 'login') $('#auth-confirm').value = '';
  $('#auth-error').hidden = true;
  // When admin approval is required, say so on the signup tab.
  $('#signup-approval-note').hidden = !(mode === 'signup' && S.signupApprovalRequired);
  updatePasskeyBtn();
}

/* ---------- Pending signup view ----------
   After signing up while approval is required, the user lands here.
   The view polls /api/signup-status/:token so the "Sign in" button
   appears the moment an admin approves. */
let pendingPollTimer = null;
let pendingViewWired = false;

function clearPendingPoll() {
  if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
}

function wirePendingViewOnce() {
  if (pendingViewWired) return;
  pendingViewWired = true;
  $('#pending-back').onclick = () => {
    sessionStorage.removeItem('orion_pending');
    clearPendingPoll();
    go('login');
  };
}

function renderPending() {
  clearPendingPoll();
  let info = null;
  try { info = JSON.parse(sessionStorage.getItem('orion_pending')); } catch { /* gone */ }
  if (!info || !info.token) {
    sessionStorage.removeItem('orion_pending');
    go('login');
    return;
  }
  wirePendingViewOnce();
  $('#pending-username').textContent = `Request for “${info.username || 'your account'}”`;
  $('#pending-status').textContent = 'An admin needs to approve your account before you can sign in. This usually happens soon — you can leave this page open.';
  $('#pending-signin').hidden = true;
  const check = async () => {
    let st = null;
    try {
      st = await api('/api/signup-status/' + encodeURIComponent(info.token));
    } catch (e) {
      if (/404/.test(e.message)) {
        clearPendingPoll();
        $('#pending-status').textContent = 'This signup request no longer exists.';
        return;
      }
      return; // transient failure — try again on the next tick
    }
    if (st.status === 'approved') {
      clearPendingPoll();
      sessionStorage.removeItem('orion_pending');
      // Still on the waiting screen with the password in memory: sign straight
      // in instead of making them type it again. (After a refresh the password
      // is gone, so fall through to the manual sign-in button.)
      const pw = S.pendingPassword;
      const un = S.pendingUsername || info.username;
      S.pendingPassword = null;
      S.pendingUsername = null;
      if (pw && un) {
        $('#pending-status').textContent = 'Approved — signing you in…';
        try {
          const lr = await api('/api/auth/login', { method: 'POST', body: { username: un, password: pw } });
          if (lr && !lr.need_2fa) { await afterLogin(); return; }
        } catch { /* fall through to the manual button */ }
      }
      $('#pending-status').textContent = 'Approved — welcome in.';
      const btn = $('#pending-signin');
      btn.hidden = false;
      btn.onclick = () => go('login');
    } else if (st.status === 'denied') {
      clearPendingPoll();
      sessionStorage.removeItem('orion_pending');
      $('#pending-status').textContent = "Your request wasn't approved.";
    }
  };
  check();
  pendingPollTimer = setInterval(check, 10000);
}

function wireGlobal() {
  wirePushNudge();
  wireLongPress();
  wireComposerGlobalKeys();
  // History routing: same-origin links to app routes navigate in place
  // instead of doing a full page load.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="/"]') : null;
    if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    let p = '';
    try {
      p = new URL(a.getAttribute('href'), location.origin).pathname.replace(/^\/+|\/+$/g, '');
    } catch { return; }
    if (ROUTES.includes(p) || /^chat\/\d+$/.test(p)) {
      e.preventDefault();
      go(p || 'chat');
    }
  });
  // Profile (incl. avatar) is fetched once at boot; re-fetch when the tab
  // becomes visible again so changes made on another device appear
  // without a manual reload.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (S.me && Date.now() - hiddenAt > 10000) refreshMe().catch(() => {});
  });
  // Appearance dropdown (Settings → Appearance): Light / Dark / Auto.
  // applyTheme() persists locally and pushes to the server so the choice
  // syncs across devices; 'auto' also follows the OS setting live.
  const themeSel = $('#theme-select');
  if (themeSel) {
    let pref = 'auto';
    try { const l = localStorage.getItem('orion-theme'); if (themePrefValid(l)) pref = l; } catch (e) {}
    if (S.me && themePrefValid(S.me.theme)) pref = S.me.theme;
    themeSel.value = pref;
    themeSel.addEventListener('change', () => {
      if (themePrefValid(themeSel.value)) applyTheme(themeSel.value);
    });
  }
  wireThemeMqOnce();
  // Haptics toggle (Settings → Appearance), persisted across visits. On by
  // default; flipping it on gives a tick so the new setting can be felt.
  const hapticsToggle = $('#haptics-toggle');
  if (hapticsToggle) {
    hapticsToggle.checked = hapticsEnabled();
    hapticsToggle.addEventListener('change', () => {
      try { localStorage.setItem('orion-haptics', hapticsToggle.checked ? 'on' : 'off'); } catch (e) {}
      if (hapticsToggle.checked) hTap();
    });
  }

  $('#tab-login').onclick = () => setAuthMode('login');
  $('#tab-signup').onclick = () => setAuthMode('signup');

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const err = $('#auth-error');
    const btn = $('#auth-submit');
    if (!username || !password) return;
    // Captcha gate: when Turnstile is configured, the widget appears only
    // after this first press; its success callback fires doAuth() itself.
    if (S.turnstileSiteKey && !S.turnstileToken) {
      btn.disabled = true;
      err.hidden = true;
      showTurnstile();
      return;
    }
    await doAuth();
  });

  // 2FA step + passkey login
  $('#passkey-btn').onclick = passkeyLogin;
  $('#auth-2fa-form').addEventListener('submit', submit2fa);
  $('#auth-2fa-back').onclick = hide2faStep;

  // Settings view
  wireSettings();

  // Image lightbox
  $('#lightbox-close').onclick = () => { $('#lightbox').hidden = true; };
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#lightbox').hidden = true; closeModal(); closeUserMenu(); }
  });

  // Chat extras
  wireJumpPill();
  wireUploads();
  // We manage the chat scroll ourselves (jumpToBottom on every render).
  // Without this the browser reapplies its saved scroll position after a
  // reload — sometimes reopening the page scrolled up even though we
  // jumped to the bottom during boot.
  try { history.scrollRestoration = 'manual'; } catch {}
}

function openLightbox(url) {
  $('#lightbox-img').src = url;
  $('#lightbox').hidden = false;
}

/* ============================================================
   Chat view
   ============================================================ */

/* (isImageFile, SVG_CLIP, attachmentHtml live in render.js — shared with the share page) */

/* ---------- messages ---------- */
// Windowing: the DOM only ever holds a suffix of S.messages. Older history
// stays in S.messages (and on the server) and is prepended as the user
// scrolls up, so long chats never overload the browser.
const RENDER_WINDOW = 80;  // messages painted on first load / full re-render
const RENDER_CAP = 200;    // DOM nodes kept; older ones are trimmed from the top
const OLDER_BATCH = 60;

function setMessages(data) {
  S.messages = data.messages || [];
  clearReply();
  S.hasMoreOlder = !!data.hasMoreOlder;
  S.loadingOlder = false;
}

// "Loading older messages" spinner pinned to the top of the list.
let olderSpinner = null;
function ensureOlderSpinner() {
  if (olderSpinner) return olderSpinner;
  olderSpinner = document.createElement('div');
  olderSpinner.id = 'older-spinner';
  olderSpinner.hidden = true;
  olderSpinner.innerHTML = '<span class="spin"></span>';
  return olderSpinner;
}
// Invisible sentinel at the very top of the message list. An
// IntersectionObserver watches it and pages in older history when it
// becomes visible — more reliable than a scrollTop threshold, which can
// miss on momentum scrolls or when the scroll container's geometry shifts
// under late-loading content.
let olderSentinel = null;
function ensureOlderSentinel() {
  if (olderSentinel) return olderSentinel;
  olderSentinel = document.createElement('div');
  olderSentinel.id = 'older-sentinel';
  olderSentinel.setAttribute('aria-hidden', 'true');
  return olderSentinel;
}
let olderObserver = null;
function wireOlderObserver() {
  const box = $('#messages');
  if (olderObserver) olderObserver.disconnect();
  olderObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) loadOlder();
    }
    // Viewport root: fires whether #messages or an ancestor scrolls.
  }, { root: null, rootMargin: '400px 0px 0px 0px', threshold: 0 });
  olderObserver.observe(ensureOlderSentinel());
}
function showOlderSpinner(on) {
  ensureOlderSpinner().hidden = !on;
}

// Prepend an older batch fetched from the server, keeping the view stable.
// Build elements for messages (oldest first), fold finished runs before
// they hit the DOM, and prepend them above the older-spinner while keeping
// the user's viewport stable.
function prependHistoryBatch(msgs) {
  if (!msgs.length) return;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  const frag = document.createDocumentFragment();
  for (const m of msgs) frag.appendChild(messageEl(m)); // S.messages order: oldest first
  // Fold finished runs before they hit the DOM — otherwise older runs
  // flash as loose messages while scrolling up and only jump into work
  // logs when something later re-folds the whole list.
  for (const seg of splitRuns([...frag.children])) foldRunSegment(seg, S.liveIds);
  box.insertBefore(frag, ensureOlderSpinner().nextSibling);
  // Pinned to the top: stay pinned, so the sentinel stays visible and the
  // observer keeps paging in history without the user having to re-scroll.
  // Otherwise preserve the reading position.
  if (prevTop < 100) setScrollTopInstant(box, 0);
  else setScrollTopInstant(box, prevTop + (box.scrollHeight - prevHeight));
}

// Re-attach messages that are loaded in S.messages but missing from the DOM
// (trimRenderedTop() drops top nodes past RENDER_CAP). Returns true when it
// did work. Key by the raw dataset string: optimistic local bubbles use ids
// like 'local-<ts>', which Number() turns into NaN and would resurrect as
// duplicates. Match ALL descendants, not just direct children — rows folded
// into a <details class="worklog"> tray are nested inside .wl-body, and
// treating them as missing re-attaches a duplicate copy on every scroll-up.
function reattachMissingOlder() {
  const box = $('#messages');
  const inDom = new Set();
  for (const n of box.querySelectorAll('[data-mid]')) inDom.add(n.dataset.mid);
  const missing = S.messages.filter((m) => !inDom.has(String(m.id)));
  if (!missing.length) return false;
  prependHistoryBatch(missing);
  return true;
}

// Fetch the next older page from the server and prepend it. Returns true
// when a batch arrived.
async function fetchOlderBatch() {
  if (!S.activeId || !S.messages.length) return false;
  S.loadingOlder = true;
  S.loadingOlderSince = Date.now();
  showOlderSpinner(true);
  try {
    const data = await api(`/api/conversations/${S.activeId}/messages?before=${S.messages[0].id}&limit=${OLDER_BATCH}`);
    const batch = data.messages || [];
    S.hasMoreOlder = !!data.hasMoreOlder;
    if (!batch.length) return false;
    S.messages = [...batch, ...S.messages];
    prependHistoryBatch(batch);
    return true;
  } catch {
    /* a failed page just means scrolling up tries again later */
    return false;
  } finally {
    S.loadingOlder = false;
    showOlderSpinner(false);
  }
}

async function loadOlder() {
  // Safety: if a previous fetch never settled (network hang, unhandled
  // rejection), don't let the guard flag block loading forever.
  if (S.loadingOlder && Date.now() - (S.loadingOlderSince || 0) > 30000) {
    S.loadingOlder = false;
  }
  if (S.loadingOlder || !S.messages.length || !S.activeId) return;
  // Re-attach trimmed nodes first — even when the server has nothing older
  // left (hasMoreOlder false), or scrolling up dead-ends on messages the
  // client already has but can't see.
  if (reattachMissingOlder()) return;
  if (!S.hasMoreOlder) return;
  if (!(await fetchOlderBatch())) return;
  // Still pinned to the top with more on the server? Keep paging. The
  // IntersectionObserver only fires on intersection CHANGES, so it won't
  // re-trigger while the sentinel stays continuously visible — without
  // this the user has to nudge the scroll to load each batch.
  const box = $('#messages');
  if (S.hasMoreOlder && box.scrollTop < 100) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (box.scrollTop < 100 && S.activeId) loadOlder();
  }
}

/* ---------- turn rail: one line per user turn, tap to jump ---------- */
async function loadTurns() {
  const id = S.activeId;
  S.turns = [];
  renderTurnRail();
  if (!id) return;
  try {
    const data = await api(`/api/conversations/${id}/turns`);
    // Stale response: the user switched chats while the fetch was in flight.
    // Never paint another chat's turns onto this one.
    if (!data || S.activeId !== id) return;
    S.turns = data.turns || [];
  } catch {
    /* rail just stays hidden */
  }
  if (S.activeId !== id) return;
  renderTurnRail();
}

function renderTurnRail() {
  const rail = document.getElementById('turn-rail');
  const track = rail && rail.querySelector('.rail-track');
  if (!rail || !track) return;
  const turns = S.turns;
  if (turns.length < 2) { rail.hidden = true; return; }
  rail.hidden = false;
  track.innerHTML = '';
  const n = turns.length;
  turns.forEach((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'turn-tick';
    b.dataset.mid = String(t.id);
    b.style.top = (n === 1 ? 0 : (i / (n - 1)) * 100) + '%';
    b.title = (t.snippet || '').trim() || `Turn ${i + 1}`;
    b.setAttribute('aria-label', `Jump to turn ${i + 1}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); jumpToTurn(t.id); });
    track.appendChild(b);
  });
  paintTurnRail();
}

let railRaf = 0;
function schedulePaintRail() {
  if (railRaf) return;
  railRaf = requestAnimationFrame(() => { railRaf = 0; paintTurnRail(); });
}

// Highlight the tick for the turn the user is currently reading: the
// visible user message closest to the viewport's vertical center. The old
// "last message above a line" approach broke at both extremes — near the
// top it picked the topmost turn, at the very top everything sat above the
// line so it stuck on the last turn.
function paintTurnRail() {
  const track = document.querySelector('#turn-rail .rail-track');
  if (!track || !track.children.length) return;
  const box = document.getElementById('messages');
  const boxRect = box.getBoundingClientRect();
  // The actually-visible slice of the message list: intersect the
  // container's rect with the viewport. (If an ancestor is the real
  // scroller, the container rect can be taller than the screen — using it
  // raw would mark everything "visible" and pin the highlight to one end.)
  const viewTop = Math.max(boxRect.top, 0);
  const viewBottom = Math.min(boxRect.bottom, window.innerHeight);
  let bestMid = null;
  let bestDist = Infinity;
  // The active turn is the topmost visible user message — the turn you're
  // reading from. Skip rows hidden inside collapsed work logs (zero-size
  // rect) — their positions are meaningless.
  for (const n of box.querySelectorAll('[data-mid].user')) {
    const r = n.getBoundingClientRect();
    if (!r.width && !r.height) continue; // hidden
    if (r.bottom < viewTop || r.top > viewBottom) continue; // not visible
    // Distance from the viewport top; a partially-scrolled turn counts as 0.
    const dist = Math.max(0, r.top - viewTop);
    if (dist < bestDist) { bestDist = dist; bestMid = n.dataset.mid; }
  }
  // Fallback: scrolled past everything — highlight the last turn above.
  if (!bestMid) {
    for (const n of box.querySelectorAll('[data-mid].user')) {
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.bottom <= viewTop) bestMid = n.dataset.mid;
      else break;
    }
  }
  for (const t of track.children) {
    t.classList.toggle('active', t.dataset.mid === String(bestMid));
  }
}

// Jump to a turn, paging older history in first when it isn't loaded yet.
async function jumpToTurn(mid) {
  if (S.jumpingTurn) return;
  S.jumpingTurn = true;
  try {
    let guard = 0;
    while (!S.messages.some((m) => m.id === mid) && S.hasMoreOlder && guard++ < 25) {
      if (!(await fetchOlderBatch())) break;
    }
    reattachMissingOlder();
    const el = msgElById(mid);
    if (!el) { toast('Could not find that turn', 'error'); return; }
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.add('turn-flash');
    setTimeout(() => el.classList.remove('turn-flash'), 1200);
    // If we're already there, no scroll event fires — paint directly.
    // Also re-paint after the smooth scroll lands.
    schedulePaintRail();
    setTimeout(() => schedulePaintRail(), 600);
  } finally {
    S.jumpingTurn = false;
  }
}

// Drop message nodes from the top when the DOM grows past RENDER_CAP.
// Only when the user isn't reading the top; scroll position is preserved.
function trimRenderedTop() {
  const box = $('#messages');
  const nodes = box.querySelectorAll(':scope > [data-mid]');
  const over = nodes.length - RENDER_CAP;
  if (over <= 0) return;
  // Don't yank the user's scroll position while they're reading history —
  // but if the DOM is far over cap (a long stream arriving while they're
  // up top), trim anyway so it can't grow unbounded.
  if (box.scrollTop < 200 && over <= 100) return;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  for (let i = 0; i < over && i < nodes.length; i++) nodes[i].remove();
  setScrollTopInstant(box, Math.max(0, prevTop - (prevHeight - box.scrollHeight)));
}
function distFromBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}
function nearBottom() { return distFromBottom() < 120; }
function hideJump() {
  S.jumpUnread = 0;
  $('#jump-latest').hidden = true;
  $('#jump-count').hidden = true;
}
function paintJump() {
  const btn = $('#jump-latest'), count = $('#jump-count');
  btn.hidden = false;
  if (S.jumpUnread > 0) { count.textContent = S.jumpUnread; count.hidden = false; }
  else count.hidden = true;
}
// Instant jump to the bottom. A plain scrollTop assignment (or scrollTo
// with behavior:'auto') still animates when the element has
// scroll-behavior: smooth in CSS, so the behavior is overridden for the
// duration of the jump, then restored.
function jumpToBottom() {
  const box = $('#messages');
  S.stick = true; // an explicit jump (re)pins follow mode
  setScrollTopInstant(box, box.scrollHeight);
  hideJump();
}
// Assign scrollTop without the CSS smooth-scroll animation: compensating
// adjustments (trim, history prepend) must apply instantly — a bare
// assignment animates and the view visibly jerks/glides.
function setScrollTopInstant(box, value) {
  box.style.scrollBehavior = 'auto';
  box.scrollTop = value;
  box.style.scrollBehavior = '';
}
// Explicit scroll: force always goes to the bottom (smoothly, since the
// user tapped the button); auto-follow stays instant.
function scrollBottom(force) {
  if (force) {
    S.stick = true;
    $('#messages').scrollTo({ top: $('#messages').scrollHeight, behavior: 'smooth' });
    hideJump();
  } else if (S.stick) {
    jumpToBottom();
  }
}
// A whole new message landed: follow if pinned, otherwise stay put and
// raise the "jump to latest" pill with a count.
function noteNewMessage() {
  if (S.stick) jumpToBottom();
  else {
    S.jumpUnread++;
    paintJump();
  }
}
// Streamed content grew (tokens, tool rows): follow only when pinned —
// never yank the user's scroll position.
function keepPlace() {
  if (S.stick) jumpToBottom();
  else paintJump();
}
// A model turn that only made tool calls arrives as an assistant row with no
// text (and no attachments). Rendered hidden until text streams in, so it
// takes no layout space — see .msg-empty.
function isEmptyPlaceholder(m) {
  return m.role === 'assistant' && (m.kind || 'message') === 'message' &&
    !m.content && !(m.attachments || []).length;
}

function wireJumpPill() {
  $('#jump-latest').addEventListener('click', () => scrollBottom(true));
  $('#messages').addEventListener('scroll', () => {
    // Follow mode tracks the user's actual position: pinned while they're
    // at the bottom, released the moment they scroll up. Only a scroll
    // *away* from the bottom (scrollTop decreasing) releases the pin — a
    // smooth programmatic glide toward the bottom (e.g. after sending a
    // large paste) fires scroll events mid-flight, and unpinning on those
    // meant the run-status line appended mid-glide was never scrolled to.
    // (nearBottom alone can't be trusted here — content that grows below
    // the viewport while the user sits at the bottom never fires a scroll
    // event.)
    const box = $('#messages');
    const nb = nearBottom();
    if (nb) S.stick = true;
    else if (box.scrollTop < (S.lastScrollTop ?? box.scrollTop)) S.stick = false;
    S.lastScrollTop = box.scrollTop;
    // The circular button lives on screen whenever the user is scrolled up,
    // whether or not new messages arrived.
    if (nearBottom()) hideJump();
    else paintJump();
    schedulePaintRail();
    // Older-history paging is driven by the IntersectionObserver on
    // #older-sentinel (see wireOlderObserver), not a scrollTop threshold.
  }, { passive: true });
  // If an ancestor (or the window) is the actual scroller, #messages never
  // fires scroll — keep the rail highlight in sync anyway. Scroll events
  // fire after the scroll is applied, so these paint with correct data.
  window.addEventListener('scroll', () => { schedulePaintRail(); }, { passive: true, capture: true });
  // Wheel fires BEFORE the browser applies the scroll, so debounce: paint
  // after the scroll settles, not with the stale pre-scroll positions
  // (which would also swallow the real scroll event's paint via the rAF
  // throttle).
  let wheelPaintT = 0;
  document.addEventListener('wheel', () => {
    clearTimeout(wheelPaintT);
    wheelPaintT = setTimeout(() => schedulePaintRail(), 80);
  }, { passive: true });
  document.addEventListener('touchmove', () => { schedulePaintRail(); }, { passive: true });
  // Images finish loading after the scroll already happened (lazy
  // attachments, markdown embeds) and push the bottom further down. If
  // we're pinned, re-pin. (load doesn't bubble, hence capture.)
  $('#messages').addEventListener('load', (e) => {
    if (e.target && e.target.tagName === 'IMG' && S.stick) jumpToBottom();
  }, true);
}

/* ---------- chat search (floating window) ---------- */
let searchTimer = 0;
let searchResults = [];
let searchSel = -1;

// Highlight the first case-insensitive match. Indices are found in the raw
// text and each segment is escaped, so entities can't break the markup.
function highlightMatch(text, q) {
  text = text || '';
  if (!q) return esc(text);
  const li = text.toLowerCase().indexOf(q.toLowerCase());
  if (li < 0) return esc(text);
  return (
    esc(text.slice(0, li)) +
    '<mark>' + esc(text.slice(li, li + q.length)) + '</mark>' +
    esc(text.slice(li + q.length))
  );
}

function openSearch() {
  const ov = $('#search-overlay');
  if (!ov) return;
  ov.hidden = false;
  searchResults = [];
  searchSel = -1;
  const input = $('#search-input');
  input.value = '';
  $('#search-results').innerHTML =
    '<div class="search-hint">Type to search chat titles and messages.</div>';
  setTimeout(() => input.focus(), 0);
}

function closeSearch() {
  const ov = $('#search-overlay');
  if (ov) ov.hidden = true;
  clearTimeout(searchTimer);
  $('#search-input')?.blur();
}

async function runChatSearch(q) {
  q = (q || '').trim();
  if (q.length < 2) {
    searchResults = [];
    searchSel = -1;
    $('#search-results').innerHTML =
      '<div class="search-hint">Type to search chat titles and messages.</div>';
    return;
  }
  try {
    const rows = await api('/api/conversations/search?q=' + encodeURIComponent(q));
    searchResults = Array.isArray(rows) ? rows : [];
  } catch {
    searchResults = [];
  }
  searchSel = searchResults.length ? 0 : -1;
  paintSearchResults(q);
}

function paintSearchResults(q) {
  const box = $('#search-results');
  if (!box) return;
  if (!searchResults.length) {
    box.innerHTML = '<div class="search-hint">No chats match.</div>';
    return;
  }
  box.innerHTML = '';
  searchResults.forEach((r, i) => {
    const b = document.createElement('button');
    b.className = 'search-item' + (i === searchSel ? ' sel' : '');
    b.setAttribute('role', 'option');
    b.innerHTML =
      '<div class="s-title">' + highlightMatch(r.title || 'New chat', q) + '</div>' +
      (r.snippet ? '<div class="s-snippet">' + highlightMatch(r.snippet, q) + '</div>' : '') +
      '<div class="s-meta">' + esc(timeAgo(r.updated_at)) + '</div>';
    b.addEventListener('click', () => {
      closeSearch();
      switchConversation(r.id);
    });
    b.addEventListener('mousemove', () => {
      if (searchSel !== i) {
        searchSel = i;
        paintSearchResults(q);
      }
    });
    box.appendChild(b);
  });
}

function wireSearchOnce() {
  if (wireSearchOnce.done) return;
  wireSearchOnce.done = true;
  $('#search-overlay')?.addEventListener('mousedown', (e) => {
    if (e.target.id === 'search-overlay') closeSearch();
  });
  const input = $('#search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runChatSearch(input.value), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearch();
      return;
    }
    if (!searchResults.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchSel = (searchSel + 1) % searchResults.length;
      paintSearchResults(input.value.trim());
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchSel = (searchSel - 1 + searchResults.length) % searchResults.length;
      paintSearchResults(input.value.trim());
    } else if (e.key === 'Enter') {
      const r = searchResults[searchSel];
      if (r) {
        closeSearch();
        switchConversation(r.id);
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    const ov = $('#search-overlay');
    const open = ov && !ov.hidden;
    if (e.key === 'Escape' && open) {
      closeSearch();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open ? closeSearch() : openSearch();
    }
  });
}

/* ---------- file uploads ---------- */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Staged uploads are per conversation — files staged in chat A must never
// leak into a message sent from chat B. Everything below goes through
// these helpers rather than touching the map directly.
function pendingUploads() {
  const key = S.activeId || 'none';
  return (S.pendingByConv[key] ||= []);
}
function setPendingUploads(arr) {
  S.pendingByConv[S.activeId || 'none'] = arr;
}

function renderAttachTray() {
  const tray = $('#attach-tray');
  tray.hidden = pendingUploads().length === 0;
  tray.innerHTML = '';
  for (const p of pendingUploads()) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (p.uploading ? ' uploading' : '');
    const thumb = p.uploading
      ? '<span class="attach-spin"></span>'
      : isImageFile(p.filename)
        ? `<img class="attach-thumb" src="${esc(p.url)}" alt="">`
        : '<span class="attach-file-ico">' + SVG_CLIP + '</span>';
    chip.innerHTML = `${thumb}<span class="attach-name">${esc(p.filename)}</span><span class="attach-size">${fmtBytes(p.size)}</span><button type="button" class="attach-x" aria-label="Remove attachment">×</button>`;
    chip.querySelector('.attach-x').addEventListener('click', () => {
      setPendingUploads(pendingUploads().filter((x) => x !== p));
      renderAttachTray();
      updateComposer();
    });
    tray.appendChild(chip);
  }
}

async function handleFiles(files) {
  for (const file of files) {
    if (pendingUploads().length >= 10) { toast('At most 10 files per message.', 'error'); break; }
    const p = { id: null, filename: file.name, size: file.size, mime: file.type, url: '', uploading: true };
    pendingUploads().push(p);
    renderAttachTray();
    updateComposer();
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Upload failed');
      Object.assign(p, { id: d.id, filename: d.filename, mime: d.mime, size: d.size, url: d.url, uploading: false });
    } catch (e) {
      setPendingUploads(pendingUploads().filter((x) => x !== p));
      toast(`Couldn't upload ${file.name}: ${e.message}`, 'error');
    }
    renderAttachTray();
    updateComposer();
  }
  $('#file-input').value = '';
}

function wireUploads() {
  $('#attach-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => handleFiles(e.target.files));
  // Pasting a file (e.g. a screenshot) into the composer attaches it.
  $('#composer-input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); handleFiles(files); }
  });
}

/* The composer works without being clicked first: typing anywhere drops
   text into the message box, pasting anywhere attaches image files, and
   Enter sends when the box isn't focused. Desktop-oriented, harmless on
   touch. Only active on the chat view; never steals keys from editable
   fields, focused buttons/links (their native Enter/Space activation wins),
   or open overlays like the message sheet. */
function wireComposerGlobalKeys() {
  const chatVisible = () => S.me && !$('#view-chat').hidden;
  const overlayOpen = () => document.getElementById('msg-sheet');
  const isEditable = (el) =>
    !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));

  document.addEventListener('keydown', (e) => {
    if (!chatVisible() || overlayOpen()) return;
    const t = e.target;
    if (isEditable(t)) return; // composer, login, settings, admin: own handlers
    if (e.ctrlKey || e.metaKey || e.altKey) return; // browser/app shortcuts
    if (t && t.closest && t.closest('button, a, summary, select, [role="button"]')) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(); // no-ops when there's nothing to send
      return;
    }
    // Printable character (space excluded so it keeps scrolling the page):
    // focus the composer and let the browser deliver the keystroke there.
    if (e.key.length === 1 && e.key !== ' ') $('#composer-input')?.focus();
  });

  document.addEventListener('paste', (e) => {
    if (!chatVisible() || overlayOpen()) return;
    if (isEditable(e.target)) return; // composer input has its own handler
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
      $('#composer-input')?.focus();
    }
  });
}

function renderMessages() {
  const box = $('#messages');
  // The live run-status line lives inside #messages; a re-render must not
  // destroy it mid-run or the chat goes silent until the next tool event.
  const status = document.getElementById('run-status');
  box.innerHTML = '';
  box.appendChild(ensureOlderSentinel());
  box.appendChild(ensureOlderSpinner());
  wireOlderObserver();
  const empty = $('#empty-state');
  empty.hidden = S.messages.length > 0;
  // When the empty state shows, hide the (empty) messages container too —
  // otherwise it keeps its flex share plus padding and squeezes the empty
  // state into a scrollable half-screen on mobile.
  box.hidden = S.messages.length === 0;
  // Force a synchronous reflow: some mobile WebViews don't recalculate the
  // flex layout when display toggles here, leaving the empty state visually
  // squeezed into a scrollable half-screen until something else reflows.
  void document.getElementById('chat-main').offsetHeight;
  // Windowed: only the latest RENDER_WINDOW messages hit the DOM.
  const win = S.messages.slice(-RENDER_WINDOW);
  for (const m of win) box.appendChild(messageEl(m));
  if (status) box.appendChild(status); // keep it last, text intact
  collapseWorkLogs(); // completed runs read as one question → one answer
  // A run is in flight: sweep its rows into the live tray now instead of
  // waiting for the next stream event — the rows may have arrived via a
  // re-fetch while the stream was down, and without this they sit loose
  // until (and unless) another event arrives.
  if (S.runActive) foldLiveWorkLog();
  // Full re-render: jump straight to the bottom in the same task as the DOM
  // build, so the first paint is already at the bottom — never a flash of
  // the top followed by a scroll-down. jumpToBottom() overrides the CSS
  // smooth scroll-behavior for the jump (a bare scrollTop assignment still
  // animates otherwise).
  jumpToBottom();
}

// Fold a finished run's intermediate chatter into a single expandable
// "Work log" row, so the chat reads as one question → one answer with the
// mid-run chatter tucked away but still inspectable.
//
// A run is everything after a .msg.user up to the next one. Within a
// finished run, the LAST assistant text message is the final answer —
// everything before it is intermediate and gets folded, in order, into one
// <details>. That covers both send_update notes AND plain mid-run text
// (the model sometimes narrates in ordinary chat text instead of using
// send_update). The in-flight (trailing) run is never touched — it folds
// when the run ends.
// Split an ordered node list into runs at each user message and each run
// boundary (the first assistant row of an agent run). Without the
// run-boundary split, a second run arriving with no intervening user message
// would be treated as part of the previous run — demoting that run's real
// final answer into the work log tray and promoting the new run's text.

function collapseWorkLogs() {
  const box = document.getElementById('messages');
  if (!box) return;
  const runs = splitRuns([...box.children]);

  runs.forEach((seg, ri) => {
    const trailing = ri === runs.length - 1;
    // Only the trailing segment can still be in flight — never fold it
    // while a run might be active here.
    if (trailing && (S.runActive || (S.activeId && S.runByConv[S.activeId]))) return;
    foldRunSegment(seg, S.liveIds);
  });
}

/* (splitRuns, foldRunSegment, isIntermediateCandidate live in render.js — shared with the share page) */


// ---- live work log ------------------------------------------------------
// While a run is in flight, its intermediate chatter accumulates live in an
// open "Work log" tray instead of as loose rows: update notes and any
// assistant text row that a newer row supersedes move into the tray as they
// arrive. The currently-streaming row always stays outside — it's the
// potential final answer. When the run ends (or the user queues a new
// message mid-run) the tray collapses, leaving one question → one answer.
let liveBoxEl = null; // the in-flight run's open tray, if one exists

function liveTray() {
  return liveBoxEl && liveBoxEl.isConnected ? liveBoxEl : null;
}

function foldLiveWorkLog() {
  if (!S.runActive || !S.activeId) return;
  const box = document.getElementById('messages');
  if (!box) return;
  // The in-flight run starts at the last run boundary. A user message that
  // arrives after that boundary came in mid-run (a new run would have
  // planted a newer boundary) — it must NOT split the fold range, or the
  // run's earlier chatter is stranded loose whenever the transient live
  // tray is discarded by a re-render.
  const kids = [...box.children];
  const runStarts = [];
  kids.forEach((el, i) => { if (el.dataset && el.dataset.runStart) runStarts.push(i); });
  let start = 0;
  kids.forEach((el, i) => {
    const isUser =
      el.classList && el.classList.contains('msg') &&
      el.classList.contains('user') && !el.classList.contains('update');
    const isRunStart = el.dataset && el.dataset.runStart;
    if (isRunStart) {
      start = i + 1;
    } else if (isUser) {
      const hasRunStartBefore = runStarts.some((r) => r < i);
      const hasRunStartAfter = runStarts.some((r) => r > i);
      // Mid-run user message (run continues through it): not a boundary.
      if (!(hasRunStartBefore && !hasRunStartAfter)) start = i + 1;
    }
  });
  // The latest assistant text row is the potential final answer — everything
  // before it (plus live update notes) belongs in the tray.
  let lastText = null;
  const items = [];
  for (const el of kids.slice(start)) {
    // Any update note in the in-flight run's segment is live — no marker
    // needed. (The data-live-run marker used to gate this on render-time
    // run state, so notes rendered while S.runActive was briefly false —
    // e.g. the initial render after a reload — never entered the tray.)
    if (el.classList && el.classList.contains('msg') && el.classList.contains('update')) {
      items.push(el);
    } else if (isIntermediateCandidate(el) && !el.querySelector('.imgs > *, .u-imgs > *')) {
      if (lastText) items.push(lastText);
      lastText = el;
    }
    // The tray itself (details.worklog) is not .msg — ignored here.
  }
  if (!items.length) return;
  let tray = liveTray();
  if (!tray) {
    tray = document.createElement('details');
    tray.className = 'worklog';
    tray.dataset.live = '1';
    tray.setAttribute('open', '');
    tray.innerHTML =
      `<summary><span class="wl-live-dot" aria-hidden="true"></span>` +
      `<span class="wl-name">Work log</span><span class="wl-count"></span></summary>` +
      `<div class="wl-body"></div>`;
    items[0].before(tray);
    liveBoxEl = tray;
  }
  const body = tray.querySelector('.wl-body');
  for (const el of items) body.appendChild(el);
  const n = body.children.length;
  tray.querySelector('.wl-count').textContent = `${n} ${n === 1 ? 'entry' : 'entries'}`;
  // Moving rows into the tray shifts the layout — stay pinned to the true bottom.
  if (S.stick) jumpToBottom();
}

function finalizeLiveWorkLog() {
  const tray = liveTray();
  liveBoxEl = null;
  if (!tray) return;
  tray.removeAttribute('open');
  tray.removeAttribute('data-live');
  tray.querySelectorAll('[data-live-run]').forEach((el) => el.removeAttribute('data-live-run'));
}

// Copy-button delegation for code blocks (works for streamed content too).
$('#messages').addEventListener('click', async (e) => {
  const cp = e.target.closest('.copybtn');
  if (cp) {
    const code = cp.closest('.codeblock').querySelector('code').dataset.code || '';
    try { await navigator.clipboard.writeText(code); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = code; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    cp.textContent = 'Copied ✓';
    setTimeout(() => { cp.textContent = 'Copy'; }, 1400);
    return;
  }
  const img = e.target.closest('.msg-img');
  if (img) openLightbox(img.src);
  // Reactions: tap a chip to toggle yours, tap + for the emoji picker.
  const chip = e.target.closest('[data-rx]');
  if (chip) { toggleReaction(chip); return; }
  if (e.target.closest('[data-rxadd]')) { openRxPicker(e.target.closest('[data-rxadd]')); return; }
  const msgCopy = e.target.closest('[data-copy]');
  if (msgCopy) { copyMessage(msgCopy.closest('.msg')?.dataset.mid); return; }
  const msgReply = e.target.closest('[data-reply]');
  if (msgReply) { startReply(msgReply.closest('.msg')?.dataset.mid); return; }
  const quote = e.target.closest('[data-quote]');
  if (quote) { jumpToMessage(quote.dataset.quote); return; }
});

// Right-click (or long-press) a message: Copy / React. Native menu is kept
// for links, images, and active text selections.
$('#messages').addEventListener('contextmenu', (e) => {
  // Android/iOS fire contextmenu after a long-press — the sheet is already
  // open, so just swallow it instead of also opening the desktop menu.
  if (lpFired) { lpFired = false; e.preventDefault(); return; }
  if (e.target.closest('a, img')) return;
  const msgEl = e.target.closest('.msg');
  if (!msgEl) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && msgEl.contains(sel.anchorNode)) return;
  e.preventDefault();
  openMsgMenu(msgEl, e.clientX, e.clientY);
});

function messageEl(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
  wrap.dataset.mid = m.id || '';
  // Run boundary: the first assistant row of an agent run. Work-log folding
  // splits segments here so a previous run's final answer is never demoted
  // to "intermediate" when a new run's rows arrive with no user message
  // between them (e.g. a queued follow-up or a phantom empty run).
  if (m.run_start) wrap.dataset.runStart = '1';
  // Tool-only turns arrive as empty assistant rows. Hide them here — in the
  // single place every render path funnels through — so they never take
  // layout space (not even the flex gap). Unhidden by JS when text streams
  // in. (This used to live only in onBusMessage, so any full re-render
  // resurrected every empty row as ~28px of dead space each.)
  if (isEmptyPlaceholder(m)) wrap.classList.add('msg-empty');
  if (m.kind === 'update') {
    // Mid-run progress note: a slim status line, not a full message card,
    // so a working run reads as one answer with a work log — not a stack
    // of separate messages.
    wrap.classList.add('update');
    // Never collapse the in-flight run's notes: they stay visible until
    // the run ends, then setRunActive(false) clears the mark and folds
    // them into the work log.
    if (S.runActive) wrap.dataset.liveRun = '1';
    wrap.innerHTML = `<div class="upd"><span class="content">${md(m.content || '')}</span></div>`;
    return wrap;
  }
  if (m.kind === 'vault_request') {
    // Secure secret-input widget. The iframe is a same-origin form page;
    // the secret is POSTed straight to the server and never touches chat.
    wrap.classList.add('vault-request');
    let v = {};
    try { v = JSON.parse(m.content || '{}'); } catch { /* fall through */ }
    const reqId = String(v.vault_request_id || '');
    const done = v.status === 'fulfilled';
    wrap.dataset.vaultRequest = reqId;
    wrap.innerHTML = `
      <div class="vault-card">
        <div class="vault-head"><span class="vault-lock" aria-hidden="true">🔒</span>
          <div class="vault-head-text">
            <div class="vault-title">${esc(v.label || 'Secret')}</div>
            ${Array.isArray(v.fields) && v.fields.length ? `<div class="vault-hint">${v.fields.map((f) => esc(f)).join(' · ')}</div>` : ''}
            ${v.hint ? `<div class="vault-hint">${esc(v.hint)}</div>` : ''}
          </div>
        </div>
        <div class="vault-body">${
          done
            ? `<div class="vault-done">Saved to your vault ✓</div>`
            : `<iframe class="vault-frame" title="Secure secret input" src="/vault/form/${encodeURIComponent(reqId)}" sandbox="allow-forms allow-scripts allow-same-origin" loading="lazy"></iframe>
               <div class="vault-note">Enter it above — it goes straight to the encrypted vault, never into chat. Then tell the agent you're done.</div>`
        }</div>
      </div>`;
    return wrap;
  }
  if (m.role === 'user') {
    wrap.innerHTML = userBubbleHtml(m);
  } else {
    wrap.innerHTML = assistantBodyHtml(m);
  }
  return wrap;
}

/* ---------- quote-reply ---------- */
/* (quoteHtml lives in render.js — shared with the share page) */

function startReply(mid) {
  if (!mid || String(mid).startsWith('local-')) return;
  const m = S.messages.find((x) => String(x.id) === String(mid));
  if (!m) return;
  const text = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  S.replyTo = { id: m.id, role: m.role, excerpt: text || '[attachment]' };
  renderReplyBar();
  $('#composer-input')?.focus();
}

function renderReplyBar() {
  const bar = $('#reply-bar');
  if (!bar) return;
  const r = S.replyTo;
  bar.hidden = !r;
  if (!r) return;
  $('#reply-bar-who').textContent = r.role === 'assistant' ? 'Orion' : 'yourself';
  $('#reply-bar-text').textContent = r.excerpt;
}

function clearReply() { S.replyTo = null; renderReplyBar(); }

$('#reply-cancel')?.addEventListener('click', clearReply);

function jumpToMessage(id) {
  const el = document.querySelector(`.msg[data-mid="${CSS.escape(String(id))}"]`);
  if (!el) { toast('Original message is not loaded', 'error'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('quote-flash');
  void el.offsetWidth; // restart the highlight animation
  el.classList.add('quote-flash');
}

/* ---------- reactions ---------- */
const RX_EMOJI = ['❤️', '👍', '👎', '😂', '😮', '😢', '🎉', '🙏', '👏', '🔥', '✅', '🤔', '👀', '💯'];

/* (rxChipHtml, rxRowInner live in render.js — shared with the share page) */

// Refresh one message's reaction row from a grouped-reactions payload.
// Keyed update: only the delta animates — new chips pop in, removed chips
// shrink out, and a grown count bumps its number. Unchanged chips are left
// alone so the row never flashes on re-render.
function applyReactions(messageId, reactions) {
  const msg = S.messages.find((x) => x.id === messageId);
  if (msg) msg.reactions = reactions;
  const row = msgElById(messageId)?.querySelector('[data-rxrow]');
  if (!row) return;
  const next = reactions || [];
  const current = new Map();
  row.querySelectorAll('.rx-chip').forEach((c) => current.set(c.dataset.rx, c));
  const seen = new Set();
  const frag = document.createDocumentFragment();
  for (const r of next) {
    const key = r.emoji;
    seen.add(key);
    let chip = current.get(key);
    if (chip) {
      chip.classList.remove('rx-leave'); // survived a re-render mid-leave
      const nEl = chip.querySelector('.rx-n');
      const newCount = r.count > 1 ? String(r.count) : null;
      const oldCount = nEl ? nEl.textContent : null;
      if (newCount !== oldCount) {
        if (newCount) {
          if (nEl) nEl.textContent = newCount;
          else chip.insertAdjacentHTML('beforeend', `<span class="rx-n">${esc(newCount)}</span>`);
        } else nEl?.remove();
        if ((r.count || 1) > parseInt(oldCount || '1', 10)) {
          chip.classList.remove('rx-bump');
          void chip.offsetWidth; // restart the bump animation
          chip.classList.add('rx-bump');
          const onBumpEnd = (e) => {
            if (e.animationName !== 'rx-chip-bump') return;
            chip.classList.remove('rx-bump');
            chip.removeEventListener('animationend', onBumpEnd);
          };
          chip.addEventListener('animationend', onBumpEnd);
        }
      }
      chip.classList.toggle('mine', !!r.mine);
      chip.title = r.agent ? 'Reacted by Orion' : 'Reacted by you';
      chip.setAttribute('aria-label', `Toggle ${key} reaction`);
    } else {
      const t = document.createElement('template');
      t.innerHTML = rxChipHtml(r).trim();
      chip = t.content.firstElementChild;
      if (!chip) continue;
      chip.classList.add('rx-new');
      chip.addEventListener('animationend', () => chip.classList.remove('rx-new'), { once: true });
    }
    frag.appendChild(chip); // moves existing chips into server order
  }
  current.forEach((chip, key) => {
    if (!seen.has(key)) {
      chip.classList.add('rx-leave');
      setTimeout(() => { if (chip.classList.contains('rx-leave')) chip.remove(); }, 190);
    }
  });
  const anchor = row.querySelector('.rx-reply');
  if (anchor) row.insertBefore(frag, anchor);
  else row.prepend(frag);
}

async function toggleReaction(chip) {
  const mid = chip.closest('.msg')?.dataset.mid;
  if (!mid || String(mid).startsWith('local-')) return;
  const emoji = chip.dataset.rx;
  try {
    const d = chip.classList.contains('mine')
      ? await api(`/api/messages/${mid}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' })
      : await api(`/api/messages/${mid}/reactions`, { method: 'POST', body: { emoji } });
    applyReactions(d.message_id, d.reactions);
  } catch (e) { toast(e.message, 'error'); }
}

async function addReaction(mid, emoji) {
  if (!mid || String(mid).startsWith('local-')) return;
  try {
    const d = await api(`/api/messages/${mid}/reactions`, { method: 'POST', body: { emoji } });
    applyReactions(d.message_id, d.reactions);
  } catch (e) { toast(e.message, 'error'); }
}

function closeRxPicker() {
  document.getElementById('rx-picker')?.remove();
  document.removeEventListener('click', closeRxPickerOutside, true);
}
function closeRxPickerOutside(e) {
  if (!e.target.closest('#rx-picker') && !e.target.closest('[data-rxadd]')) closeRxPicker();
}

function openRxPicker(btn) {
  const wasOpen = !!document.getElementById('rx-picker');
  closeRxPicker();
  if (wasOpen) return; // tapping the + again dismisses
  const mid = btn.closest('.msg')?.dataset.mid;
  if (!mid || String(mid).startsWith('local-')) return;
  const r = btn.getBoundingClientRect();
  openRxPickerAt(mid, r.left + r.width / 2, r.top, r.bottom);
}

// Emoji picker anchored at a point (used by the message context menu).
function openRxPickerAt(mid, x, topEdge, bottomEdge) {
  if (!mid || String(mid).startsWith('local-')) return;
  closeRxPicker();
  const p = document.createElement('div');
  p.className = 'rx-picker';
  p.id = 'rx-picker';
  p.setAttribute('role', 'menu');
  p.innerHTML = RX_EMOJI.map((e) => `<button data-pick="${e}" role="menuitem" aria-label="React ${e}">${e}</button>`).join('');
  document.body.appendChild(p);
  // Anchor above the point, clamped to the viewport.
  p.style.visibility = 'hidden';
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let left = Math.min(Math.max(8, x - pw / 2), window.innerWidth - pw - 8);
  let top = topEdge - ph - 10;
  if (top < 8) top = Math.min((bottomEdge ?? topEdge) + 10, window.innerHeight - ph - 8);
  p.style.left = left + 'px';
  p.style.top = Math.max(8, top) + 'px';
  p.style.visibility = '';
  p.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    closeRxPicker();
    addReaction(mid, b.dataset.pick);
  });
  // Skip the click that opened the picker.
  setTimeout(() => document.addEventListener('click', closeRxPickerOutside, true), 0);
}

/* ---------- message actions: copy + right-click menu ---------- */

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

function messageText(mid) {
  const m = S.messages.find((x) => String(x.id) === String(mid));
  return m?.content || '';
}

async function copyMessage(mid) {
  const ok = await copyText(messageText(mid));
  toast(ok ? 'Copied' : 'Copy failed', ok ? undefined : 'error');
}

function closeMsgMenu() {
  document.getElementById('msg-menu')?.remove();
  document.removeEventListener('click', closeMsgMenuOutside, true);
  document.removeEventListener('keydown', closeMsgMenuEsc, true);
}
function closeMsgMenuOutside(e) {
  if (!e.target.closest('#msg-menu')) closeMsgMenu();
}
function closeMsgMenuEsc(e) {
  if (e.key === 'Escape') closeMsgMenu();
}

function openMsgMenu(msgEl, x, y) {
  closeMsgMenu();
  const mid = msgEl?.dataset.mid;
  if (!mid) return;
  const isLocal = String(mid).startsWith('local-');
  const menu = document.createElement('div');
  menu.id = 'msg-menu';
  menu.className = 'menu';
  menu.style.position = 'fixed';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    ${isLocal ? '' : '<button data-act="reply" role="menuitem">Reply</button>'}
    <button data-act="copy" role="menuitem">Copy text</button>
    ${isLocal ? '' : '<button data-act="react" role="menuitem">Add reaction…</button>'}`;
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.right = 'auto'; // .menu sets right:0 — with both left+right set, fixed positioning stretches to the edge
  menu.style.left = Math.min(Math.max(8, x), window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(Math.max(8, y), window.innerHeight - mh - 8) + 'px';
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMsgMenu();
    if (act === 'copy') copyMessage(mid);
    else if (act === 'react') openRxPickerAt(mid, x, y, y);
    else if (act === 'reply') startReply(mid);
  });
  // Skip the click that opened the menu.
  setTimeout(() => {
    document.addEventListener('click', closeMsgMenuOutside, true);
    document.addEventListener('keydown', closeMsgMenuEsc, true);
  }, 0);
}

/* ---------- long-press bottom sheet (mobile message actions) ---------- */
function closeSheet() {
  document.getElementById('msg-sheet')?.remove();
  document.getElementById('sheet-scrim')?.remove();
  document.removeEventListener('keydown', closeSheetEsc, true);
}
function closeSheetEsc(e) { if (e.key === 'Escape') closeSheet(); }

function openMsgSheet(mid) {
  closeMsgMenu();
  closeSheet();
  haptic(14); // long-press acknowledge
  const isLocal = String(mid).startsWith('local-');
  const preview = messageText(mid).replace(/\s+/g, ' ').trim().slice(0, 90);
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  scrim.id = 'sheet-scrim';
  const sheet = document.createElement('div');
  sheet.className = 'msg-sheet';
  sheet.id = 'msg-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Message actions');
  sheet.innerHTML = `
    <div class="sheet-grab" aria-hidden="true"></div>
    ${preview ? `<div class="sheet-preview">${esc(preview)}</div>` : ''}
    ${isLocal ? '' : `<div class="sheet-rx" role="group" aria-label="Quick reactions">${
      RX_EMOJI.map((e) => `<button data-pick="${e}" aria-label="React ${e}">${e}</button>`).join('')
    }</div>`}
    ${isLocal ? '' : `<button class="sheet-act" data-act="reply">
      <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5 3 7l3.5 3.5"/><path d="M3.5 7H10a3.5 3.5 0 0 1 0 7H8.5"/></svg>
      <span>Reply</span>
    </button>`}
    <button class="sheet-act" data-act="copy">
      <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg>
      <span>Copy text</span>
    </button>`;
  document.body.append(scrim, sheet);
  const showSheet = () => { scrim.classList.add('on'); sheet.classList.add('on'); };
  requestAnimationFrame(() => requestAnimationFrame(showSheet));
  setTimeout(showSheet, 60); // fallback: rAF can be throttled in a backgrounded tab
  scrim.addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => {
    const pk = e.target.closest('[data-pick]');
    if (pk) { closeSheet(); addReaction(mid, pk.dataset.pick); return; }
    if (e.target.closest('[data-act="copy"]')) { closeSheet(); copyMessage(mid); return; }
    if (e.target.closest('[data-act="reply"]')) { closeSheet(); startReply(mid); }
  });
  // Swipe down to dismiss.
  let startY = 0, dy = 0;
  sheet.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; dy = 0; }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    dy = e.touches[0].clientY - startY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    sheet.style.transform = '';
    if (dy > 90) closeSheet();
    dy = 0;
  });
  document.addEventListener('keydown', closeSheetEsc, true);
}

// Long-press on a message opens the sheet. All listeners are passive — the
// 480ms timer is cancelled on any real movement or release, so scrolling
// and text selection are never blocked.
let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
function wireLongPress() {
  const msgs = $('#messages');
  msgs.addEventListener('touchstart', (e) => {
    clearTimeout(lpTimer); lpTimer = null;
    if (e.touches.length > 1) return;
    const msgEl = e.target.closest('.msg');
    if (!msgEl?.dataset.mid) return;
    const t = e.touches[0];
    lpX = t.clientX; lpY = t.clientY; lpFired = false;
    lpTimer = setTimeout(() => {
      lpTimer = null;
      // Don't hijack the native text-selection handles.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && msgEl.contains(sel.anchorNode)) return;
      lpFired = true;
      openMsgSheet(msgEl.dataset.mid);
    }, 480);
  }, { passive: true });
  msgs.addEventListener('touchmove', (e) => {
    if (!lpTimer || !e.touches.length) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - lpX, t.clientY - lpY) > 12) { clearTimeout(lpTimer); lpTimer = null; }
  }, { passive: true });
  const cancel = () => { clearTimeout(lpTimer); lpTimer = null; };
  msgs.addEventListener('touchend', cancel, { passive: true });
  msgs.addEventListener('touchcancel', cancel, { passive: true });
}

let localMsgSeq = 0; // disambiguates optimistic ids minted within the same millisecond
function appendUserMessage(content, attachments, replyTo) {
  const m = { id: `local-${Date.now()}-${localMsgSeq++}`, role: 'user', content, attachments: attachments || [] };
  if (replyTo) {
    m.reply_to = replyTo.id;
    m.reply_to_message = { id: replyTo.id, role: replyTo.role, excerpt: replyTo.excerpt };
  }
  S.messages.push(m);
  $('#messages').appendChild(messageEl(m));
  // A queued message mid-run closes the current visual chapter: collapse the
  // live tray so the new message starts fresh below it.
  finalizeLiveWorkLog();
  trimRenderedTop();
  $('#messages').hidden = false;
  $('#empty-state').hidden = true;
  scrollBottom(true);
  return m;
}

/* ---------- user chip + menu ---------- */
function renderUserChip() {
  const me = S.me;
  const el = $('#user-avatar');
  if (me.avatar_url) {
    el.innerHTML = `<img src="${esc(me.avatar_url)}" alt="">`;
  } else {
    el.textContent = (me.username[0] || '?').toUpperCase();
  }
  $('#menu-admin').hidden = me.role !== 'admin';
}

/* ---------- profile picture ---------- */
function paintAvatar(el, me) {
  el.classList.toggle('has-img', !!me.avatar_url);
  if (me.avatar_url) el.innerHTML = `<img src="${esc(me.avatar_url)}" alt="">`;
  else el.textContent = (me.username[0] || '?').toUpperCase();
}

function renderProfileCard() {
  const me = S.me;
  paintAvatar($('#profile-avatar-btn'), me);
  $('#profile-name').textContent = me.username;
  $('#profile-role').textContent = me.role === 'admin' ? 'Administrator' : 'Member';
  $('#profile-avatar-remove').hidden = !me.avatar_url;
  $('#profile-avatar-sep').hidden = !me.avatar_url;
}

async function refreshMe() {
  S.me = await api('/api/auth/me');
  renderUserChip();
  renderProfileCard();
  renderUsageCard();
}

function wireProfileCard() {
  const input = $('#profile-avatar-input');
  const pick = () => input.click();
  $('#profile-avatar-btn').onclick = pick;
  $('#profile-avatar-change').onclick = pick;
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      const r = await fetch('/api/avatar', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Upload failed');
      await refreshMe();
      toast('Profile picture updated');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#profile-avatar-remove').onclick = async () => {
    try {
      await api('/api/avatar', { method: 'DELETE' });
      await refreshMe();
      toast('Profile picture removed');
    } catch (e) { toast(e.message, 'error'); }
  };
}

function wireUserMenu() {
  const chip = $('#user-chip'), menu = $('#user-menu');
  chip.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('#user-menu') && !e.target.closest('#user-chip')) closeUserMenu(); });
  menu.addEventListener('click', async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closeUserMenu();
    if (act === 'logout') {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
      closeEventStream();
      closeUserEventStream();
      stopPendingDot();
      S.me = null; S.activeId = null; S.messages = [];
    try { localStorage.removeItem('orion-active-chat'); } catch {} S.hasMoreOlder = false; S.loadingOlder = false;
      S.doneByConv = {}; saveDoneFlags();
      const ub = $('#usage-box'); if (ub) ub.hidden = true;
      go('login');
    } else if (act === 'settings') go('settings');
    else if (act === 'shared') sharedChatsModal();
    else if (act === 'vault') vaultModal();
    else if (act === 'admin') go('admin');
  });
}
function closeUserMenu() { const m = $('#user-menu'); if (m) m.hidden = true; }

function changePasswordModal() {
  const bd = openModal(`
    <h3>Change password</h3>
    <p class="muted">Choose a new password for <b>${esc(S.me.username)}</b>.</p>
    <form id="pw-form">
      <label class="field"><span>Current password</span>
        <input id="pw-current" type="password" autocomplete="current-password" required minlength="1">
      </label>
      <label class="field"><span>New password</span>
        <input id="pw-new" type="password" autocomplete="new-password" required minlength="8">
      </label>
      <label class="field"><span>Confirm new password</span>
        <input id="pw-confirm" type="password" autocomplete="new-password" required minlength="8">
      </label>
      <p id="pw-error" class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-x="cancel">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  bd.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = bd.querySelector('#pw-current').value;
    const p1 = bd.querySelector('#pw-new').value;
    const p2 = bd.querySelector('#pw-confirm').value;
    const err = bd.querySelector('#pw-error');
    if (p1 !== p2) { err.textContent = 'Passwords don\u2019t match.'; err.hidden = false; return; }
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { current_password: cur, password: p1 } });
      closeModal();
      toast('Password changed');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

/* ============================================================
   Sidebar: the chat list
   ============================================================ */
function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

// The user is looking at the open chat: any message activity there counts
// as seen, so the sidebar never shows a phantom "new activity" dot on a
// chat they just watched reply. (lastSeenAt was previously only set when
// opening a chat, so every replied-then-left chat looked unread.)
function markSeen() {
  if (S.activeId != null) S.lastSeenAt[S.activeId] = Date.now();
}

// "Run finished while you were away" checks: conversation id -> true.
// Persisted so the check survives a tab reload — it clears only when the
// chat is opened (or deleted).
const DONE_KEY = 'orion-done-chats';
function loadDoneFlags() {
  try {
    const o = JSON.parse(localStorage.getItem(DONE_KEY) || '{}') || {};
    S.doneByConv = {};
    for (const k of Object.keys(o)) if (o[k]) S.doneByConv[k] = true;
  } catch { S.doneByConv = {}; }
}
function saveDoneFlags() {
  try { localStorage.setItem(DONE_KEY, JSON.stringify(S.doneByConv)); } catch {}
}
// Persist which chats had active runs, so a fresh page load can detect
// "was running when I left, now finished" and show the green check.
// Without this, opening the site after a run finished in another chat
// shows no check — the client never observed the running→finished transition.
const RUN_KEY = 'orion-running-chats';
function loadRunFlags() {
  try {
    const o = JSON.parse(localStorage.getItem(RUN_KEY) || '{}') || {};
    S.runByConv = {};
    for (const k of Object.keys(o)) if (o[k]) S.runByConv[k] = true;
  } catch { S.runByConv = {}; }
}
function saveRunFlags() {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(S.runByConv)); } catch {}
}

// Refresh the conversation list (titles, activity, running flags) without
// disturbing the open chat. Called on every run end, on window focus, and
// after create/rename/delete. (This is the function setRunActive always
// expected — its absence used to crash run cleanup.)
// ---- theme: light / dark / auto, synced across devices via users.theme --
// The stored preference is 'light', 'dark', or 'auto'; the effective theme
// resolves 'auto' against the device's prefers-color-scheme.
function themePrefValid(p) { return p === 'light' || p === 'dark' || p === 'auto'; }
function deviceDark() {
  try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
}
function effectiveDark(pref) { return pref === 'dark' || (pref === 'auto' && deviceDark()); }

function applyTheme(pref, save = true) {
  if (!themePrefValid(pref)) pref = 'auto';
  const dark = effectiveDark(pref);
  if (dark) document.documentElement.dataset.theme = 'dark';
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('orion-theme', pref); } catch (e) {}
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', dark ? '#171310' : '#faf7f0');
  const sel = $('#theme-select');
  if (sel) sel.value = pref;
  S.themePref = pref;
  // Push the choice to the server so the user's other devices follow.
  if (save && S.me) {
    S.themePushedAt = Date.now();
    api('/api/auth/me', { method: 'PATCH', body: { theme: pref } }).catch(() => {});
  }
}

// Follow the device's light/dark setting while the preference is 'auto'.
let themeMqWired = false;
function wireThemeMqOnce() {
  if (themeMqWired) return; themeMqWired = true;
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if ((S.themePref || 'auto') === 'auto') applyTheme('auto', false);
    });
  } catch (e) {}
}

// Single post-login landing: re-fetch the authoritative user record
// (login responses don't all carry every field, e.g. theme) and apply
// the synced theme, then go to chat. Every login path funnels here so
// a cleared localStorage can't strand the user on the wrong theme.
async function afterLogin() {
  try { S.me = await api('/api/auth/me'); } catch { /* keep S.me as-is */ }
  if (S.me) adoptTheme();
  S.activeId = null;
  S.messages = []; S.hasMoreOlder = false; S.loadingOlder = false;
  go('chat');
  refreshUsage(); openUserEventStream(); startPendingDot();
}

// Always-compact token count: 1234567 → "1.2M", 10500 → "10.5K", 999 → "999".
function formatCompactTokens(n) {
  n = Number(n) || 0;
  const trim = (v) => v.toFixed(1).replace(/\.0$/, '');
  if (n >= 1e9) return trim(n / 1e9) + 'B';
  if (n >= 1e6) return trim(n / 1e6) + 'M';
  if (n >= 1e3) return trim(n / 1e3) + 'K';
  return String(Math.round(n));
}

// "resets in 2d 4h" — the weekly bucket rolls over Monday 00:00 UTC.
function usageResetIn() {
  const now = Date.now();
  const d = new Date(now);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const mondayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
  const diff = Math.max(0, mondayUTC + 7 * 86400000 - now);
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h`;
  return `resets in ${Math.max(1, Math.floor((diff % 3600000) / 60000))}m`;
}

// Weekly token usage bar in the sidebar. Blue-purple swirl normally,
// orange past 75%, red past 90%.
let usageTimer = null;
async function refreshUsage() {
  const box = $('#usage-box');
  if (!box) return;
  try {
    const u = await api('/api/usage');
    if (!u) { box.hidden = true; return; }
    box.hidden = false;
    const fill = $('#side-usage-fill');
    const unlimited = u.limit === null || u.limit === undefined;
    if (unlimited) {
      // No cap: full-width shimmer, no percentage.
      fill.style.width = '100%';
      fill.classList.remove('warn', 'danger');
      $('#side-usage-pct').textContent = '∞';
      $('#side-usage-tokens').textContent =
        `${formatCompactTokens(u.total_tokens)} tokens · ${usageResetIn()}`;
      box.querySelector('.usage-track').removeAttribute('aria-valuenow');
    } else {
      const pct = Math.min(100, Math.round((u.total_tokens / u.limit) * 100));
      fill.style.width = pct + '%';
      fill.classList.toggle('warn', pct >= 75 && pct < 90);
      fill.classList.toggle('danger', pct >= 90);
      $('#side-usage-pct').textContent = pct + '%';
      $('#side-usage-tokens').textContent =
        `${formatCompactTokens(u.total_tokens)} / ${formatCompactTokens(u.limit)} · ${usageResetIn()}`;
      box.querySelector('.usage-track').setAttribute('aria-valuenow', pct);
    }
  } catch {
    // Transient failure (server restarting, network blip): keep the last
    // known values on screen. The box only hides when the session is dead
    // (the !u path above, after onUnauthorized).
  }
}
function startUsageTimer() {
  if (usageTimer) return;
  usageTimer = setInterval(refreshUsage, 60000);
}

// Boot: the server copy wins when set; otherwise adopt this device's
// local choice and push it up so all devices converge on it. When nothing
// was ever chosen, 'auto' follows the device's light/dark setting.
function adoptTheme() {
  const server = S.me && themePrefValid(S.me.theme) ? S.me.theme : null;
  if (server) { applyTheme(server, false); return; }
  let local = null;
  try { local = localStorage.getItem('orion-theme'); } catch (e) {}
  if (themePrefValid(local)) applyTheme(local, true);
  else applyTheme('auto', false);
}

// Returning to the tab / focusing the window: pick up a theme change
// made on another device. Skipped briefly after a local toggle so a
// slow PATCH round-trip can't flicker the just-chosen theme back.
async function syncThemeFromServer() {
  if (!S.me) return;
  if (Date.now() - (S.themePushedAt || 0) < 5000) return;
  try {
    const me = await api('/api/auth/me');
    const pref = themePrefValid(me.theme) ? me.theme : 'auto';
    S.me.theme = pref;
    applyTheme(pref, false);
  } catch { /* best-effort */ }
}

async function loadConversationsQuiet(retried = false) {
  try {
    const rows = await api('/api/conversations');
    if (!Array.isArray(rows)) return;
    S.conversations = rows;
    let dirty = false;
    let runDirty = false;
    for (const c of rows) {
      if (c.running) {
        if (!S.runByConv[c.id]) { S.runByConv[c.id] = true; runDirty = true; }
        // A new run supersedes the finished check.
        if (S.doneByConv[c.id]) { delete S.doneByConv[c.id]; dirty = true; }
      } else if (c.id !== S.activeId) {
        if (S.runByConv[c.id]) {
          // The run finished while we were looking at another chat —
          // show the green check where the working light was.
          S.doneByConv[c.id] = true;
          dirty = true;
          refreshUsage(); // tokens moved
        }
        if (S.runByConv[c.id]) { delete S.runByConv[c.id]; runDirty = true; }
      }
    }
    // Drop checks for chats that no longer exist.
    for (const id of Object.keys(S.doneByConv)) {
      if (!rows.some((c) => String(c.id) === String(id))) { delete S.doneByConv[id]; dirty = true; }
    }
    if (dirty) saveDoneFlags();
    if (runDirty) saveRunFlags();
    renderSidebar();
  } catch {
    // Sidebar refresh is best-effort, but a single transient failure (flaky
    // mobile network) shouldn't leave a stale list until the next manual
    // refresh — retry once after a short delay.
    if (!retried) setTimeout(() => loadConversationsQuiet(true), 2500);
  }
}

// Date bucket for the sidebar: Today / Yesterday / Previous 7 days /
// Previous 30 days, then one bucket per calendar month.
function convBucketLabel(ts) {
  const d = new Date(ts || 0);
  const now = new Date();
  const startOfDay = (x) => {
    const t = new Date(x);
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  };
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'Previous 7 days';
  if (diffDays <= 30) return 'Previous 30 days';
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function convItemEl(c) {
  const el = document.createElement('div');
  el.className = 'conv-item' + (c.id === S.activeId ? ' active' : '');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = c.title || 'New chat';
  const seen = S.lastSeenAt[c.id] || 0;
  const hasNew = c.id !== S.activeId && seen > 0 && c.updated_at > seen;
  const working = !!(c.running || S.runByConv[c.id]);
  const done = !working && c.id !== S.activeId && !!S.doneByConv[c.id];
  el.innerHTML = `
    <div class="conv-meta">
      <div class="conv-title">${esc(c.title || 'New chat')}</div>
      <div class="conv-sub">${working ? 'working…' : esc(timeAgo(c.updated_at))}</div>
    </div>
    ${working ? '<span class="conv-dot working" aria-label="Agent working"></span>'
              : done ? '<span class="conv-dot done" aria-label="Run finished"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
              : hasNew ? '<span class="conv-dot" aria-label="New activity"></span>' : ''}
    <button class="conv-menu-btn" aria-label="Chat options" title="Chat options">⋯</button>`;
  let lpFired = false;
  el.addEventListener('click', (e) => {
    if (lpFired) { lpFired = false; e.stopPropagation(); e.preventDefault(); return; }
    if (e.target.closest('.conv-menu-btn')) return;
    switchConversation(c.id);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchConversation(c.id); }
  });
  el.querySelector('.conv-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openConvMenu(c, e.currentTarget);
  });
  /* Mobile: long-press a chat to open its options menu. */
  let lpTimer = null;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    lpTimer = setTimeout(() => {
      lpFired = true;
      try { navigator.vibrate && navigator.vibrate(10); } catch {}
      openConvMenu(c, el.querySelector('.conv-menu-btn'));
    }, 500);
  }, { passive: true });
  const lpCancel = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  el.addEventListener('touchmove', lpCancel, { passive: true });
  el.addEventListener('touchend', lpCancel, { passive: true });
  el.addEventListener('touchcancel', lpCancel, { passive: true });
  // Some Android browsers fire contextmenu on long-press — swallow it when
  // our long-press already opened the menu (same gating as the click above).
  el.addEventListener('contextmenu', (e) => { if (lpFired) e.preventDefault(); });
  return el;
}

function renderSidebar() {
  const list = $('#conv-list');
  if (!list) return;
  list.innerHTML = '';
  let activeTitle = 'New chat';
  if (S.conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = 'No chats yet — press + to start one.';
    list.appendChild(empty);
  }
  let lastBucket = null;
  for (const c of S.conversations) {
    if (c.id === S.activeId) activeTitle = c.title || 'New chat';
    const bucket = convBucketLabel(c.updated_at);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      const h = document.createElement('div');
      h.className = 'conv-group';
      h.textContent = bucket;
      list.appendChild(h);
    }
    list.appendChild(convItemEl(c));
  }
  const t = $('#chat-title');
  if (t) t.textContent = activeTitle;
  ensureBgRunPoller();
}

// A backgrounded chat's run_ended event never arrives — its SSE stream was
// closed when we switched away — so its sidebar "working" light would stay
// lit until the chat is reopened. While any non-active conversation carries
// a run mark, poll the cheap conversation list until the server confirms
// the runs ended; the poller stops itself when no background marks remain.
let bgRunTimer = null;
function bgRunMarks() {
  return Object.keys(S.runByConv)
    .some((id) => S.runByConv[id] && String(id) !== String(S.activeId));
}
function ensureBgRunPoller() {
  if (bgRunMarks() && !bgRunTimer) {
    bgRunTimer = setInterval(() => {
      loadConversationsQuiet().finally(() => {
        if (!bgRunMarks() && bgRunTimer) { clearInterval(bgRunTimer); bgRunTimer = null; }
      });
    }, 4000);
  } else if (!bgRunMarks() && bgRunTimer) {
    clearInterval(bgRunTimer); bgRunTimer = null;
  }
}

function closeConvMenu() { document.getElementById('conv-menu')?.remove(); }

function openConvMenu(conv, anchor) {
  closeConvMenu();
  const menu = document.createElement('div');
  menu.id = 'conv-menu';
  menu.className = 'menu';
  menu.innerHTML = `
    <button data-act="share">Share</button>
    <button data-act="rename">Rename</button>
    <button data-act="archive">Archive</button>
    <button data-act="delete" class="danger">Delete</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.zIndex = 120;
  menu.style.top = Math.min(window.innerHeight - 150, r.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 220, r.left - 170)) + 'px';
  menu.style.right = 'auto';
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closeConvMenu();
    if (act === 'rename') renameChatModal(conv);
    else if (act === 'share') shareChatModal(conv);
    else if (act === 'archive') archiveChat(conv);
    else if (act === 'delete') deleteChatModal(conv);
  });
  setTimeout(() => document.addEventListener('click', closeConvMenu, { once: true }), 0);
}

function renameChatModal(conv) {
  const bd = openModal(`
    <h3>Rename chat</h3>
    <form id="rename-form">
      <label class="field"><span>Name</span>
        <input id="rename-input" type="text" maxlength="120" required value="${esc(conv.title || '')}">
      </label>
      <p id="rename-error" class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-x="cancel">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`);
  const input = bd.querySelector('#rename-input');
  input.focus(); input.select();
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  bd.querySelector('#rename-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = bd.querySelector('#rename-error');
    err.hidden = true;
    try {
      await api(`/api/conversations/${conv.id}`, { method: 'PATCH', body: { title: input.value.trim() } });
      closeModal();
      await loadConversationsQuiet();
    } catch (ex) { err.textContent = ex.message || 'Rename failed.'; err.hidden = false; }
  });
}

function deleteChatModal(conv) {
  const bd = openModal(`
    <h3>Delete “${esc(conv.title || 'New chat')}”?</h3>
    <p class="muted">This removes the chat and all of its messages. This can't be undone.</p>
    <div class="modal-actions">
      <button type="button" class="btn" data-x="cancel">Cancel</button>
      <button type="button" class="btn danger-ghost" id="del-confirm">Delete</button>
    </div>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  bd.querySelector('#del-confirm').onclick = async () => {
    try {
      // A chat with a running agent must be stopped first — otherwise the
      // run keeps burning tokens against a conversation that's being deleted.
      if (S.runByConv[conv.id] || (conv.id === S.activeId && S.runActive)) {
        try { await api(`/api/conversations/${conv.id}/stop`, { method: 'POST' }); }
        catch { /* best-effort: the delete proceeds regardless */ }
      }
      // Set BEFORE the DELETE: the server publishes conversation_deleted on the
      // user bus immediately, and the SSE echo can arrive before the API call
      // resolves. Setting it after creates a race where our own delete looks
      // like it came from elsewhere.
      S.selfDeletedAt[conv.id] = Date.now(); // our own delete echoes back on the user bus
      await api(`/api/conversations/${conv.id}`, { method: 'DELETE' });
      closeModal();
      delete S.runByConv[conv.id];
      delete S.doneByConv[conv.id]; saveDoneFlags();
      delete S.lastSeenAt[conv.id];
      delete S.pendingByConv[conv.id];
      toast('Chat deleted');
      await loadConversationsQuiet();
      if (!$('#archive-overlay')?.hidden) loadArchiveList($('#archive-input')?.value || '');
      if (conv.id === S.activeId) {
        const next = S.conversations[0];
        if (next) await switchConversation(next.id);
        else {
          // Last chat deleted: land on the empty state. A new chat is
          // created only when the user starts one.
          closeEventStream();
          setRunActive(false); // no stream left to deliver run_ended; clear Stop now
          S.activeId = null;
          S.activeArchived = false;
          try { localStorage.removeItem('orion-active-chat'); } catch {}
          setMessages({ messages: [], hasMoreOlder: false });
          renderMessages();
          paintArchivedState();
          renderAttachTray();
          updateComposer();
          S.turns = []; renderTurnRail(); // clear the turn rail for the empty state
        }
      }
    } catch (ex) { toast(ex.message || 'Delete failed', 'error'); }
  };
}

function shareUrlFor(token) { return `${location.origin}/s/${token}`; }

// ---- archiving ---------------------------------------------------------------
// Archived chats leave the sidebar but stay fully stored. Archiving never
// stops an in-flight run — the chat just hides; results wait in the archive.
async function archiveChat(conv) {
  try {
    await api(`/api/conversations/${conv.id}/archive`, { method: 'POST' });
    toast('Chat archived');
    await loadConversationsQuiet();
    if (conv.id === S.activeId) {
      const next = S.conversations[0];
      if (next) await switchConversation(next.id);
      else {
        // Last chat archived: land on the empty state, like delete.
        closeEventStream();
        setRunActive(false);
        S.activeId = null;
        S.activeArchived = false;
        try { localStorage.removeItem('orion-active-chat'); } catch {}
        setMessages({ messages: [], hasMoreOlder: false });
        renderMessages();
        paintArchivedState();
        renderAttachTray();
        updateComposer();
        S.turns = []; renderTurnRail(); // clear the turn rail for the empty state
      }
    }
  } catch (ex) { toast(ex.message || 'Archive failed', 'error'); }
}

async function unarchiveChat(id) {
  try {
    await api(`/api/conversations/${id}/unarchive`, { method: 'POST' });
    toast('Chat unarchived');
    await loadConversationsQuiet();
    return true;
  } catch (ex) { toast(ex.message || 'Unarchive failed', 'error'); return false; }
}

// Read-only banner + hidden composer while the open chat is archived.
function paintArchivedState() {
  const archived = !!S.activeArchived;
  const banner = $('#archived-banner');
  if (banner) banner.hidden = !archived;
  const wrap = document.querySelector('.composer-wrap');
  if (wrap) wrap.hidden = archived;
}

// ---- archive overlay (floating window) ---------------------------------------
let archiveRows = [];
let archiveTimer = null;

function openArchive() {
  closeSidebarDrawer();
  const ov = $('#archive-overlay');
  if (!ov) return;
  ov.hidden = false;
  const input = $('#archive-input');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 0); }
  loadArchiveList('');
}

function closeArchive() {
  const ov = $('#archive-overlay');
  if (ov) ov.hidden = true;
  clearTimeout(archiveTimer);
  $('#archive-input')?.blur();
}

async function loadArchiveList(q) {
  q = (q || '').trim();
  const box = $('#archive-results');
  try {
    archiveRows = q.length >= 2
      ? await api('/api/conversations/search?q=' + encodeURIComponent(q) + '&archived=1')
      : await api('/api/conversations/archived');
    if (!Array.isArray(archiveRows)) archiveRows = [];
  } catch {
    archiveRows = [];
  }
  paintArchiveList(q);
}

function archiveMeta(r) {
  const parts = [];
  if (typeof r.message_count === 'number') parts.push(r.message_count + (r.message_count === 1 ? ' message' : ' messages'));
  const t = r.archived_at || r.updated_at;
  if (t) parts.push('archived ' + timeAgo(t));
  return parts.join(' · ');
}

function paintArchiveList(q) {
  const box = $('#archive-results');
  if (!box) return;
  if (!archiveRows.length) {
    box.innerHTML = '<div class="search-hint">' +
      (q && q.length >= 2 ? 'No archived chats match.' : 'No archived chats yet.') + '</div>';
    return;
  }
  box.innerHTML = '';
  archiveRows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'arch-item';
    row.setAttribute('role', 'option');
    row.innerHTML =
      '<button class="arch-open">' +
        '<div class="s-title">' + highlightMatch(r.title || 'New chat', q) + '</div>' +
        (r.snippet ? '<div class="s-snippet">' + highlightMatch(r.snippet, q) + '</div>' : '') +
        '<div class="s-meta">' + esc(archiveMeta(r)) + '</div>' +
      '</button>' +
      '<div class="arch-actions">' +
        '<button class="icon-btn arch-unarchive" aria-label="Unarchive" title="Unarchive">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v4.5h16V15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' +
        '</button>' +
        '<button class="icon-btn danger arch-delete" aria-label="Delete" title="Delete">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
      '</div>';
    row.querySelector('.arch-open').addEventListener('click', () => {
      closeArchive();
      switchConversation(r.id);
    });
    row.querySelector('.arch-unarchive').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await unarchiveChat(r.id)) loadArchiveList($('#archive-input')?.value || '');
    });
    row.querySelector('.arch-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChatModal({ id: r.id, title: r.title });
    });
    box.appendChild(row);
  });
}

function clearArchiveModal() {
  const n = archiveRows.length;
  const bd = openModal(`
    <h3>Delete all archived chats?</h3>
    <p class="muted">This permanently removes ${n} archived chat${n === 1 ? '' : 's'} and all of their messages. This can't be undone.</p>
    <div class="modal-actions">
      <button type="button" class="btn" data-x="cancel">Cancel</button>
      <button type="button" class="btn danger-ghost" id="arch-clear-confirm">Delete all</button>
    </div>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  bd.querySelector('#arch-clear-confirm').onclick = async () => {
    try {
      const res = await api('/api/conversations/archived', { method: 'DELETE' });
      closeModal();
      toast(`Cleared ${res.deleted || 0} archived chat${(res.deleted || 0) === 1 ? '' : 's'}`);
      await loadConversationsQuiet();
      loadArchiveList($('#archive-input')?.value || '');
    } catch (ex) { toast(ex.message || 'Clear failed', 'error'); }
  };
}

function wireArchiveOnce() {
  if (wireArchiveOnce.done) return;
  wireArchiveOnce.done = true;
  $('#archive-btn')?.addEventListener('click', openArchive);
  $('#archive-close')?.addEventListener('click', closeArchive);
  $('#archive-overlay')?.addEventListener('mousedown', (e) => {
    if (e.target.id === 'archive-overlay') closeArchive();
  });
  $('#archive-clear')?.addEventListener('click', () => {
    if (archiveRows.length) clearArchiveModal();
    else toast('Nothing to clear');
  });
  const input = $('#archive-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(archiveTimer);
      archiveTimer = setTimeout(() => loadArchiveList(input.value), 200);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeArchive();
    });
  }
  $('#archived-unarchive')?.addEventListener('click', async () => {
    if (!S.activeId) return;
    if (await unarchiveChat(S.activeId)) {
      S.activeArchived = false;
      paintArchivedState();
    }
  });
  document.addEventListener('keydown', (e) => {
    const ov = $('#archive-overlay');
    if (e.key === 'Escape' && ov && !ov.hidden) closeArchive();
  });
}

async function shareChatModal(conv) {
  const bd = openModal(`
    <h3>Share “${esc(conv.title || 'New chat')}”</h3>
    <p class="muted">Anyone with the link can read this chat as it looks right now. They can't write to it or see your other chats. New messages won't appear on the link unless you share again. Revoking the link (here or in Shared chats) disables it immediately.</p>
    <p id="share-error" class="form-error" hidden></p>
    <div id="share-body"><p class="muted">Creating link…</p></div>
    <div class="modal-actions">
      <button type="button" class="btn" data-x="cancel">Close</button>
    </div>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  const body = bd.querySelector('#share-body');
  const err = bd.querySelector('#share-error');
  let token;
  let freshShare = true;
  try {
    const r = await api(`/api/conversations/${conv.id}/share`, { method: 'POST' });
    token = r.token;
    freshShare = r.fresh !== false;
  } catch (ex) {
    err.textContent = ex.message || 'Could not create the share link.';
    err.hidden = false;
    body.innerHTML = '';
    return;
  }
  const url = shareUrlFor(token);
  body.innerHTML = `
    ${freshShare ? '' : '<p class="muted" style="margin-top:0">This chat was already shared — the link now includes the latest messages.</p>'}
    <label class="field"><span>Share link</span>
      <input id="share-link" type="text" readonly value="${esc(url)}">
    </label>
    <div class="modal-actions" style="justify-content:flex-start;margin-top:12px">
      <button type="button" class="btn primary" id="share-copy">Copy link</button>
      <button type="button" class="btn danger-ghost" id="share-revoke">Revoke link</button>
    </div>`;
  const input = body.querySelector('#share-link');
  input.addEventListener('focus', () => input.select());
  body.querySelector('#share-copy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(url); }
    catch { input.select(); document.execCommand('copy'); }
    e.target.textContent = 'Copied ✓';
    setTimeout(() => { e.target.textContent = 'Copy link'; }, 1500);
  };
  body.querySelector('#share-revoke').onclick = async () => {
    try {
      await api(`/api/conversations/${conv.id}/share`, { method: 'DELETE' });
      closeModal();
      toast('Share link revoked');
    } catch (ex) { toast(ex.message || 'Revoke failed', 'error'); }
  };
}

async function sharedChatsModal() {
  const bd = openModal(`
    <h3>Shared chats</h3>
    <div id="shared-list"><p class="muted">Loading…</p></div>
    <div class="modal-actions">
      <button type="button" class="btn" data-x="cancel">Close</button>
    </div>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  const list = bd.querySelector('#shared-list');
  const render = async () => {
    let shares;
    try {
      shares = (await api('/api/shared')).shares || [];
    } catch {
      list.innerHTML = '<p class="form-error">Couldn\'t load shared chats.</p>';
      return;
    }
    if (!shares.length) {
      list.innerHTML = '<p class="muted">Nothing shared yet. Click the &#8942; menu on a chat in the sidebar and choose Share.</p>';
      return;
    }
    list.innerHTML = shares.map((s) => {
      const when = s.created_at
        ? new Date(s.created_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
      return `
      <div class="shared-row">
        <div class="shared-info">
          <div class="shared-title">${esc(s.title || 'Untitled chat')}</div>
          ${when ? `<div class="shared-meta">Shared ${esc(when)}</div>` : ''}
        </div>
        <div class="shared-actions">
          <button type="button" class="btn" data-copy="${esc(s.token)}">Copy link</button>
          <button type="button" class="btn danger-ghost" data-revoke="${s.conversation_id}">Revoke</button>
        </div>
      </div>`;
    }).join('');
  };
  list.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    const revokeBtn = e.target.closest('[data-revoke]');
    if (copyBtn) {
      try { await navigator.clipboard.writeText(shareUrlFor(copyBtn.dataset.copy)); }
      catch { /* clipboard unavailable — link stays visible in the row below */ }
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
    } else if (revokeBtn) {
      revokeBtn.disabled = true;
      try {
        await api(`/api/conversations/${revokeBtn.dataset.revoke}/share`, { method: 'DELETE' });
        toast('Share link revoked');
        await render();
      } catch (ex) {
        toast(ex.message || 'Revoke failed', 'error');
        revokeBtn.disabled = false;
      }
    }
  });
  await render();
}

// Vault popup: the same list-and-revoke as the Settings Vault tab, reachable
// from the user menu without leaving the chat.
async function vaultModal() {
  const bd = openModal(`
    <h3>Vault</h3>
    <p class="muted" style="margin-top:-6px">Secrets the agent stored through its secure forms. Values never leave the vault — this lists labels only.</p>
    <div id="vault-list"><p class="muted">Loading…</p></div>
    <div class="modal-actions">
      <button type="button" class="btn" data-x="cancel">Close</button>
    </div>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  const list = bd.querySelector('#vault-list');
  const render = async () => {
    let items;
    try {
      items = await api('/api/vault/items');
    } catch {
      list.innerHTML = '<p class="form-error">Couldn\'t load the vault.</p>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<p class="muted">No secrets stored. When the agent needs a credential, it will offer you a secure form right in the chat.</p>';
      return;
    }
    list.innerHTML = items.map((i) => {
      const when = i.created_at ? new Date(i.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      let fieldNames = '';
      try {
        const f = i.fields ? JSON.parse(i.fields) : null;
        if (Array.isArray(f) && f.length) fieldNames = f.map((x) => x.label || x.name).join(', ');
      } catch { /* ignore */ }
      return `
      <div class="shared-row">
        <div class="shared-info">
          <div class="shared-title"><span aria-hidden="true">🔒</span> ${esc(i.label || 'Secret')}</div>
          ${when || fieldNames ? `<div class="shared-meta">${[fieldNames ? esc(fieldNames) : '', when ? `Added ${esc(when)}` : ''].filter(Boolean).join(' · ')}</div>` : ''}
        </div>
        <div class="shared-actions">
          <button type="button" class="btn danger-ghost" data-vault-del="${esc(i.id)}" data-vault-label="${esc(i.label || 'Secret')}">Delete</button>
        </div>
      </div>`;
    }).join('');
  };
  list.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-vault-del]');
    if (!delBtn) return;
    const ok = await confirmDialog({
      title: 'Delete secret?',
      message: `Remove "${delBtn.dataset.vaultLabel}" from the vault? The agent will no longer be able to use it. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    delBtn.disabled = true;
    try {
      await api(`/api/vault/items/${encodeURIComponent(delBtn.dataset.vaultDel)}`, { method: 'DELETE' });
      toast('Secret deleted');
      await render();
    } catch (ex) {
      toast(ex.message || 'Delete failed', 'error');
      delBtn.disabled = false;
    }
  });
  await render();
}

async function switchConversation(id) {
  if (id === S.activeId) { closeSidebarDrawer(); return; }
  if (S.switching) return;
  S.switching = true;
  saveDraft();
  closeConvMenu();
  closeSidebarDrawer();
  try {
    const data = await api(`/api/conversations/${id}`);
    closeEventStream();
    S.activeId = id;
    try { localStorage.setItem('orion-active-chat', String(id)); } catch {}
    // Seed the Stop-button state synchronously from the just-fetched
    // conversation — fresher than the runByConv cache, which may predate a
    // run that started while this client was away. The SSE hello that
    // follows corrects it if the server disagrees.
    S.runActive = !!data.running;
    if (data.running) S.runByConv[id] = true;
    else delete S.runByConv[id];
    setMessages(data);
    S.activeArchived = !!data.conversation?.archived;
    paintArchivedState();
    S.lastSeenAt[id] = Date.now();
    // Opening the chat dismisses its "run finished" check.
    if (S.doneByConv[id]) { delete S.doneByConv[id]; saveDoneFlags(); }
    renderSidebar();
    renderMessages();
    loadTurns();
    openEventStream(id);
    // Clear the composer before restoring this chat's draft — otherwise a
    // chat with no draft inherits the previous chat's text. Also re-render
    // the attach tray: staged uploads are per conversation.
    const composerInput = $('#composer-input');
    composerInput.value = '';
    composerInput.style.height = 'auto';
    renderAttachTray();
    restoreDraft();
    updateComposer();
  } catch (ex) {
    toast(ex.message || 'Could not open chat', 'error');
  } finally {
    S.switching = false;
  }
}

async function newChat() {
  try {
    const conv = await api('/api/conversations', { method: 'POST', body: {} });
    await loadConversationsQuiet();
    await switchConversation(conv.id);
    $('#composer-input')?.focus();
  } catch (ex) { toast(ex.message || 'Could not create chat', 'error'); }
}

function openSidebarDrawer() {
  $('#sidebar')?.classList.add('open');
  const b = $('#side-backdrop');
  if (b) b.hidden = false;
  // The list is the thing the user is about to look at — pull the live
  // server state so a delete/rename/archive from another device can't sit
  // stale in the drawer (the in-memory list may have missed its SSE event
  // while this tab was backgrounded).
  if (S.me) loadConversationsQuiet();
}
function closeSidebarDrawer(silent) {
  const sb = $('#sidebar');
  if (sb) { sb.classList.remove('open'); sb.style.transform = ''; }
  const b = $('#side-backdrop');
  if (b) b.hidden = true;
  // Mobile: plant a history entry so the system back button / iOS
  // swipe-back gesture reopens the drawer instead of leaving the app.
  if (!silent && window.matchMedia('(max-width: 760px)').matches) {
    try {
      if (!history.state || history.state.d !== 1) history.pushState({ d: 1 }, '');
    } catch {}
  }
}
/* Mobile: back button / swipe-back toggles the drawer. */
function wireDrawerBackButton() {
  if (wireDrawerBackButton.done) return;
  wireDrawerBackButton.done = true;
  window.addEventListener('popstate', () => {
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    const open = $('#sidebar')?.classList.contains('open');
    if (open) closeSidebarDrawer(true);
    else {
      openSidebarDrawer();
      try { history.pushState({ d: 0 }, ''); } catch {}
    }
  });
}
/* Mobile: swipe the drawer away. A horizontal drag left on the open drawer
   follows the finger; releasing past 25% dismisses it. Touch events (not
   pointer capture) so taps and vertical scrolling keep working. */
function wireSidebarSwipe() {
  const sb = $('#sidebar');
  if (!sb || sb.dataset.swipeWired) return;
  sb.dataset.swipeWired = '1';
  let startX = 0, startY = 0, dx = 0, active = false, horizontal = false;
  sb.addEventListener('touchstart', (e) => {
    if (!sb.classList.contains('open') || !window.matchMedia('(max-width: 760px)').matches) return;
    if (e.touches.length !== 1) return;
    active = true; horizontal = false; dx = 0;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
  }, { passive: true });
  sb.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0];
    dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (!horizontal && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      horizontal = true;
      sb.style.transition = 'none';
    }
    if (horizontal) {
      sb.style.transform = `translateX(${Math.min(0, dx)}px)`;
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false;
    sb.style.transition = '';
    const w = sb.getBoundingClientRect().width || 272;
    if (horizontal && dx < -w * 0.25) closeSidebarDrawer();
    else sb.style.transform = '';
  };
  sb.addEventListener('touchend', end, { passive: true });
  sb.addEventListener('touchcancel', end, { passive: true });
}

let sidebarWired = false;
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  try { localStorage.setItem('orion-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
}

function wireSidebarOnce() {
  if (sidebarWired) return;
  sidebarWired = true;
  $('#new-chat-btn')?.addEventListener('click', newChat);
  $('#search-btn')?.addEventListener('click', openSearch);
  wireSearchOnce();
  wireArchiveOnce();
  $('#menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.matchMedia('(max-width: 760px)').matches) openSidebarDrawer();
    else setSidebarCollapsed(!document.body.classList.contains('side-collapsed'));
  });
  $('#compose-btn')?.addEventListener('click', newChat);
  $('#side-backdrop')?.addEventListener('click', () => closeSidebarDrawer());
  wireSidebarSwipe();
  wireDrawerBackButton();
  try {
    if (localStorage.getItem('orion-sidebar-collapsed') === '1') {
      document.body.classList.add('side-collapsed');
    }
  } catch {}
  document.addEventListener('visibilitychange', () => {
    if (!S.me) return;
    if (document.hidden) {
      // Backgrounded: drop the event stream so the server stops counting
      // this tab as "watching" the conversation. Run-end pushes are
      // suppressed while any subscriber is attached — without this, swiping
      // away leaves the stream open and the ping never fires.
      closeEventStream();
      return;
    }
    S.lastSyncAt = Date.now();
    loadConversationsQuiet();
    syncThemeFromServer(); // pick up a theme change made on another device
    // The per-user stream (conversation_deleted, conversations_changed,
    // usage_updated) can die silently while backgrounded — mobile OSes kill
    // idle sockets with no error event, and EventSource won't always
    // resurrect itself. Without it, deletes from another device never
    // arrive until a manual refresh.
    if (!S.userEvt || S.userEvt.readyState === EventSource.CLOSED) openUserEventStream();
    // A tab backgrounded long enough can have its SSE stream die silently
    // (no error event, no heartbeat): re-establish it and restore the
    // Stop button / run state from the server.
    if (S.activeId && (!S.evt || S.evt.readyState === EventSource.CLOSED)) {
      refreshAfterReconnect(S.activeId);
    }
  });
  // bfcache restores don't always fire visibilitychange — re-sync on
  // pageshow too, so a restored tab can't show a deleted chat.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted || !S.me || document.hidden) return;
    if (Date.now() - (S.lastSyncAt || 0) < 5000) return;
    S.lastSyncAt = Date.now();
    loadConversationsQuiet();
    if (!S.userEvt || S.userEvt.readyState === EventSource.CLOSED) openUserEventStream();
  });
  // Desktop: alt-tabbing between apps doesn't hide the tab, so
  // visibilitychange never fires — re-sync the list when the window
  // regains focus, unless the visibility handler just did it.
  window.addEventListener('focus', () => {
    if (!S.me || document.hidden) return;
    if (Date.now() - (S.lastSyncAt || 0) < 5000) return;
    S.lastSyncAt = Date.now();
    loadConversationsQuiet();
    syncThemeFromServer();
  });
}

/* ---------- chat view entry ---------- */
let chatWired = false;
async function renderChat() {
  renderUserChip();
  if (!chatWired) { wireChat(); chatWired = true; }
  wireUserMenuOnce();
  wireSidebarOnce();
  // Open the most recent chat. If none exists, land on the empty state —
  // the chat is created lazily on first send, so merely loading the page
  // never mints a database row.
  if (!S.activeId) {
    const box = $('#messages');
    box.innerHTML = '<div class="skel" style="max-width:60%;"></div><div class="skel" style="max-width:80%;margin-left:auto"></div>';
    box.hidden = false;
    $('#empty-state').hidden = true;
    try {
      const list = await api('/api/conversations');
      if (list.length) {
        let openId = list[0].id;
        try {
          const saved = localStorage.getItem('orion-active-chat');
          if (saved && list.some((c) => String(c.id) === saved)) openId = Number(saved);
        } catch {}
        const data = await api(`/api/conversations/${openId}`);
        S.activeId = openId;
        setMessages(data);
        S.activeArchived = !!data.conversation?.archived;
        paintArchivedState();
        // Seed both flags from the fresh payload: update notes rendered
        // below need S.runActive for their live-run marker, and the fold
        // pass must skip the in-flight run. The SSE hello corrects it
        // moments later if the server disagrees.
        if (data.running) { S.runActive = true; S.runByConv[S.activeId] = true; }
      } else {
        S.activeId = null;
        S.activeArchived = false;
        paintArchivedState();
        setMessages({ messages: [], hasMoreOlder: false });
      }
    } catch {
      box.innerHTML = `<div class="conv-empty">Couldn't load the chat.</div>`;
      return;
    }
  }
  if (S.activeId) S.lastSeenAt[S.activeId] = Date.now();
  restoreDraft();
  await loadConversationsQuiet();
  renderMessages();
  loadTurns();
  // Late layout (webfonts, images without known dimensions) can grow the
  // scrollable area after the initial jump — re-pin once it settles, as
  // long as the user hasn't scrolled up on their own in the meantime.
  // (Image loads are covered separately by the capture-phase listener in
  // wireJumpPill.)
  requestAnimationFrame(() => requestAnimationFrame(() => { if (S.stick) jumpToBottom(); }));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.stick) jumpToBottom(); }, () => {});
  if (S.activeId) openEventStream(S.activeId);
  updateComposer();
}

let userMenuWired = false;
function wireUserMenuOnce() { if (!userMenuWired) { wireUserMenu(); userMenuWired = true; } }

/* ============================================================
   Composer + live event stream
   The client holds a long-lived EventSource on
   /api/conversations/:id/events and POSTs messages as plain JSON.
   The server inserts the row, detaches a background agent run, and
   publishes run_started / token / tool / image / message / run_ended
   frames on the per-conversation bus. Sending while a run is active
   is fine — the message is queued and the run chains a follow-up.
   ============================================================ */
function wireChat() {
  const input = $('#composer-input');

  // Persist the draft per conversation, so a tab reload (e.g. the
  // auto-reload after a deploy) never eats what the user was typing,
  // and switching chats keeps each draft separate.
  S.clearComposerDraft = () => clearDraft();

  // Auto-grow, Enter to send.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    updateComposer();
    saveDraft();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    // While a run is active the send button has morphed into the stop
    // button — clicking it stops the run. Enter still queues a message,
    // and the queue button beside it queues without stopping.
    hConfirm();
    if (S.runActive) stopStream();
    else sendMessage();
  });
  // Queue button: visible only mid-run when there's something to send.
  // Queues the message without touching the in-flight run.
  $('#queue-btn').addEventListener('click', () => { hConfirm(); sendMessage(); });

  // Draft restore happens in renderChat, once the conversation id is known.
  updateComposer();
}

// Composer drafts live in sessionStorage, keyed per conversation.
function draftKey() { return 'orion-composer-draft-' + (S.activeId || 'none'); }
function saveDraft() {
  try { sessionStorage.setItem(draftKey(), $('#composer-input').value); } catch {}
}
function clearDraft() {
  try { sessionStorage.removeItem(draftKey()); } catch {}
}
function restoreDraft() {
  try {
    const d = sessionStorage.getItem(draftKey());
    if (d) {
      const input = $('#composer-input');
      input.value = d;
      input.dispatchEvent(new Event('input'));
    }
  } catch {}
}

function updateComposer() {
  const input = $('#composer-input');
  const hasText = input.value.trim().length > 0;
  const uploading = pendingUploads().some((p) => p.uploading);
  const hasFiles = pendingUploads().some((p) => !p.uploading && p.id != null);
  // While a run is active the single composer button morphs into the stop
  // button (Enter still queues a message mid-run). When there's text to
  // send, a second queue button appears beside it so the message can be
  // sent without stopping the run — the server holds it queued and chains
  // a follow-up when the in-flight run finishes.
  const btn = $('#send-btn');
  const qbtn = $('#queue-btn');
  if (S.runActive) {
    btn.classList.add('is-stop');
    btn.setAttribute('aria-label', 'Stop');
    btn.disabled = false;
    qbtn.hidden = !(hasText || hasFiles);
    qbtn.disabled = uploading;
  } else {
    btn.classList.remove('is-stop');
    btn.setAttribute('aria-label', 'Send');
    btn.disabled = uploading || (!hasText && !hasFiles);
    qbtn.hidden = true;
  }
}

async function sendMessage() {
  const input = $('#composer-input');
  const content = input.value.trim();
  // Staged files live on the active conversation's list — capture both the
  // list key and the staged files before any await, so the send-time chat
  // creation (which changes S.activeId) can't clear or claim the wrong list.
  const stagedKey = S.activeId || 'none';
  const uploadList = pendingUploads();
  const staged = uploadList.filter((p) => !p.uploading && p.id != null);
  if (uploadList.some((p) => p.uploading)) return; // wait for uploads
  if (!content && !staged.length) return;

  // Capture the target chat before any await. If the user switches chats
  // mid-flight, bail out rather than posting into the wrong chat.
  let convId = S.activeId;
  // Ensure a chat exists before posting into it: the first message
  // creates it (nothing is auto-created on page load).
  if (!convId) {
    try {
      const conv = await api('/api/conversations', { method: 'POST', body: {} });
      const data = await api(`/api/conversations/${conv.id}`);
      if (S.activeId && S.activeId !== conv.id) { toast('Switched chats — message not sent', 'error'); return; }
      convId = conv.id;
      S.activeId = conv.id;
      setMessages(data);
      renderMessages();
      openEventStream(S.activeId);
      await loadConversationsQuiet();
    } catch (e) { toast(e.message, 'error'); return; }
  }
  if (S.activeId !== convId) { toast('Switched chats — message not sent', 'error'); return; }

  const replyTo = S.replyTo;
  clearReply();
  input.value = '';
  input.style.height = 'auto';
  if (S.clearComposerDraft) S.clearComposerDraft();
  try { sessionStorage.removeItem('orion-composer-draft-none'); } catch {} // drafts typed before any chat existed
  S.pendingByConv[stagedKey] = [];
  renderAttachTray();
  updateComposer();

  // Optimistic bubble, reconciled with the real row id below. The server
  // also publishes the row on the bus, which can arrive before the POST
  // response — upsertMessage dedupes by id either way.
  const local = appendUserMessage(content, staged.map((p) => ({ filename: p.filename, url: p.url })), replyTo);

  let resp;
  try {
    resp = await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: { content, attachment_ids: staged.map((p) => p.id), reply_to: replyTo?.id || null },
    });
  } catch (e) {
    // If the bus already reconciled this message, the server did persist
    // it — don't remove it or resurrect the draft as if it never sent.
    if (!local._reconciled) {
      removeMessage(local);
      if (replyTo) { S.replyTo = replyTo; renderReplyBar(); } // restore the quote
      input.value = content; // restore the draft
      S.pendingByConv[stagedKey] = staged; // keep the files staged so they can resend
      renderAttachTray();
      updateComposer();
    }
    toast(e.message || 'Send failed', 'error');
    return;
  }
  reconcileLocal(local, resp.message);
  markSeen();
  updateComposer();
  scrollBottom(true);
}

// Server-side stop: the run keeps its partial text with a "(stopped by
// user)" note; run_ended {status:'stopped'} arrives on the bus and clears
// the run UI.
async function stopStream() {
  if (!S.activeId || !S.runActive) return;
  try {
    const d = await api(`/api/conversations/${S.activeId}/stop`, { method: 'POST' });
    // The server had nothing running (e.g. the run died with a deploy):
    // no run_ended will ever arrive, so clear the stuck stop button now.
    if (d && d.stopped === false) setRunActive(false);
  } catch (e) {
    toast(e.message || 'Stop failed', 'error');
  }
}

/* ---------- live event bus ---------- */

function msgElById(id) {
  const box = $('#messages');
  const sel = `[data-mid="${CSS.escape(String(id))}"]`;
  // Prefer the visible direct child — a nested copy inside a collapsed work
  // log is hidden, and scrollIntoView on it goes nowhere.
  return box.querySelector(':scope > ' + sel) || box.querySelector(sel);
}

function removeMessage(m) {
  S.messages = S.messages.filter((x) => x !== m);
  msgElById(m.id)?.remove();
  S.liveIds.delete(m.id);
  S.buffers.delete(m.id);
  S.toolRows.delete(m.id);
}

// Swap an optimistic local id for the real row id, or drop the local copy
// if the bus already delivered the row (dedupes either arrival order).
function reconcileLocal(local, real) {
  // NOTE: exclude `local` itself — when the bus wins the race, this local
  // already carries the real id, and without the exclusion we'd delete the
  // user's own message from the DOM.
  if (S.messages.some((x) => x !== local && x.id === real.id)) { removeMessage(local); return; }
  const el = msgElById(local.id);
  local.id = real.id;
  local.content = real.content;
  local.created_at = real.created_at;
  if (real.attachments) local.attachments = real.attachments;
  if (el) el.dataset.mid = String(real.id);
}

function paintContent(msg) {
  const contentEl = msgElById(msg.id)?.querySelector('.content');
  if (contentEl) contentEl.innerHTML = md(msg.content || '');
}

function setRunActive(on) {
  S.runActive = on;
  if (S.activeId) {
    if (on) S.runByConv[S.activeId] = true;
    else delete S.runByConv[S.activeId];
  }
  if (!on) {
    hideRunStatus(); // the single live status line never survives a run
    // The run's progress notes are done being live: fold them into the
    // work log so the final answer stands alone.
    document.querySelectorAll('#messages .msg.update[data-live-run]')
      .forEach((el) => el.removeAttribute('data-live-run'));
    // Clear live markers BEFORE the run-end fold: the run is over, so the
    // fold's live-row bail (which protects in-flight chatter from being
    // tucked into a work log mid-run) must not fire here — otherwise the
    // just-finished run's paras are left loose and no work log forms until
    // some later re-render.
    S.liveIds.clear();
    finalizeLiveWorkLog(); // collapse the live tray (its rows are already inside)
    collapseWorkLogs();
    // Folding shifts the layout — if pinned, land exactly on the final answer.
    if (S.stick) jumpToBottom();
    // The streaming caret never survives a run either — it may sit on a
    // nested paragraph, not just .content, so clear it everywhere.
    document.querySelectorAll('#messages .caret').forEach((el) => el.classList.remove('caret'));
    loadConversationsQuiet(); // pick up the server-side title
  } else {
    showRunStatus('Working…'); // refined by the first tool event
  }
  renderSidebar();
  updateComposer();
}

function parseBusEvent(e) {
  try { return JSON.parse(e.data); } catch { return null; }
}

function openEventStream(convId) {
  closeEventStream();
  const es = new EventSource(`/api/conversations/${convId}/events`);
  S.evt = es;

  es.addEventListener('hello', (e) => {
    S.evtRetry = 0;
    let running = false;
    try { running = !!JSON.parse(e.data).running; } catch {}
    setRunActive(running);
  });
  es.addEventListener('run_started', () => setRunActive(true));
  es.addEventListener('run_ended', () => { setRunActive(false); refreshUsage(); });
  es.addEventListener('title', (e) => {
    const d = parseBusEvent(e);
    if (!d || !d.title) return;
    const c = (S.conversations || []).find((x) => x.id === S.activeId);
    if (c) { c.title = d.title; renderSidebar(); }
    else loadConversationsQuiet();
  });
  es.addEventListener('chat_cleared', () => clearChatState()); // another client reset the chat
  es.addEventListener('reaction', (e) => {
    const d = parseBusEvent(e);
    if (d && d.message_id != null) applyReactions(d.message_id, d.reactions || []);
  });
  es.addEventListener('message', (e) => onBusMessage(parseBusEvent(e)?.message));
  es.addEventListener('vault', (e) => onVaultEvent(parseBusEvent(e)));
  es.addEventListener('token', (e) => onBusToken(parseBusEvent(e)));
  es.addEventListener('tool', (e) => onBusTool(parseBusEvent(e)));
  es.addEventListener('image', (e) => onBusImage(parseBusEvent(e)));
  es.addEventListener('file', (e) => onBusFile(parseBusEvent(e)));
  es.addEventListener('queued', () => { /* ordinary bubble already shown */ });
  es.addEventListener('error', (e) => {
    // Named SSE 'error' frames from the server (agent failure) arrive as
    // MessageEvents; transport failures are plain Events (handled below).
    if (!(e instanceof MessageEvent)) return;
    const d = parseBusEvent(e);
    if (d && d.message !== undefined) toast('Agent error: ' + d.message, 'error');
  });

  es.onerror = () => {
    // Transport failure — reconnect with backoff (2s, 4s, 8s … capped at
    // 30s), then re-fetch full history to converge on what's stored.
    try { es.close(); } catch {}
    if (S.evt !== es) return;
    S.evt = null;
    const delay = Math.min(30000, 2000 * Math.pow(2, S.evtRetry++));
    setTimeout(() => {
      if (S.evt || !S.activeId || !S.me) return;
      refreshAfterReconnect(convId);
    }, delay);
  };
}

// Per-user event stream: live usage updates when an admin changes our
// limit or resets our usage. Opened once per login, closed on logout.
function openUserEventStream() {
  closeUserEventStream();
  const es = new EventSource('/api/user/events');
  S.userEvt = es;
  es.addEventListener('usage_updated', () => { refreshUsage(); renderUsageCard(); });
  es.addEventListener('conversation_deleted', (e) => {
    const d = parseBusEvent(e);
    if (d && d.conversation_id != null) onConversationDeleted(d.conversation_id);
  });
  es.addEventListener('conversations_changed', () => scheduleConvRefresh()); // created/renamed/messaged/run toggled elsewhere
  // Safety net: even if an event was missed (dropped SSE, slept-through
  // reconnect), the list converges on its own within a minute.
  S.userEvtPoll = setInterval(() => { loadConversationsQuiet(); }, 45000);
  es.onerror = () => {
    // EventSource auto-reconnects; if the session died the next api() call
    // surfaces it and the normal logout path closes this stream.
  };
}
function closeUserEventStream() {
  if (S.userEvt) { try { S.userEvt.close(); } catch {} S.userEvt = null; }
  if (S.userEvtPoll) { clearInterval(S.userEvtPoll); S.userEvtPoll = null; }
}

// Cross-device list sync arrives as small bursts (message + run_started, or
// a reset wiping N chats) — coalesce them into one quiet refresh.
let convRefreshTimer = null;
function scheduleConvRefresh() {
  if (convRefreshTimer) return;
  convRefreshTimer = setTimeout(() => {
    convRefreshTimer = null;
    loadConversationsQuiet();
  }, 600);
}

// A chat was deleted — on this device or another one. Drop it from the
// sidebar immediately so there's no stale row that 404s when opened. If it
// was the open chat, fall through to the next one (or the empty state),
// mirroring the local delete flow.
async function onConversationDeleted(rawId) {
  const id = Number(rawId);
  // Our own delete echoes back on this same channel — don't announce it as
  // if it came from elsewhere. (Entries are timestamped and pruned here;
  // SQLite can reuse a deleted id for a future chat, so stale entries must
  // never suppress a real later event.)
  const self = S.selfDeletedAt[id] && Date.now() - S.selfDeletedAt[id] < 30000;
  delete S.selfDeletedAt[id];
  const wasListed = (S.conversations || []).some((c) => Number(c.id) === id);
  S.conversations = (S.conversations || []).filter((c) => Number(c.id) !== id);
  delete S.runByConv[id];
  if (S.doneByConv[id]) { delete S.doneByConv[id]; saveDoneFlags(); }
  delete S.lastSeenAt[id];
  delete S.pendingByConv[id];
  if (wasListed) renderSidebar();
  if (Number(S.activeId) === id) {
    closeEventStream();
    setRunActive(false); // no stream left to deliver run_ended; clear Stop now
    S.activeId = null;
    try { localStorage.removeItem('orion-active-chat'); } catch {}
    const next = S.conversations[0];
    try {
      if (next) await switchConversation(next.id);
      else {
        setMessages({ messages: [], hasMoreOlder: false });
        S.activeArchived = false;
        paintArchivedState();
        renderMessages();
        renderAttachTray();
        updateComposer();
        S.turns = []; renderTurnRail(); // clear the turn rail for the empty state
      }
    } catch {}
    if (!self) toast('Chat deleted in another tab');
  }
}
function closeEventStream() {
  if (S.evt) { try { S.evt.close(); } catch {} S.evt = null; }
  S.liveIds.clear();
  S.buffers.clear();
  S.toolRows.clear();
}

async function refreshAfterReconnect(convId) {
  if (S.activeId !== convId) return;
  openEventStream(convId); // re-subscribe first, so nothing after this point is missed
  try {
    const data = await api(`/api/conversations/${convId}`);
    if (!data || S.activeId !== convId) return;
    setMessages(data);
    // The stream was down: a run may have started or ended while away, and
    // the hello event re-deriving live state hasn't arrived yet. Seed the
    // run flags from the server BEFORE rendering, or collapseWorkLogs()
    // folds a live run's steps into a work log — and the real run end then
    // folds them a second time.
    S.runActive = !!data.running;
    if (data.running) S.runByConv[convId] = true;
    else delete S.runByConv[convId];
    S.buffers.clear();
    S.toolRows.clear();
    renderMessages(); // live state re-derives from hello + subsequent events
  } catch { /* the next backoff tick retries */ }
}

// A vault secret was saved through the secure form: flip the widget card
// to its saved state and keep the local message copy in sync.
// Vault iframes report their content height so the widget never needs an
// inner scrollbar. Same-origin only, and the source must be a live vault
// frame; the height is clamped so a misbehaving frame can't blow out layout.
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const d = event.data;
  if (!d || d.type !== 'orion-vault-form-height' || typeof d.height !== 'number' || !(d.height > 0)) return;
  const frames = document.querySelectorAll('iframe.vault-frame');
  for (const f of frames) {
    if (f.contentWindow === event.source) {
      f.style.height = Math.max(140, Math.min(640, Math.round(d.height))) + 'px';
      break;
    }
  }
});
function onVaultEvent(d) {
  if (!d || !d.request_id) return;
  const safeId = CSS.escape(String(d.request_id));
  const wrapEl = document.querySelector(`[data-vault-request="${safeId}"]`);
  if (wrapEl) {
    const body = wrapEl.querySelector('.vault-body');
    if (body) body.innerHTML = '<div class="vault-done">Saved to your vault ✓</div>';
  }
  const msg = S.messages.find((x) => {
    if (x.kind !== 'vault_request') return false;
    try { return JSON.parse(x.content || '{}').vault_request_id === d.request_id; }
    catch { return false; }
  });
  if (msg) {
    try {
      const v = JSON.parse(msg.content || '{}');
      v.status = 'fulfilled';
      msg.content = JSON.stringify(v);
    } catch { /* cosmetic only */ }
  }
  toast(d.label ? `“${d.label}” saved to vault` : 'Secret saved to vault');
}

function onBusMessage(m) {  if (!m || m.id == null || S.activeId == null) return;
  markSeen();
  // A user message is a new turn — keep the rail in sync live.
  if (m.role === 'user' && !S.turns.some((t) => t.id === m.id)) {
    S.turns.push({ id: m.id, snippet: (m.content || '').slice(0, 80) });
    renderTurnRail();
  }
  let added = false;
  let msg = S.messages.find((x) => x.id === m.id);
  if (!msg) {
    // Optimistic local user bubble? Reconcile instead of duplicating.
    const local = S.messages.find((x) =>
      String(x.id).startsWith('local-') && !x._reconciled &&
      x.role === m.role && x.content === m.content);
    if (local) {
      local._reconciled = true;
      reconcileLocal(local, m);
      return;
    }
    msg = { id: m.id, role: m.role, content: m.content || '', kind: m.kind || 'message', run_start: m.run_start || 0, attachments: m.attachments || [], reactions: m.reactions || [], reply_to: m.reply_to || null, reply_to_message: m.reply_to_message || null };
    S.messages.push(msg);
    const el = messageEl(msg);
    $('#messages').appendChild(el);
    trimRenderedTop();
    $('#messages').hidden = false;
    $('#empty-state').hidden = true;
    added = true;
  } else if (msg.role === 'assistant' && typeof m.content === 'string') {
    // Authoritative full-row republish (covers onNote appends the token
    // stream never carried: stuck guard, time cap, empty-stall fallback).
    const buf = S.buffers.get(msg.id) || '';
    const live = S.liveIds.has(msg.id);
    // Accept when it isn't older than what we've already streamed — or when
    // a hidden empty placeholder finally has content (e.g. the stall
    // fallback, which streamed no tokens at all, so the row was never live).
    if ((live && m.content.length >= buf.length) || (!live && !msg.content && m.content)) {
      S.buffers.set(msg.id, m.content);
      msg.content = m.content;
      if (m.run_start && !msg.run_start) {
        msg.run_start = 1;
        msgElById(msg.id)?.setAttribute('data-run-start', '1');
      }
      if (m.content) msgElById(msg.id)?.classList.remove('msg-empty');
      paintContent(msg);
    }
  }
  if (added) {
    noteNewMessage();
  } else keepPlace();
  // A new row may demote the previous text row to intermediate — sweep the
  // in-flight run's chatter into the live work log tray.
  if (S.runActive) foldLiveWorkLog();
}

// Paint one streaming token batch. The markdown renderer must never freeze a
// live stream: on any unexpected failure, fall back to plain text so the words
// keep flowing.
function paintTokenContent(contentEl, buf) {
  try {
    contentEl.innerHTML = md(buf);
  } catch (err) {
    console.warn('[stream] md() threw, using plaintext fallback', err);
    contentEl.textContent = buf;
  }
}

function onBusToken(d) {
  if (!d || d.message_id == null) return;
  markSeen();
  // The run is now visibly producing text — the status line yields to it.
  // (The next tool-start event re-shows it if the run goes back to tools.)
  hideRunStatus();
  const msg = S.messages.find((x) => x.id === d.message_id);
  if (!msg) return;
  let buf = S.buffers.get(d.message_id);
  if (buf === undefined) buf = msg.content || ''; // e.g. joined mid-run
  buf += d.token || '';
  S.buffers.set(d.message_id, buf);
  msg.content = buf;
  S.liveIds.add(d.message_id);
  // The turn has real text now: unhide its placeholder row if it was hidden.
  // A row becoming visible mid-run demotes the previous text row to
  // intermediate — sweep it into the live work log.
  if (buf) {
    const rowEl = msgElById(d.message_id);
    if (rowEl && rowEl.classList.contains('msg-empty')) {
      rowEl.classList.remove('msg-empty');
      foldLiveWorkLog();
    }
  }
  let paintEl = msgElById(d.message_id)?.querySelector('.content');
  if (!paintEl) {
    // The row isn't in the DOM (trimmed, folded, or never rendered) — resurrect
    // it instead of silently dropping tokens. A stream that stops painting
    // mid-response looks broken even though the data is intact.
    const fresh = messageEl(msg);
    $('#messages').appendChild(fresh);
    trimRenderedTop();
    paintEl = fresh.querySelector('.content');
    if (!paintEl) return;
  }
  paintTokenContent(paintEl, buf);
  // Exactly one caret: it marks the end of the currently streaming text,
  // sitting after the last word rather than on a line of its own.
  document.querySelectorAll('#messages .caret').forEach((el) => el.classList.remove('caret'));
  const last = paintEl.lastElementChild;
  (last && last.tagName === 'P' ? last : paintEl).classList.add('caret');
  keepPlace();
}

// One quiet status line for the whole in-flight run: a general phrase
// about what the run is doing, updated in place. A run spans many model
// turns and the server creates one assistant message per turn, so the line
// lives outside any single message — it can never multiply. Hidden when
// the run ends (see setRunActive).
const TOOL_STATUS_PHRASES = {
  exec: 'Running a command…',
  read_file: 'Reading files…',
  write_file: 'Writing files…',
  list_files: 'Looking through files…',
  web_fetch: 'Reading a web page…',
  browser_shot: 'Looking at a web page…',
  delegate: 'Working on a subtask…',
  react_to_message: 'Reacting…',
  vault_request: 'Preparing a secure form…',
  vault_list: 'Checking the vault…',
  vault_delete: 'Updating the vault…',
  schedule_task: 'Scheduling…',
  list_tasks: 'Checking scheduled tasks…',
  update_task: 'Updating a scheduled task…',
  delete_task: 'Removing a scheduled task…',
};
function showRunStatus(text) {
  const box = $('#messages');
  if (!box) return;
  let el = $('#run-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'run-status';
    el.innerHTML = '<span class="dot running"></span><span class="ttext"></span>';
  }
  el.querySelector('.ttext').textContent = text;
  box.appendChild(el); // (re-)append: always last, never splitting the message group
  keepPlace();
}
function hideRunStatus() {
  document.getElementById('run-status')?.remove();
}

function onBusTool(d) {
  if (!d || d.status !== 'start') return;
  if (d.name === 'send_update') return; // the agent's own update line; no redundant status
  // The server sends a natural-language activity line ("Searching files…");
  // fall back to the generic per-tool phrase for older servers.
  showRunStatus(d.summary || TOOL_STATUS_PHRASES[d.name] || 'Working…');
}

function onBusImage(d) {
  if (!d || !d.url || d.message_id == null) return;
  const el = msgElById(d.message_id);
  const imgsEl = el?.querySelector('.imgs');
  if (!imgsEl) return;
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = d.url;
  img.alt = d.filename || 'image';
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(d.url));
  imgsEl.appendChild(img);
  // The image may arrive on a tool-only turn whose row was hidden as an
  // empty placeholder — unhide it, like the token handler does for text.
  el.classList.remove('msg-empty');
  const msg = S.messages.find((x) => x.id === d.message_id);
  if (msg) (msg.attachments = msg.attachments || []).push({ url: d.url, filename: d.filename });
  keepPlace();
}

// A file the agent sent with send_file: append a download chip to the
// in-flight assistant row, mirroring onBusImage.
function onBusFile(d) {
  if (!d || !d.url || d.message_id == null) return;
  const el = msgElById(d.message_id);
  const imgsEl = el?.querySelector('.imgs');
  if (!imgsEl) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = attachmentHtml({ url: d.url, filename: d.filename || 'file' });
  const chip = tmp.firstElementChild;
  if (chip) imgsEl.appendChild(chip);
  el.classList.remove('msg-empty');
  const msg = S.messages.find((x) => x.id === d.message_id);
  if (msg) (msg.attachments = msg.attachments || []).push({ url: d.url, filename: d.filename });
  keepPlace();
}

/* ============================================================
   Admin view — provider settings + user management.
   Admin-only; render() already guards the route.
   ============================================================ */
async function renderAdmin() {
  await Promise.all([loadProviderSettings(), loadAdminUsers(), loadPendingRequests()]);
  wireProviderFormOnce();
  wireLimitsFormOnce();
  wireAdminTabsOnce();
}

/* Admin tabs: provider / limits / users each get their own page. */
let adminTabsWired = false;
function wireAdminTabsOnce() {
  if (adminTabsWired) return;
  adminTabsWired = true;
  const tabs = document.querySelectorAll('#admin-tabs .auth-tab');
  const cards = {
    provider: $('#admin-card-provider'),
    limits: $('#admin-card-limits'),
    users: $('#admin-card-users'),
    pending: $('#admin-card-pending'),
  };
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.atab;
      tabs.forEach(b => b.classList.toggle('active', b === btn));
      Object.entries(cards).forEach(([k, card]) => { card.hidden = k !== key; });
      // Each list tab reloads on open, so actions taken in one tab
      // (e.g. approving a signup) show up in the others without a refresh.
      if (key === 'users') loadAdminUsers();
      else if (key === 'pending') loadPendingRequests();
    });
  });
}

async function loadProviderSettings() {
  try {
    S.adminSettings = await api('/api/admin/settings');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const s = S.adminSettings;
  $('#set-provider').value = s.provider_name || '';
  $('#set-baseurl').value = s.base_url || '';
  $('#set-model').value = s.model || '';
  $('#set-key').value = '';
  // "Saved ✓" behavior: placeholder shows a key exists; only a typed value is sent.
  $('#set-key').placeholder = s.has_key ? 'Saved ✓ — leave blank to keep' : 'Not set';
  // signup_enabled arrives as the string '1'/'0' — !!'0' is true, so compare explicitly.
  $('#set-signup').checked = s.signup_enabled === '1' || s.signup_enabled === true;
  // Approval only makes sense with signups enabled.
  $('#set-signup-approval').checked = s.signup_approval_required === '1' || s.signup_approval_required === true;
  $('#set-signup-approval').disabled = !$('#set-signup').checked;
  wireSignupApprovalToggleOnce();
  // Limits & captcha card. The default allowance shows in shorthand ("1M"),
  // matching the per-user limit box.
  $('#set-default-limit').value = formatTokenLimit(s.default_weekly_token_limit);
  $('#set-turnstile-site').value = s.turnstile_site_key || '';
  $('#set-turnstile-secret').value = '';
  $('#set-turnstile-secret').placeholder = s.has_turnstile_secret ? 'Saved ✓ — leave blank to keep' : 'Not set';
}

let signupApprovalWired = false;
function wireSignupApprovalToggleOnce() {
  if (signupApprovalWired) return;
  signupApprovalWired = true;
  $('#set-signup').addEventListener('change', (e) => {
    $('#set-signup-approval').disabled = !e.target.checked;
  });
}

let limitsWired = false;
function wireLimitsFormOnce() {
  if (limitsWired) return;
  limitsWired = true;
  $('#limits-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#limits-save');
    const saved = $('#limits-saved');
    btn.disabled = true;
    saved.hidden = true;
    const secret = $('#set-turnstile-secret').value.trim();
    const body = {
      default_weekly_token_limit: $('#set-default-limit').value.trim(),
      turnstile_site_key: $('#set-turnstile-site').value.trim(),
    };
    // Send the secret only when the admin typed a new one.
    if (secret) body.turnstile_secret_key = secret;
    try {
      await api('/api/admin/settings', { method: 'PUT', body });
      await loadProviderSettings(); // re-populate (placeholders, shorthand)
      saved.hidden = false;
      setTimeout(() => { saved.hidden = true; }, 2600);
      toast('Limits & captcha saved');
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

let providerWired = false;
function wireProviderFormOnce() {
  if (providerWired) return;
  providerWired = true;
  $('#provider-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#provider-save');
    const saved = $('#provider-saved');
    btn.disabled = true;
    saved.hidden = true;
    const key = $('#set-key').value.trim();
    const body = {
      provider_name: $('#set-provider').value.trim(),
      base_url: $('#set-baseurl').value.trim(),
      model: $('#set-model').value.trim(),
      signup_enabled: $('#set-signup').checked,
      signup_approval_required: $('#set-signup-approval').checked ? '1' : '0'
    };
    // Send the key only when the admin typed a new one.
    if (key) body.api_key = key;
    try {
      // The save response is { ok: true } — merge it so has_key (fetched at
      // load) survives and the key placeholder doesn't flip to "Not set".
      const r = await api('/api/admin/settings', { method: 'PUT', body });
      S.adminSettings = { ...S.adminSettings, ...r };
      $('#set-key').value = '';
      $('#set-key').placeholder = S.adminSettings.has_key ? 'Saved ✓ — leave blank to keep' : 'Not set';
      saved.hidden = false;
      setTimeout(() => { saved.hidden = true; }, 2600);
      toast('Provider settings saved');
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

async function loadAdminUsers() {
  wireUsersTabOnce();
  const body = $('#users-body');
  body.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
  try {
    S.adminUsers = await api('/api/admin/users');
    try { S.adminUsage = await api('/api/admin/usage'); } catch { S.adminUsage = []; }
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="muted">Couldn't load users.</td></tr>`;
    return;
  }
  renderAdminUsers();
}

/* Users tab: search by username + pagination. Client-side over the full
   list — plenty fast for any realistic admin roster. */
const USERS_PER_PAGE = 25;
let usersTabWired = false;
function wireUsersTabOnce() {
  if (usersTabWired) return;
  usersTabWired = true;
  S.userSearch = '';
  S.userPage = 0;
  $('#users-search').addEventListener('input', (e) => {
    S.userSearch = e.target.value.trim().toLowerCase();
    S.userPage = 0;
    renderAdminUsers();
  });
  $('#users-prev').addEventListener('click', () => {
    if (S.userPage > 0) { S.userPage--; renderAdminUsers(); }
  });
  $('#users-next').addEventListener('click', () => {
    S.userPage++; renderAdminUsers();
  });
}

function filteredAdminUsers() {
  const q = S.userSearch || '';
  if (!q) return S.adminUsers || [];
  return (S.adminUsers || []).filter(u => String(u.username || '').toLowerCase().includes(q));
}

function renderUsersPager(count) {
  const pages = Math.max(1, Math.ceil(count / USERS_PER_PAGE));
  if (S.userPage > pages - 1) S.userPage = pages - 1;
  const pager = $('#users-pager');
  pager.hidden = pages <= 1;
  if (pages <= 1) return;
  $('#users-page-info').textContent = `Page ${S.userPage + 1} of ${pages} · ${count} user${count === 1 ? '' : 's'}`;
  $('#users-prev').disabled = S.userPage === 0;
  $('#users-next').disabled = S.userPage >= pages - 1;
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k';
  return String(n);
}

/* Usage cell with a progress bar: "used / limit" plus a fill that turns hot
   near the cap. Unlimited users get the ∞ label with no bar. */
function usageCell(used, lim) {
  const usageText = `${fmtTokens(used)} / ${lim === null || lim === undefined ? '∞' : fmtTokens(lim)}`;
  if (lim === null || lim === undefined) {
    return `<td class="muted"><span title="tokens used this week / no limit">${esc(usageText)}</span></td>`;
  }
  const pct = Math.min(100, (used / lim) * 100);
  const cls = pct >= 100 ? 'usage-fill full' : pct >= 90 ? 'usage-fill hot' : 'usage-fill';
  return `<td class="muted">
    <div class="usage-line" title="tokens used this week / weekly limit">
      <span>${esc(usageText)}</span><span class="usage-pct">${pct.toFixed(0)}%</span>
    </div>
    <div class="usage-bar"><div class="${cls}" style="width:${pct.toFixed(1)}%"></div></div>
  </td>`;
}

function renderAdminUsers() {
  const body = $('#users-body');
  body.innerHTML = '';
  const filtered = filteredAdminUsers();
  if (!(S.adminUsers || []).length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No users yet.</td></tr>`;
    renderUsersPager(0);
    return;
  }
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No users match “${esc(S.userSearch)}”.</td></tr>`;
    renderUsersPager(0);
    return;
  }
  const usageById = {};
  for (const r of S.adminUsage || []) usageById[r.user_id] = r;
  const page = filtered.slice(S.userPage * USERS_PER_PAGE, (S.userPage + 1) * USERS_PER_PAGE);
  for (const u of page) {
    const isSelf = S.me && u.id === S.me.id;
    const usage = usageById[u.id];
    const used = usage ? usage.total_tokens : 0;
    const lim = u.weekly_token_limit;
    const tr = document.createElement('tr');
    const rawInitial = (u.username[0] || '?').toUpperCase();
    const initial = esc(rawInitial);
    const avatarHtml = u.avatar_path
      ? `<span class="avatar"><img src="/api/admin/users/${u.id}/avatar" alt=""></span>`
      : `<span class="avatar">${initial}</span>`;
    tr.innerHTML = `
      <td><span class="u-name ${u.disabled ? 'u-disabled' : ''}">
        ${avatarHtml}${esc(u.username)}
      </span></td>
      <td>
        <span class="pill ${u.role === 'admin' ? 'admin' : 'user'}">${esc(u.role)}</span>
        ${u.disabled ? '<span class="pill off">disabled</span>' : ''}
        ${u.abuse_locked ? `<span class="pill danger" title="${esc(u.abuse_reason || 'locked for abuse')}">locked</span>` : ''}
      </td>
      <td class="muted">${Number(u.message_count) || 0}</td>
      ${usageCell(used, lim)}
      <td class="muted">${esc(fmtDate(u.created_at))}</td>
      <td><div class="u-actions"></div></td>`;
    if (u.avatar_path) {
      // Avatar fallback via a real listener instead of inline onerror:
      // HTML entity-decoding happens before JS parsing, so an initial of
      // ' or \ would break the inline-handler string. The raw (unescaped)
      // initial is safe here via closure + createTextNode.
      const img = tr.querySelector('.avatar img');
      const showInitial = () => img.replaceWith(document.createTextNode(rawInitial));
      if (img.complete && img.naturalWidth === 0) showInitial();
      else img.addEventListener('error', showInitial, { once: true });
    }
    const acts = tr.querySelector('.u-actions');
    const menuBtn = document.createElement('button');
    menuBtn.className = 'icon-btn';
    menuBtn.setAttribute('aria-label', `Actions for ${u.username}`);
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.textContent = '\u22EF';
    menuBtn.onclick = (e) => { e.stopPropagation(); openUserActionsMenu(u, menuBtn, isSelf); };
    acts.appendChild(menuBtn);

    body.appendChild(tr);
  }
  renderUsersPager(filtered.length);
}


/* ============================================================
   Pending tab: signup requests awaiting an admin decision.
   Same client-side search + 25/page pagination as the Users tab.
   ============================================================ */
const PENDING_PER_PAGE = 25;
let pendingTabWired = false;

function wirePendingTabOnce() {
  if (pendingTabWired) return;
  pendingTabWired = true;
  S.pendingFilter = 'pending';
  S.pendingSearch = '';
  S.pendingPage = 0;
  $('#pending-filter-pending').addEventListener('click', () => setPendingFilter('pending'));
  $('#pending-filter-denied').addEventListener('click', () => setPendingFilter('denied'));
  $('#pending-search').addEventListener('input', (e) => {
    S.pendingSearch = e.target.value.trim().toLowerCase();
    S.pendingPage = 0;
    renderPendingRequests();
  });
  $('#pending-prev').addEventListener('click', () => {
    if (S.pendingPage > 0) { S.pendingPage--; renderPendingRequests(); }
  });
  $('#pending-next').addEventListener('click', () => {
    S.pendingPage++; renderPendingRequests();
  });
}

function setPendingFilter(f) {
  S.pendingFilter = f;
  S.pendingPage = 0;
  $('#pending-filter-pending').classList.toggle('active', f === 'pending');
  $('#pending-filter-denied').classList.toggle('active', f === 'denied');
  renderPendingRequests();
}

function filteredPendingRequests() {
  const all = S.pendingRequests || [];
  const byStatus = all.filter(r => (r.status || '') === S.pendingFilter);
  const q = S.pendingSearch || '';
  if (!q) return byStatus;
  return byStatus.filter(r => String(r.username || '').toLowerCase().includes(q));
}

function renderPendingPager(count) {
  const pages = Math.max(1, Math.ceil(count / PENDING_PER_PAGE));
  if (S.pendingPage > pages - 1) S.pendingPage = pages - 1;
  const pager = $('#pending-pager');
  pager.hidden = pages <= 1;
  if (pages <= 1) return;
  $('#pending-page-info').textContent = `Page ${S.pendingPage + 1} of ${pages} · ${count} request${count === 1 ? '' : 's'}`;
  $('#pending-prev').disabled = S.pendingPage === 0;
  $('#pending-next').disabled = S.pendingPage >= pages - 1;
}

function pendingStatusPill(r) {
  if (r.status === 'approved') return '<span class="pill">approved</span>';
  if (r.status === 'denied') return '<span class="pill danger">denied</span>';
  return '<span class="pill user">pending</span>';
}

function renderPendingRequests() {
  const body = $('#pending-body');
  body.innerHTML = '';
  const filtered = filteredPendingRequests();
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">${
      S.pendingSearch ? `No requests match “${esc(S.pendingSearch)}”.`
      : S.pendingFilter === 'pending' ? 'No pending signup requests.' : 'No denied requests.'
    }</td></tr>`;
    renderPendingPager(0);
    return;
  }
  const page = filtered.slice(S.pendingPage * PENDING_PER_PAGE, (S.pendingPage + 1) * PENDING_PER_PAGE);
  for (const r of page) {
    const tr = document.createElement('tr');
    const isPending = r.status === 'pending';
    const acts = isPending
      ? `<button type="button" class="btn primary small" data-pact="approve">Approve</button>
         <button type="button" class="btn danger-ghost small" data-pact="deny">Deny</button>`
      : `<button type="button" class="btn danger-ghost small" data-pact="remove">Remove</button>`;
    tr.innerHTML = `
      <td><span class="u-name">${esc(r.username || '?')}</span></td>
      <td class="muted">${esc(fmtDate(r.created_at))}</td>
      <td>${pendingStatusPill(r)}</td>
      <td><div class="u-actions">${acts}</div></td>`;
    tr.querySelectorAll('[data-pact]').forEach(b => {
      b.addEventListener('click', () => pendingRequestAction(r, b.dataset.pact));
    });
    body.appendChild(tr);
  }
  renderPendingPager(filtered.length);
}

async function pendingRequestAction(r, act) {
  if (act === 'deny') {
    const ok = await confirmDialog({
      title: 'Deny this signup?',
      message: `${r.username} won't be able to create an account.`,
      confirmLabel: 'Deny request', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/signup-requests/${encodeURIComponent(r.id)}/deny`, { method: 'POST' });
      toast(`Denied ${r.username}'s signup request`);
    } catch (e) { toast(e.message, 'error'); }
  } else if (act === 'remove') {
    const ok = await confirmDialog({
      title: 'Remove this request?',
      message: `Delete ${r.username}'s denied signup request. They can request again later.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/signup-requests/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      toast('Request removed');
    } catch (e) { toast(e.message, 'error'); }
  } else {
    try {
      const res = await api(`/api/admin/signup-requests/${encodeURIComponent(r.id)}/approve`, { method: 'POST' });
      toast(`${res.username || r.username} approved — they can sign in now`);
    } catch (e) { toast(e.message, 'error'); }
  }
  await loadPendingRequests();
  refreshPendingDot();
}

/* Red dot on the admin's avatar while signup requests await review.
   Shown for admins only; a cheap count poll keeps it fresh on every page,
   and it's refreshed immediately after each approve/deny/remove. */
let pendingDotTimer = null;
async function refreshPendingDot() {
  const dot = document.getElementById('pending-dot');
  if (!dot) return;
  if (!S.me || S.me.role !== 'admin') { dot.hidden = true; return; }
  try {
    const r = await api('/api/admin/pending-count');
    dot.hidden = !(r && r.count > 0);
  } catch { /* transient failure — keep the current state */ }
}
function startPendingDot() {
  stopPendingDot();
  if (!S.me || S.me.role !== 'admin') return; // no session or not an admin: nothing to poll
  refreshPendingDot();
  pendingDotTimer = setInterval(refreshPendingDot, 30000);
}
function stopPendingDot() {
  if (pendingDotTimer) { clearInterval(pendingDotTimer); pendingDotTimer = null; }
  const dot = document.getElementById('pending-dot');
  if (dot) dot.hidden = true;
}

async function loadPendingRequests() {
  wirePendingTabOnce();
  const body = $('#pending-body');
  body.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
  try {
    S.pendingRequests = await api('/api/admin/signup-requests');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="muted">Couldn't load signup requests.</td></tr>`;
    S.pendingRequests = [];
  }
  renderPendingRequests();
  // Tab badge: count of requests still waiting on an admin.
  const n = (S.pendingRequests || []).filter(r => (r.status || '') === 'pending').length;
  const badge = $('#pending-badge');
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

/* ---------- admin user actions menu ---------- */
function closeUserActionsMenu() {
  document.getElementById('user-actions-menu')?.remove();
  document.removeEventListener('click', closeUserActionsMenuOutside, true);
  document.removeEventListener('keydown', closeUserActionsMenuEsc, true);
  document.removeEventListener('scroll', closeUserActionsMenu, true);
}
function closeUserActionsMenuOutside(e) {
  if (!e.target.closest('#user-actions-menu')) closeUserActionsMenu();
}
function closeUserActionsMenuEsc(e) {
  if (e.key === 'Escape') closeUserActionsMenu();
}

function openUserActionsMenu(u, anchor, isSelf) {
  const wasOpen = !!document.getElementById('user-actions-menu');
  closeUserActionsMenu();
  if (wasOpen) return; // tapping the button again dismisses
  const menu = document.createElement('div');
  menu.id = 'user-actions-menu';
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  const item = (label, fn, { danger = false, disabled = false, sep = false } = {}) => {
    if (sep) {
      const s = document.createElement('div');
      s.className = 'menu-sep';
      menu.appendChild(s);
    }
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('role', 'menuitem');
    if (danger) b.classList.add('danger');
    b.disabled = disabled;
    b.onclick = async () => { closeUserActionsMenu(); await fn(); };
    menu.appendChild(b);
  };

  item(u.role === 'admin' ? 'Remove admin' : 'Make admin', async () => {
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'user' : 'admin' } });
      await loadAdminUsers();
      toast(`${u.username} is ${u.role === 'admin' ? 'no longer' : 'now'} an admin`);
    } catch (e) { toast(e.message, 'error'); }
  }, { disabled: isSelf });

  item(u.disabled ? 'Enable' : 'Disable', async () => {
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } });
      await loadAdminUsers();
      toast(u.disabled ? `${u.username} enabled` : `${u.username} disabled`);
    } catch (e) { toast(e.message, 'error'); }
  }, { disabled: isSelf });

  item('Set token limit\u2026', async () => {
    const cur = u.weekly_token_limit;
    const v = await promptDialog({
      title: 'Weekly token limit',
      message: `For ${u.username}. Accepts 1K, 1M, 10M, 1B, 3T \u2026 Empty = unlimited.`,
      value: formatTokenLimit(cur),
      placeholder: 'e.g. 1M',
      okLabel: 'Save limit',
    });
    if (v === null) return; // cancelled
    const parsed = parseTokenLimit(v);
    if (!parsed.ok) { toast(parsed.error, 'error'); return; }
    try {
      await api(`/api/admin/users/${u.id}/limit`, { method: 'PATCH', body: { weekly_token_limit: parsed.value } });
      await loadAdminUsers();
      if (S.me && u.id === S.me.id) { refreshUsage(); renderUsageCard(); }
      toast(`Limit updated for ${u.username}`);
    } catch (e) { toast(e.message, 'error'); }
  });

  item('Reset usage', async () => {
    const ok = await confirmDialog({
      title: 'Reset usage?',
      message: `Zero ${u.username}\u2019s token usage for this week?`,
      confirmLabel: 'Reset'
    });
    if (!ok) return;
    try {
      await api(`/api/admin/users/${u.id}/usage/reset`, { method: 'POST' });
      await loadAdminUsers();
      // If they reset their own usage, update the sidebar bar + settings card now.
      if (S.me && u.id === S.me.id) { refreshUsage(); renderUsageCard(); }
      toast(`Usage reset for ${u.username}`);
    } catch (e) { toast(e.message, 'error'); }
  });

  item('Delete', async () => {
    const ok = await confirmDialog({
      title: 'Delete user?',
      message: `${u.username}\u2019s account, chats, and sandbox will be removed. This can\u2019t be undone.`,
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      await loadAdminUsers();
      toast(`${u.username} deleted`);
    } catch (e) { toast(e.message, 'error'); }
  }, { danger: true, disabled: isSelf, sep: true });

  // Fixed positioning escapes the table's overflow-x container, which
  // would otherwise clip the menu. Flip upward near the viewport bottom.
  menu.classList.add('menu-fixed');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
  let top = r.bottom + 8;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  // Skip the click that opened the menu.
  setTimeout(() => {
    document.addEventListener('click', closeUserActionsMenuOutside, true);
    document.addEventListener('keydown', closeUserActionsMenuEsc, true);
    document.addEventListener('scroll', closeUserActionsMenu, true);
  }, 0);
}

/* ---------- WebAuthn helpers ---------- */
function waSupported() { return !!window.PublicKeyCredential; }
function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
function bufToB64url(buf) {
  const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function webauthnOptionsFromJson(o) {
  o = { ...o };
  if (o.challenge) o.challenge = b64urlToBuf(o.challenge);
  if (o.user && o.user.id) o.user = { ...o.user, id: b64urlToBuf(o.user.id) };
  if (o.allowCredentials) o.allowCredentials = o.allowCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
  if (o.excludeCredentials) o.excludeCredentials = o.excludeCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
  return o;
}
function webauthnCredToJson(cred) {
  const r = cred.response;
  const out = {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      attestationObject: r.attestationObject ? bufToB64url(r.attestationObject) : undefined,
      authenticatorData: r.authenticatorData ? bufToB64url(r.authenticatorData) : undefined,
      signature: r.signature ? bufToB64url(r.signature) : undefined,
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined,
    },
  };
  for (const k of Object.keys(out.response)) if (out.response[k] === undefined) delete out.response[k];
  return out;
}

/* ---------- 2FA login flow ---------- */
let _twofaChallenge = null;
function show2faStep(challenge) {
  _twofaChallenge = challenge;
  $('#auth-form').hidden = true;
  $('#passkey-btn').hidden = true;
  $('#auth-2fa-step').hidden = false;
  $('#auth-2fa-error').hidden = true;
  $('#auth-2fa-code').value = '';
  setTimeout(() => $('#auth-2fa-code').focus(), 30);
}
function hide2faStep() {
  _twofaChallenge = null;
  $('#auth-2fa-step').hidden = true;
  $('#auth-form').hidden = false;
  updatePasskeyBtn();
}
async function submit2fa(e) {
  e.preventDefault();
  const code = $('#auth-2fa-code').value.trim();
  if (!code) return;
  const errEl = $('#auth-2fa-error');
  errEl.hidden = true;
  try {
    const d = await api('/api/auth/2fa/verify', { method: 'POST', body: { challenge: _twofaChallenge, code } });
    if (d.need_2fa) {
      show2faStep(d.challenge);
      errEl.textContent = 'Try again — that code didn’t match.';
      errEl.hidden = false;
      return;
    }
    S.me = d.user;

    hide2faStep();
    await afterLogin();
  } catch (err) {
    errEl.textContent = err.message || 'That code didn’t work.';
    errEl.hidden = false;
  }
}
async function passkeyLogin() {
  if (!waSupported()) return;
  const errEl = $('#auth-error');
  errEl.hidden = true;
  try {
    const { token, options } = await api('/api/auth/passkey/login/options', { method: 'POST' });
    const cred = await navigator.credentials.get({ publicKey: webauthnOptionsFromJson(options) });
    const d = await api('/api/auth/passkey/login/verify', { method: 'POST', body: { token, response: webauthnCredToJson(cred) } });
    S.me = d;

    await afterLogin();
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return; // user cancelled
    errEl.textContent = err.message || 'Passkey sign-in failed.';
    errEl.hidden = false;
  }
}

/* ---------- settings ---------- */
const SETTINGS_TABS = ['security', 'sessions', 'vault', 'notifications'];
let _settingsTab = 'security';
let _twofaStatus = null;
let _passkeys = null;

/* ---------- own weekly usage (settings card) ---------- */
async function renderUsageCard() {
  const card = $('#usage-card');
  if (!card) return;
  try {
    const u = await api('/api/usage');
    const used = u.total_tokens || 0;
    const lim = u.limit;
    const fill = $('#usage-fill');
    if (lim === null || lim === undefined) {
      $('#usage-text').textContent = `${formatCompactTokens(used)} tokens · ${usageResetIn()} · no limit set`;
      fill.style.width = '100%';
      fill.className = 'usage-fill shiny';
      $('#usage-bar-wrap').hidden = false;
    } else {
      const pct = Math.min(100, (used / lim) * 100);
      $('#usage-text').textContent = `${formatCompactTokens(used)} of ${formatCompactTokens(lim)} · ${usageResetIn()}`;
      fill.style.width = pct.toFixed(1) + '%';
      fill.className = 'usage-fill shiny' + (pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : '');
      $('#usage-bar-wrap').hidden = false;
    }
  } catch {
    card.hidden = true;
  }
}
async function renderSettings() {
  document.querySelectorAll('.settings-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === _settingsTab));
  for (const t of SETTINGS_TABS) {
    const el = document.getElementById('set-panel-' + t);
    if (el) el.hidden = t !== _settingsTab;
  }
  if (_settingsTab === 'security') renderSecurityTab();
  else if (_settingsTab === 'sessions') renderSessionsTab();
  else if (_settingsTab === 'vault') renderVaultTab();
  else if (_settingsTab === 'notifications') renderNotificationsTab();
  renderProfileCard();
  renderUsageCard();
}
function wireSettings() {
  document.querySelectorAll('.settings-tab').forEach(t => {
    t.onclick = () => { _settingsTab = t.dataset.tab; renderSettings(); };
  });
  wireSessionsTab();
  wireProfileCard();
  $('#change-password-btn').onclick = changePasswordModal;
  $('#reset-everything').onclick = resetEverythingModal;
  $('#delete-account').onclick = deleteAccountModal;
  $('#delete-all-chats').onclick = deleteAllChatsModal;
}

/* ---------- full reset: chats + sandbox + vault, password + 2FA confirmed ---------- */
async function resetEverythingModal() {
  // Ask for the 2FA status fresh so the code field only appears when needed.
  let need2fa = false;
  try { need2fa = !!(await api('/api/auth/2fa/status')).enabled; } catch {}
  const bd = openModal(`
    <h3>Reset everything?</h3>
    <p class="muted">This erases <b>all chats</b> — every message in every conversation — <b>everything</b> in the agent's sandbox — files, installed tools, the agent's memory (SOUL.md / MEMORY.md) — and <b>everything in the vault</b> — all stored secrets. The sandbox starts over fresh. This can't be undone.</p>
    <form id="reset-form">
      <label class="field"><span>Your password</span>
        <input id="reset-password" type="password" autocomplete="current-password" required>
      </label>
      ${need2fa ? `<label class="field"><span>Two-factor code</span>
        <input id="reset-totp" type="text" inputmode="numeric" autocomplete="one-time-code" required maxlength="8">
      </label>` : ''}
      <p id="reset-error" class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-x="cancel">Cancel</button>
        <button type="submit" class="btn danger-ghost" id="reset-submit">Reset everything</button>
      </div>
    </form>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  bd.querySelector('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = bd.querySelector('#reset-error');
    const btn = bd.querySelector('#reset-submit');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Resetting…';
    try {
      const out = await api('/api/reset', { method: 'POST', body: {
        password: bd.querySelector('#reset-password').value,
        totp_code: need2fa ? bd.querySelector('#reset-totp').value : undefined
      }});
      closeModal();
      clearChatState();
      // The server wiped every chat and made a fresh one — open it.
      await loadConversationsQuiet();
      if (out && out.conversation_id) await switchConversation(out.conversation_id);
      toast('Everything reset');
    } catch (ex) {
      err.textContent = ex.message || 'Reset failed.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Reset everything';
    }
  });
}

/* ---------- delete account: password + 2FA confirmed, everything goes ---------- */
async function deleteAccountModal() {
  // Ask for the 2FA status fresh so the code field only appears when needed.
  let need2fa = false;
  try { need2fa = !!(await api('/api/auth/2fa/status')).enabled; } catch {}
  const bd = openModal(`
    <h3>Delete your account?</h3>
    <p class="muted">This permanently deletes your account and <b>everything</b> attached to it — all chats, the sandbox, the vault, settings, scheduled tasks, the works. There is no way back from this.</p>
    <form id="delete-account-form">
      <label class="field"><span>Your password</span>
        <input id="delete-account-password" type="password" autocomplete="current-password" required>
      </label>
      ${need2fa ? `<label class="field"><span>Two-factor code</span>
        <input id="delete-account-totp" type="text" inputmode="numeric" autocomplete="one-time-code" required maxlength="8">
      </label>` : ''}
      <p id="delete-account-error" class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-x="cancel">Cancel</button>
        <button type="submit" class="btn danger-ghost" id="delete-account-submit">Delete my account</button>
      </div>
    </form>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  bd.querySelector('#delete-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = bd.querySelector('#delete-account-error');
    const btn = bd.querySelector('#delete-account-submit');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await api('/api/account', { method: 'DELETE', body: {
        password: bd.querySelector('#delete-account-password').value,
        totp_code: need2fa ? bd.querySelector('#delete-account-totp').value : undefined
      }});
      closeModal();
      closeEventStream();
      closeUserEventStream();
      S.me = null; S.activeId = null; S.messages = [];
      try { localStorage.removeItem('orion-active-chat'); } catch {}
      go('login');
      toast('Account deleted');
    } catch (ex) {
      err.textContent = ex.message || 'Delete failed.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Delete my account';
    }
  });
}

/* ---------- delete all chats: transcripts go, sandbox + memory stay ---------- */
async function deleteAllChatsModal() {
  // Ask for the 2FA status fresh so the code field only appears when needed.
  let need2fa = false;
  try { need2fa = !!(await api('/api/auth/2fa/status')).enabled; } catch {}
  const bd = openModal(`
    <h3>Delete all chats?</h3>
    <p class="muted">This erases <b>every chat transcript</b> — all messages in all conversations. The agent's <b>sandbox and memory are kept</b>: files, installed tools, SOUL.md / MEMORY.md, and scheduled tasks all survive. This can't be undone.</p>
    <form id="delchats-form">
      <label class="field"><span>Your password</span>
        <input id="delchats-password" type="password" autocomplete="current-password" required>
      </label>
      ${need2fa ? `<label class="field"><span>Two-factor code</span>
        <input id="delchats-totp" type="text" inputmode="numeric" autocomplete="one-time-code" required maxlength="8">
      </label>` : ''}
      <p id="delchats-error" class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-x="cancel">Cancel</button>
        <button type="submit" class="btn danger-ghost" id="delchats-submit">Delete all chats</button>
      </div>
    </form>`);
  bd.querySelector('[data-x=cancel]').onclick = closeModal;
  bd.querySelector('#delchats-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = bd.querySelector('#delchats-error');
    const btn = bd.querySelector('#delchats-submit');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const out = await api('/api/chats/delete-all', { method: 'POST', body: {
        password: bd.querySelector('#delchats-password').value,
        totp_code: need2fa ? bd.querySelector('#delchats-totp').value : undefined
      }});
      closeModal();
      clearChatState();
      // The server wiped every chat and made a fresh one — open it.
      await loadConversationsQuiet();
      if (out && out.conversation_id) await switchConversation(out.conversation_id);
      toast('All chats deleted — sandbox and memory kept');
    } catch (ex) {
      err.textContent = ex.message || 'Delete failed.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Delete all chats';
    }
  });
}

// Drop every message (and any in-flight streaming state) from the chat view.
function clearChatState() {
  S.messages = []; S.hasMoreOlder = false; S.loadingOlder = false;
  S.liveIds.clear();
  S.buffers.clear();
  S.toolRows.clear();
  setRunActive(false);
  renderMessages();
  updateComposer();
}

/* ----- security ----- */
async function renderSecurityTab() {
  const box = $('#twofa-box');
  const pkBox = $('#passkey-box');
  box.innerHTML = '<p class="muted">Loading…</p>';
  pkBox.innerHTML = '<p class="muted">Loading…</p>';
  try {
    _twofaStatus = await api('/api/auth/2fa/status');
  } catch (err) {
    box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    _twofaStatus = null;
  }
  try {
    const d = await api('/api/auth/passkeys');
    _passkeys = Array.isArray(d) ? d : [];
  } catch (err) {
    pkBox.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    _passkeys = null;
  }
  if (_twofaStatus) render2faBox();
  if (_passkeys !== null) renderPasskeyBox();
}

function render2faBox() {
  const box = $('#twofa-box');
  if (_twofaStatus.enabled) {
    box.innerHTML = `
      <div class="status-row"><span class="badge ok">Enabled</span>
      <span class="muted" style="flex:1;min-width:200px">${_twofaStatus.backup_codes_remaining != null ? esc(String(_twofaStatus.backup_codes_remaining)) + ' backup codes left' : ''}</span>
      <button id="twofa-disable-btn" class="btn danger">Disable 2FA</button></div>`;
    $('#twofa-disable-btn').onclick = () => disable2faModal();
    return;
  }
  box.innerHTML = `
    <div class="status-row"><span class="muted" style="flex:1;min-width:200px">Two-factor authentication adds a second step to sign-in using an authenticator app.</span>
    <button id="twofa-setup-btn" class="btn">Set up 2FA</button></div>
    <div id="twofa-setup" hidden>
      <p class="muted">Scan this with your authenticator app, then enter a code to confirm.</p>
      <div class="twofa-qr"><div class="qr-loading" id="twofa-qr-loading"><span class="spinner"></span></div><img id="twofa-qr-img" alt="2FA setup QR code" width="220" height="220" hidden></div>
      <div class="secret-row"><code id="twofa-secret" class="secret"></code><button id="twofa-copy" class="btn small">Copy</button></div>
      <form id="twofa-confirm-form" class="row-form">
        <input id="twofa-confirm-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="6-digit code" class="input">
        <button class="btn primary" type="submit">Confirm</button>
      </form>
      <p id="twofa-setup-error" class="form-error" hidden></p>
    </div>`;
  $('#twofa-setup-btn').onclick = async () => {
    // Enrolling a second factor re-authenticates with the password first —
    // a hijacked session alone must not be able to lock the user out.
    const pw = await promptDialog({
      title: 'Confirm it’s you',
      message: 'Enter your current password to set up two-factor authentication.',
      label: 'Current password',
      placeholder: 'Current password',
      okLabel: 'Continue',
      password: true,
    });
    if (pw === null) return;
    const wrap = $('#twofa-setup');
    wrap.hidden = false;
    $('#twofa-setup-btn').hidden = true;
    // Reset QR to loading state for (re)try.
    $('#twofa-qr-img').hidden = true;
    $('#twofa-qr-img').removeAttribute('src');
    const qrLoading = $('#twofa-qr-loading');
    qrLoading.hidden = false;
    qrLoading.innerHTML = '<span class="spinner"></span>';
    try {
      const d = await api('/api/auth/2fa/setup', { method: 'POST', body: { password: pw } });
      $('#twofa-secret').textContent = d.secret || '';
      const qrImg = $('#twofa-qr-img');
      if (d.qr_data_url) {
        qrImg.onload = () => { qrImg.hidden = false; qrLoading.hidden = true; };
        qrImg.onerror = () => { qrLoading.textContent = 'QR failed to load — use the code below.'; };
        qrImg.src = d.qr_data_url;
      } else {
        qrLoading.textContent = 'QR unavailable — use the code below.';
      }
      $('#twofa-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(d.secret || ''); toast('Copied'); }
        catch { toast('Copy failed — long-press the code'); }
      };
      $('#twofa-confirm-form').onsubmit = async (e) => {
        e.preventDefault();
        const code = $('#twofa-confirm-code').value.trim();
        const errEl = $('#twofa-setup-error');
        errEl.hidden = true;
        try {
          const r = await api('/api/auth/2fa/confirm', { method: 'POST', body: { code } });
          // Re-render first (it rebuilds the box), THEN show the codes —
          // otherwise the re-render wipes the just-shown backup codes.
          _twofaStatus = await api('/api/auth/2fa/status');
          render2faBox();
          showBackupCodes(r.backup_codes || []);
        } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
      };
    } catch (err) {
      const errEl = $('#twofa-setup-error');
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  };
}

function showBackupCodes(codes) {
  let wrap = $('#backup-codes-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'backup-codes-wrap';
    wrap.innerHTML = `
      <h3 class="set-h">Backup codes</h3>
      <p class="muted small">Save these somewhere safe — each works once if you lose your authenticator.</p>
      <div class="backup-codes" id="backup-codes-list"></div>
      <div class="row-form">
        <button id="backup-codes-copy" class="btn small">Copy all</button>
        <button id="backup-codes-close" class="btn small">Done</button>
      </div>`;
    $('#twofa-box').appendChild(wrap);
  }
  $('#backup-codes-list').innerHTML = codes.map(c => `<code class="secret">${esc(c)}</code>`).join('');
  wrap.hidden = false;
  $('#backup-codes-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast('Copied'); }
    catch { toast('Copy failed — long-press the codes'); }
  };
  $('#backup-codes-close').onclick = () => { wrap.hidden = true; };
}

function passwordConfirmModal(title, message) {
  return new Promise((resolve) => {
    const root = $('#modal-root') || document.body;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        <p class="muted">${esc(message)}</p>
        <form class="modal-form">
          <input type="password" class="input" autocomplete="current-password" placeholder="Password" required>
          <div class="modal-actions">
            <button type="button" class="btn cancel">Cancel</button>
            <button type="submit" class="btn danger">Confirm</button>
          </div>
        </form>
      </div>`;
    root.appendChild(wrap);
    const close = (v) => { wrap.remove(); resolve(v); };
    const form = wrap.querySelector('form');
    wrap.querySelector('.cancel').onclick = () => close(null);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
    form.onsubmit = (e) => {
      e.preventDefault();
      close(form.querySelector('input').value);
    };
    setTimeout(() => form.querySelector('input').focus(), 30);
  });
}

async function disable2faModal() {
  const creds = await twofaDisableModal();
  if (!creds) return;
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: { password: creds.password, code: creds.code } });
    _twofaStatus = await api('/api/auth/2fa/status');
    render2faBox();
    toast('2FA disabled');
  } catch (err) { toast('Disable failed: ' + err.message); }
}

function twofaDisableModal() {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal-card">
        <h3>Disable 2FA</h3>
        <p class="muted">Enter your password and a current 2FA code (or backup code) to turn off two-factor authentication.</p>
        <form class="modal-form">
          <input type="password" class="input" autocomplete="current-password" placeholder="Password" required>
          <input type="text" class="input" inputmode="numeric" autocomplete="one-time-code" placeholder="2FA code" required>
          <div class="modal-actions">
            <button type="button" class="btn cancel">Cancel</button>
            <button type="submit" class="btn danger">Disable 2FA</button>
          </div>
        </form>
      </div>`;
    root.appendChild(wrap);
    const close = (v) => { wrap.remove(); resolve(v); };
    const form = wrap.querySelector('form');
    const [pwInput, codeInput] = form.querySelectorAll('input');
    wrap.querySelector('.cancel').onclick = () => close(null);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
    form.onsubmit = (e) => {
      e.preventDefault();
      close({ password: pwInput.value, code: codeInput.value });
    };
    setTimeout(() => pwInput.focus(), 30);
  });
}

function renderPasskeyBox() {
  const box = $('#passkey-box');
  box.innerHTML = '';
  const list = document.createElement('div');
  box.appendChild(list);
  if (!_passkeys.length) {
    list.innerHTML = '<p class="muted">No passkeys yet. Register one to sign in without a password.</p>';
  } else {
    for (const pk of _passkeys) {
      const row = document.createElement('div');
      row.className = 'row-item';
      const name = pk.name || 'Passkey';
      const when = pk.created_at ? new Date(pk.created_at).toLocaleDateString() : '';
      row.innerHTML = `
        <div class="row-main"><span class="row-title">${esc(name)}</span>
        <span class="row-sub">${esc(when)}${pk.aaguid ? ' · ' + esc(String(pk.aaguid).slice(0, 8)) : ''}</span></div>
        <button class="btn small danger">Remove</button>`;
      row.querySelector('button').onclick = async () => {
        if (!await confirmDialog({ title: 'Remove passkey', message: `Remove “${name}”?`, confirmLabel: 'Remove', danger: true })) return;
        try {
          await api(`/api/auth/passkeys/${pk.id}`, { method: 'DELETE' });
          _passkeys = _passkeys.filter(x => x.id !== pk.id);
          renderPasskeyBox();
        } catch (err) { toast('Remove failed: ' + err.message); }
      };
      list.appendChild(row);
    }
  }
  if (waSupported()) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.marginTop = '8px';
    btn.textContent = 'Register a passkey';
    btn.onclick = registerPasskey;
    box.appendChild(btn);
  }
}

async function registerPasskey() {
  if (!waSupported()) { toast('This browser doesn’t support passkeys'); return; }
  const v = await promptDialog({
    title: 'Name this passkey',
    message: 'Something you’ll recognize, like the device it’s on.',
    label: 'Passkey name',
    placeholder: 'e.g. iPhone',
    okLabel: 'Continue',
    maxlength: 32,
  });
  if (v === null) return;
  const name = v;
  // Adding a login method re-authenticates with the password first.
  const pw = await promptDialog({
    title: 'Confirm it’s you',
    message: 'Enter your current password to register this passkey.',
    label: 'Current password',
    placeholder: 'Current password',
    okLabel: 'Continue',
    password: true,
  });
  if (pw === null) return;
  try {
    const { token, options } = await api('/api/auth/passkey/register/options', {
      method: 'POST',
      body: { password: pw },
    });
    const cred = await navigator.credentials.create({ publicKey: webauthnOptionsFromJson(options) });
    await api('/api/auth/passkey/register/verify', {
      method: 'POST',
      body: { token, response: webauthnCredToJson(cred), name: name.trim() || undefined },
    });
    const d = await api('/api/auth/passkeys');
    _passkeys = Array.isArray(d) ? d : [];
    renderPasskeyBox();
    toast('Passkey registered');
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
    toast('Registration failed: ' + err.message);
  }
}

/* ----- sessions ----- */
function fmtDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
// Parse a raw User-Agent into a friendly "Chrome on Android" device name
// for the sessions list. Falls back gracefully when parts are unknown.
function friendlyUA(ua) {
  if (!ua) return 'Unknown device';
  const b = /EdgA?iOS\/|Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera Mini|Opera Mobi/.test(ua) ? 'Opera'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /CriOS\//.test(ua) ? 'Chrome'
    : /FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Version\/[\d.]+.*Safari\//.test(ua) ? 'Safari'
    : null;
  const o = /Android/.test(ua) ? 'Android'
    : /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Windows NT/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (b && o) return `${b} on ${o}`;
  return b || o || 'Unknown device';
}
function wireSessionsTab() {
  $('#sessions-revoke-others').onclick = async () => {
    if (!await confirmDialog({ title: 'Sign out other sessions', message: 'Sign out every other device?', confirmLabel: 'Sign out', danger: true })) return;
    try {
      await api('/api/auth/sessions/others', { method: 'DELETE' });
      renderSessionsTab();
      toast('Other sessions signed out');
    } catch (err) { toast('Failed: ' + err.message); }
  };
}
async function renderSessionsTab() {
  const box = $('#sessions-box');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api('/api/auth/sessions');
    const sessions = Array.isArray(d) ? d : [];
    if (!sessions.length) { box.innerHTML = '<p class="muted">No sessions.</p>'; return; }
    box.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.innerHTML = `
        <div class="row-main">
          <span class="row-title" title="${esc(s.user_agent || '')}">${s.current ? '<span class="badge ok">This device</span> ' : ''}${esc(s.name || friendlyUA(s.user_agent))}</span>
          <span class="row-sub">${esc(s.ip || '')} · last active ${esc(fmtDateTime(s.last_seen_at || s.created_at))}</span>
        </div>
        <button class="btn small" data-act="rename">Rename</button>
        ${s.current ? '' : '<button class="btn small danger" data-act="revoke">Revoke</button>'}`;
      const renameBtn = row.querySelector('[data-act="rename"]');
      if (renameBtn) {
        renameBtn.onclick = async () => {
          const v = await promptDialog({
            title: 'Rename session',
            message: 'A name you’ll recognize, like the device it’s on. Leave empty to go back to the automatic name.',
            label: 'Session name',
            value: s.name || '',
            placeholder: friendlyUA(s.user_agent),
            maxlength: 32,
          });
          if (v === null) return;
          try {
            await api(`/api/auth/sessions/${s.id}`, { method: 'PATCH', body: { name: v.trim() } });
            toast(v.trim() ? 'Session renamed' : 'Name cleared');
            renderSessionsTab();
          } catch (err) { toast('Rename failed: ' + err.message); }
        };
      }
      const btn = row.querySelector('[data-act="revoke"]');
      if (btn) {
        btn.onclick = async () => {
          try {
            await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
            renderSessionsTab();
          } catch (err) { toast('Revoke failed: ' + err.message); }
        };
      }
      box.appendChild(row);
    }
  } catch (err) {
    box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

/* ---------- notifications ---------- */
function urlB64ToU8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function renderVaultTab() {
  const box = $('#vault-box');
  box.innerHTML = '<p class="muted">Loading…</p>';
  let items = [];
  try {
    items = await api('/api/vault/items');
  } catch (e) {
    box.innerHTML = `<p class="muted">Couldn't load the vault: ${esc(e.message)}</p>`;
    return;
  }
  if (!items.length) {
    box.innerHTML = '<p class="muted">No secrets stored. When the agent needs a credential, it will offer you a secure form right in the chat.</p>';
    return;
  }
  box.innerHTML = items.map((i) => `
    <div class="row-between vault-item">
      <div>
        <div><span aria-hidden="true">🔒</span> <strong>${esc(i.label)}</strong></div>
        <div class="muted small">Added ${esc(new Date(i.created_at).toLocaleDateString())}</div>
      </div>
      <button class="btn danger-ghost" data-vault-del="${esc(i.id)}" data-vault-label="${esc(i.label)}">Delete</button>
    </div>`).join('');
  box.querySelectorAll('[data-vault-del]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Delete secret?',
        message: `Remove "${b.dataset.vaultLabel}" from the vault? The agent will no longer be able to use it. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/vault/items/${encodeURIComponent(b.dataset.vaultDel)}`, { method: 'DELETE' });
        toast('Secret deleted');
        renderVaultTab();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

// Shared push opt-in: requests the browser permission (a system prompt the
// site can't skip) and registers the subscription server-side.
async function enablePush() {
  const p = await Notification.requestPermission();
  if (p !== 'granted') { toast('Notification permission not granted', 'error'); return false; }
  const { publicKey } = await api('/api/push/vapid-public-key');
  const reg = await navigator.serviceWorker.ready;
  const s = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToU8(publicKey),
  });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
  return true;
}
// One-time banner nudging toward push opt-in. Browsers require the user to
// tap the system permission prompt, so push can't be silently "on by
// default" — this makes it one tap instead of a dig through Settings.
async function maybeShowPushNudge() {
  const bar = $('#push-nudge');
  if (!bar || !S.me) return;
  try {
    if (!('PushManager' in window) || !('serviceWorker' in navigator) || !('Notification' in window)) return;
    if (Notification.permission === 'denied') return; // unfixable here — Settings explains it
    if (localStorage.getItem('orion-push-nudge') === 'dismissed') return;
    const reg = await navigator.serviceWorker.ready;
    if (await reg.pushManager.getSubscription()) return; // already on
    bar.hidden = false;
  } catch { /* never block the chat over a nudge */ }
}
function wirePushNudge() {
  const bar = $('#push-nudge');
  if (!bar) return;
  $('#push-nudge-enable').onclick = async () => {
    try {
      if (await enablePush()) {
        bar.hidden = true;
        toast('Push notifications enabled');
      }
    } catch (e) {
      toast('Couldn\u2019t enable notifications: ' + (e.message || e), 'error');
    }
  };
  $('#push-nudge-dismiss').onclick = () => {
    bar.hidden = true;
    try { localStorage.setItem('orion-push-nudge', 'dismissed'); } catch {}
  };
}
async function renderNotificationsTab() {
  const box = $('#notif-box');
  if (!('PushManager' in window) || !('serviceWorker' in navigator) || !('Notification' in window)) {
    box.innerHTML = '<p class="muted">Push notifications aren\u2019t supported in this browser.</p>';
    return;
  }
  box.innerHTML = '<p class="muted">Loading…</p>';
  let sub = null;
  try {
    const reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.getSubscription();
  } catch { sub = null; }
  const on = !!sub;
  const perm = Notification.permission;
  box.innerHTML = `
    <div class="row-between" style="margin-bottom:8px">
      <div>
        <div><strong>Push notifications: ${on ? 'on' : 'off'}</strong></div>
        <div class="muted small">Browser permission: ${esc(perm)}${on ? '' : ' — enable to get pinged when runs finish while you\u2019re away.'}</div>
      </div>
      <button class="btn ${on ? '' : 'primary'}" id="notif-toggle">${on ? 'Disable' : 'Enable'}</button>
    </div>
    ${!on && perm === 'denied'
      ? '<p class="muted small">Notifications are blocked for this site — allow them in your browser\u2019s site settings, then enable here.</p>'
      : ''}
    ${on ? '<div style="margin-top:12px"><button class="btn" id="notif-test">Send test notification</button></div>' : ''}
    ${on && /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches
      ? '<p class="muted small" style="margin-top:8px">iPhone note: open Orion from the Home Screen icon (not Safari), then turn notifications off and back on here so Apple registers this install.</p>'
      : ''}`;
  $('#notif-toggle').onclick = async () => {
    try {
      if (on) {
        const cur = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (cur) {
          await cur.unsubscribe();
          await api('/api/push/unsubscribe', { method: 'DELETE', body: { endpoint: cur.endpoint } });
        }
        toast('Push notifications disabled');
      } else {
        if (await enablePush()) toast('Push notifications enabled');
      }
    } catch (e) {
      toast('Couldn\u2019t update notifications: ' + e.message, 'error');
    }
    renderNotificationsTab();
  };
  $('#notif-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api('/api/push/test', { method: 'POST' });
      toast(r.sent ? 'Test notification sent — check your device.' : (r.detail || 'No push subscriptions found for this account.'));
    } catch (err) {
      toast('Couldn\u2019t send test: ' + err.message, 'error');
    }
    btn.disabled = false;
  });
}
