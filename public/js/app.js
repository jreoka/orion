/* ============================================================
   Orion — single-page app
   Vanilla JS. Hash routing: #/login, #/chat, #/admin, #/settings.
   All server state flows through the /api/* contract.
   ============================================================ */
'use strict';

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Escape user content before it ever touches innerHTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

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
    headers: body ? { 'Content-Type': 'application/json' } : {},
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
  lastSeenAt: {},     // conversation id -> timestamp the user last opened it
  switching: false,   // a conversation switch is in flight
  messages: [],        // [{id, role, content, attachments}]
  runActive: false,    // an agent run is in flight for the open conversation
  evt: null,           // EventSource for the open conversation's event bus
  evtRetry: 0,         // reconnect backoff step
  liveIds: new Set(),  // assistant message ids currently streaming
  buffers: new Map(),  // message id -> accumulated streamed text
  toolRows: new Map(), // message id -> [{name, el, open}]
  adminSettings: null,
  adminUsers: [],
  pendingUploads: [],  // staged file uploads waiting to be sent [{id, filename, mime, size, url, uploading}]
  jumpUnread: 0        // new messages arrived while the user was scrolled up
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
    const done = (v) => { closeModal(); resolve(v); };
    bd.querySelector('[data-x=cancel]').onclick = () => done(false);
    bd.querySelector('[data-x=ok]').onclick = () => done(true);
  });
}

/* Native prompt dialog (replaces window.prompt). Resolves with the entered
   string, or null when cancelled. */
function promptDialog({ title, message = '', placeholder = '', value = '', okLabel = 'Save', password = false }) {
  return new Promise((resolve) => {
    const bd = openModal(`
      <h3>${esc(title)}</h3>
      ${message ? `<p class="muted">${esc(message)}</p>` : ''}
      <form id="pd-form" autocomplete="off">
        <label class="fld">
          <input id="pd-input" type="${password ? 'password' : 'text'}" ${password ? 'autocomplete="current-password"' : ''} value="${esc(value)}" placeholder="${esc(placeholder)}">
        </label>
        <div class="modal-actions">
          <button type="button" class="btn" data-x="cancel">Cancel</button>
          <button type="submit" class="btn primary">${esc(okLabel)}</button>
        </div>
      </form>`);
    const done = (v) => { closeModal(); resolve(v); };
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

/* ---------- routing ---------- */
const ROUTES = ['login', 'chat', 'admin', 'settings'];
const VIEW_ID = { login: 'view-auth', chat: 'view-chat', admin: 'view-admin', settings: 'view-settings' };
function route() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  // Old push-notification deep links (#/chat/123) land on the single chat.
  if (/^chat\/\d+$/.test(h)) return 'chat';
  return ROUTES.includes(h) ? h : 'chat';
}
function go(r) { location.hash = '#/' + r; }

async function render() {
  const r = route();
  if (!S.me && r !== 'login') { go('login'); return; }
  if (S.me && r === 'login') { go('chat'); return; }
  if (r === 'admin' && S.me && S.me.role !== 'admin') { go('chat'); return; }
  for (const v of ROUTES) { const el = document.getElementById(VIEW_ID[v]); if (el) el.hidden = v !== r; }
  if (r === 'login') renderAuth();
  else if (r === 'chat') renderChat();
  else if (r === 'admin') renderAdmin();
  else if (r === 'settings') renderSettings();
}
window.addEventListener('hashchange', render);

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // When a new service worker takes over (e.g. a fresh deploy), reload
    // once so the tab runs the new code without a manual hard refresh.
    // The composer draft is persisted on every keystroke (see wireChat),
    // so reloading never eats what the user was typing.
    let swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swReloaded) return;
      swReloaded = true;
      toast('Orion updated — reloading…');
      setTimeout(() => location.reload(), 900);
    });
    // A push-notification tap while a tab is open: the service worker
    // focuses it and asks it to navigate to the conversation.
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'orion-navigate') {
        // The service worker posts the push deep-link (e.g. '#/chat/123').
        // Honor it instead of always landing on the most recent chat.
        const m = /^#\/chat\/(\d+)$/.exec(String(data.url || ''));
        const target = m ? Number(m[1]) : null;
        if (target && target !== S.activeId) {
          if (route() !== 'chat') location.hash = '#/chat'; // show the chat view first
          switchConversation(target);
        } else if (route() !== 'chat') location.hash = '#/chat';
        else renderChat();
      }
    });
  });
}

/* ---------- boot ---------- */
async function boot() {
  onUnauthorized = () => {
    // Session died (or was revoked): scrub every trace of the previous
    // user's state before showing login, so a different user signing in on
    // this device can't see chats rendered from memory. Mirrors the logout
    // cleanup in wireUserMenu, plus the streaming buffers.
    // NOTE: deliberately not setRunActive(false) — that fires
    // loadConversationsQuiet(), whose 401 would re-enter onUnauthorized
    // and recurse forever. The DOM effects are reproduced inline instead.
    closeEventStream();
    S.runActive = false;
    S.me = null; S.activeId = null; S.messages = [];
    S.conversations = [];
    S.hasMoreOlder = false; S.loadingOlder = false;
    S.buffers.clear(); S.toolRows.clear(); S.liveIds.clear();
    renderSidebar(); updateComposer();
    if (route() !== 'login') go('login'); else render();
  };
  try {
    S.me = await api('/api/auth/me');
  } catch { S.me = null; }
  if (!S.me) { if (route() !== 'login') go('login'); }
  else if (!location.hash || location.hash === '#/' || route() === 'login') go('chat');
  wireGlobal();
  await render();
}
document.addEventListener('DOMContentLoaded', boot);

/* ============================================================
   Auth view
   ============================================================ */
let authMode = 'login'; // or 'signup'

async function renderAuth() {
  // Hide the signup tab when public signups are disabled (fail open).
  try {
    const cfg = await api('/api/auth/config');
    const on = !cfg || cfg.signup_enabled !== false;
    $('#tab-signup').hidden = !on;
    if (!on) authMode = 'login';
  } catch (e) { $('#tab-signup').hidden = false; }
  setAuthMode(authMode);
  $('#auth-error').hidden = true;
  hide2faStep();
  updatePasskeyBtn();
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
  $('#auth-error').hidden = true;
  updatePasskeyBtn();
}

function wireGlobal() {
  // Theme toggle (Settings → Appearance), persisted across visits.
  const themeToggle = $('#theme-toggle');
  const applyTheme = (dark) => {
    if (dark) document.documentElement.dataset.theme = 'dark';
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('orion-theme', dark ? 'dark' : 'light'); } catch (e) {}
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#171310' : '#faf7f0');
  };
  if (themeToggle) {
    themeToggle.checked = document.documentElement.dataset.theme === 'dark';
    themeToggle.addEventListener('change', () => applyTheme(themeToggle.checked));
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
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = await api(authMode === 'login' ? '/api/auth/login' : '/api/auth/signup', {
        method: 'POST', body: { username, password }
      });
      if (res && res.need_2fa) { show2faStep(res.challenge); return; }
      S.me = res;
      $('#auth-password').value = '';
      go('chat');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
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
}

function openLightbox(url) {
  $('#lightbox-img').src = url;
  $('#lightbox').hidden = false;
}

/* ============================================================
   Chat view
   ============================================================ */

/* Markdown-lite, rendered safely: escape first, then decorate.
   Supports **bold**, *italic*, `code`, ```blocks (with Copy),
   [links](url), and line breaks. */
function inlineMd(s) {
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

function md(src) {
  const parts = String(src ?? '').split('```');
  let html = '';
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      let lang = '', code = p;
      const nl = p.indexOf('\n');
      if (nl > 0) {
        const maybe = p.slice(0, nl).trim();
        if (/^[a-z0-9+#-]+$/i.test(maybe) && maybe.length <= 20) { lang = maybe; code = p.slice(nl + 1); }
      }
      code = code.replace(/\n$/, '');
      html += `<div class="codeblock"><div class="codeblock-bar"><span>${esc(lang)}</span>` +
        `<button class="copybtn" type="button">Copy</button></div>` +
        `<pre><code data-code="${esc(code)}">${esc(code)}</code></pre></div>`;
    } else {
      html += inlineMd(p);
    }
  });
  return html || '<br>';
}

function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '');
}

function attachmentHtml(a) {
  if (isImageFile(a.filename)) {
    return `<img class="msg-img" src="${esc(a.url)}" alt="${esc(a.filename || 'image')}" loading="lazy">`;
  }
  return `<a class="chip" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" download="${esc(a.filename || '')}">📎 ${esc(a.filename || 'file')}</a>`;
}

/* ---------- messages ---------- */
// Windowing: the DOM only ever holds a suffix of S.messages. Older history
// stays in S.messages (and on the server) and is prepended as the user
// scrolls up, so long chats never overload the browser.
const RENDER_WINDOW = 80;  // messages painted on first load / full re-render
const RENDER_CAP = 200;    // DOM nodes kept; older ones are trimmed from the top
const OLDER_BATCH = 60;

function setMessages(data) {
  S.messages = data.messages || [];
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
function showOlderSpinner(on) {
  ensureOlderSpinner().hidden = !on;
}

// Prepend an older batch fetched from the server, keeping the view stable.
async function loadOlder() {
  if (S.loadingOlder || !S.hasMoreOlder || !S.messages.length || !S.activeId) return;
  const box = $('#messages');
  // trimRenderedTop() drops DOM nodes for messages that are still loaded in
  // S.messages. Re-attach those first — otherwise scrolling up dead-ends on
  // messages the client already has but can't see.
  const inDom = new Set();
  for (const n of box.querySelectorAll(':scope > [data-mid]')) inDom.add(Number(n.dataset.mid));
  const missing = S.messages.filter((m) => !inDom.has(m.id));
  if (missing.length) {
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const frag = document.createDocumentFragment();
    for (const m of missing) frag.appendChild(messageEl(m)); // S.messages order: oldest first
    box.insertBefore(frag, ensureOlderSpinner().nextSibling);
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
    return;
  }
  S.loadingOlder = true;
  showOlderSpinner(true);
  try {
    const data = await api(`/api/conversations/${S.activeId}/messages?before=${S.messages[0].id}&limit=${OLDER_BATCH}`);
    const batch = data.messages || [];
    S.hasMoreOlder = !!data.hasMoreOlder;
    if (!batch.length) return;
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    S.messages = [...batch, ...S.messages];
    const frag = document.createDocumentFragment();
    for (const m of batch) frag.appendChild(messageEl(m));
    box.insertBefore(frag, ensureOlderSpinner().nextSibling);
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  } catch {
    /* a failed page just means scrolling up tries again later */
  } finally {
    S.loadingOlder = false;
    showOlderSpinner(false);
  }
}

// Drop message nodes from the top when the DOM grows past RENDER_CAP.
// Only when the user isn't reading the top; scroll position is preserved.
function trimRenderedTop() {
  const box = $('#messages');
  if (box.scrollTop < 200) return;
  const nodes = box.querySelectorAll(':scope > [data-mid]');
  const over = nodes.length - RENDER_CAP;
  if (over <= 0) return;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  for (let i = 0; i < over && i < nodes.length; i++) nodes[i].remove();
  box.scrollTop = Math.max(0, prevTop - (prevHeight - box.scrollHeight));
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
// Explicit scroll: force always goes to the bottom.
function scrollBottom(force) {
  if (force || nearBottom()) {
    $('#messages').scrollTop = $('#messages').scrollHeight;
    hideJump();
  }
}
// A whole new message landed: scroll if we're at the bottom, otherwise
// stay put and raise the "jump to latest" pill with a count.
function noteNewMessage() {
  if (nearBottom()) {
    $('#messages').scrollTop = $('#messages').scrollHeight;
    hideJump();
  } else {
    S.jumpUnread++;
    paintJump();
  }
}
// Streamed content grew (tokens, tool rows): follow only if already at
// the bottom — never yank the user's scroll position.
function keepPlace() {
  if (nearBottom()) $('#messages').scrollTop = $('#messages').scrollHeight;
  else paintJump();
}

function wireJumpPill() {
  $('#jump-latest').addEventListener('click', () => scrollBottom(true));
  $('#messages').addEventListener('scroll', () => {
    if (nearBottom()) hideJump();
    else if (!$('#jump-latest').hidden) paintJump();
    // Near the top with older history available: page it in.
    if ($('#messages').scrollTop < 600) loadOlder();
  }, { passive: true });
}

/* ---------- file uploads ---------- */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderAttachTray() {
  const tray = $('#attach-tray');
  tray.hidden = S.pendingUploads.length === 0;
  tray.innerHTML = '';
  for (const p of S.pendingUploads) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (p.uploading ? ' uploading' : '');
    const thumb = p.uploading
      ? '<span class="attach-spin"></span>'
      : isImageFile(p.filename)
        ? `<img class="attach-thumb" src="${esc(p.url)}" alt="">`
        : '<span class="attach-file-ico">📎</span>';
    chip.innerHTML = `${thumb}<span class="attach-name">${esc(p.filename)}</span><span class="attach-size">${fmtBytes(p.size)}</span><button type="button" class="attach-x" aria-label="Remove attachment">×</button>`;
    chip.querySelector('.attach-x').addEventListener('click', () => {
      S.pendingUploads = S.pendingUploads.filter((x) => x !== p);
      renderAttachTray();
      updateComposer();
    });
    tray.appendChild(chip);
  }
}

async function handleFiles(files) {
  for (const file of files) {
    if (S.pendingUploads.length >= 10) { toast('At most 10 files per message.', 'error'); break; }
    const p = { id: null, filename: file.name, size: file.size, mime: file.type, url: '', uploading: true };
    S.pendingUploads.push(p);
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
      S.pendingUploads = S.pendingUploads.filter((x) => x !== p);
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

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  box.appendChild(ensureOlderSpinner());
  const empty = $('#empty-state');
  empty.hidden = S.messages.length > 0;
  // Windowed: only the latest RENDER_WINDOW messages hit the DOM.
  const win = S.messages.slice(-RENDER_WINDOW);
  for (const m of win) box.appendChild(messageEl(m));
  scrollBottom(true);
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
});

// Right-click (or long-press) a message: Copy / React. Native menu is kept
// for links, images, and active text selections.
$('#messages').addEventListener('contextmenu', (e) => {
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
  if (m.kind === 'update') {
    // Mid-run progress note: a slim status line, not a full message card,
    // so a working run reads as one answer with a work log — not a stack
    // of separate messages.
    wrap.classList.add('update');
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
    const imgs = (m.attachments || []).length
      ? `<div class="u-imgs">${(m.attachments || []).map(attachmentHtml).join('')}</div>` : '';
    wrap.innerHTML = `<div class="bubble">${md(m.content)}${imgs}<div class="rx-row" data-rxrow>${rxRowInner(m)}</div></div>`;
  } else {
    wrap.innerHTML = `
      <div class="a-avatar">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="5.5" fill="url(#orion-grad)"/>
          <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(-24 16 16)" fill="none" stroke="url(#orion-grad)" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="a-body">
        <div class="content">${m.content ? md(m.content) : ''}</div>
        <div class="imgs">${(m.attachments || []).map(attachmentHtml).join('')}</div>
        <div class="rx-row" data-rxrow>${rxRowInner(m)}</div>
      </div>`;
  }
  return wrap;
}

/* ---------- reactions ---------- */
const RX_EMOJI = ['❤️', '👍', '👎', '😂', '😮', '😢', '🎉', '🙏', '👏', '🔥', '✅', '🤔', '👀', '💯'];

function rxChipHtml(r) {
  return `<button class="rx-chip${r.mine ? ' mine' : ''}" data-rx="${esc(r.emoji)}" aria-label="Toggle ${esc(r.emoji)} reaction" title="${esc(r.agent ? 'Reacted by Orion' : 'Reacted by you')}">${esc(r.emoji)}${r.count > 1 ? `<span class="rx-n">${r.count}</span>` : ''}</button>`;
}

function rxRowInner(m) {
  const chips = (m.reactions || []).map(rxChipHtml).join('');
  return `${chips}<button class="rx-copy" data-copy aria-label="Copy message" title="Copy"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg></button><button class="rx-add" data-rxadd aria-label="Add reaction" title="Add reaction"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></button>`;
}

// Refresh one message's reaction row from a grouped-reactions payload.
function applyReactions(messageId, reactions) {
  const msg = S.messages.find((x) => x.id === messageId);
  if (msg) msg.reactions = reactions;
  const row = msgElById(messageId)?.querySelector('[data-rxrow]');
  if (row) row.innerHTML = rxRowInner({ reactions });
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
    <button data-act="copy" role="menuitem">Copy text</button>
    ${isLocal ? '' : '<button data-act="react" role="menuitem">Add reaction…</button>'}`;
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(Math.max(8, x), window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(Math.max(8, y), window.innerHeight - mh - 8) + 'px';
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMsgMenu();
    if (act === 'copy') copyMessage(mid);
    else if (act === 'react') openRxPickerAt(mid, x, y, y);
  });
  // Skip the click that opened the menu.
  setTimeout(() => {
    document.addEventListener('click', closeMsgMenuOutside, true);
    document.addEventListener('keydown', closeMsgMenuEsc, true);
  }, 0);
}

function appendUserMessage(content, attachments) {
  const m = { id: 'local-' + Date.now(), role: 'user', content, attachments: attachments || [] };
  S.messages.push(m);
  $('#messages').appendChild(messageEl(m));
  trimRenderedTop();
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
      S.me = null; S.activeId = null; S.messages = []; S.hasMoreOlder = false; S.loadingOlder = false;
      go('login');
    } else if (act === 'settings') go('settings');
    else if (act === 'password') changePasswordModal();
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

// Refresh the conversation list (titles, activity, running flags) without
// disturbing the open chat. Called on every run end, on window focus, and
// after create/rename/delete. (This is the function setRunActive always
// expected — its absence used to crash run cleanup.)
async function loadConversationsQuiet() {
  try {
    const rows = await api('/api/conversations');
    if (!Array.isArray(rows)) return;
    S.conversations = rows;
    for (const c of rows) {
      if (c.running) S.runByConv[c.id] = true;
      else if (c.id !== S.activeId) delete S.runByConv[c.id];
    }
    renderSidebar();
  } catch { /* sidebar refresh is best-effort */ }
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
  for (const c of S.conversations) {
    if (c.id === S.activeId) activeTitle = c.title || 'New chat';
    const el = document.createElement('div');
    el.className = 'conv-item' + (c.id === S.activeId ? ' active' : '');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = c.title || 'New chat';
    const seen = S.lastSeenAt[c.id] || 0;
    const hasNew = c.id !== S.activeId && seen > 0 && c.updated_at > seen;
    const working = !!(c.running || S.runByConv[c.id]);
    el.innerHTML = `
      <div class="conv-meta">
        <div class="conv-title">${esc(c.title || 'New chat')}</div>
        <div class="conv-sub">${working ? 'working…' : esc(timeAgo(c.updated_at))}</div>
      </div>
      ${working ? '<span class="conv-dot working" aria-label="Agent working"></span>'
                : hasNew ? '<span class="conv-dot" aria-label="New activity"></span>' : ''}
      <button class="conv-menu-btn" aria-label="Chat options" title="Chat options">⋯</button>`;
    el.addEventListener('click', (e) => {
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
    list.appendChild(el);
  }
  const t = $('#chat-title');
  if (t) t.textContent = activeTitle;
}

function closeConvMenu() { document.getElementById('conv-menu')?.remove(); }

function openConvMenu(conv, anchor) {
  closeConvMenu();
  const menu = document.createElement('div');
  menu.id = 'conv-menu';
  menu.className = 'menu';
  menu.innerHTML = `
    <button data-act="rename">Rename</button>
    <button data-act="delete" class="danger">Delete</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.zIndex = 120;
  menu.style.top = Math.min(window.innerHeight - 130, r.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 220, r.left - 170)) + 'px';
  menu.style.right = 'auto';
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closeConvMenu();
    if (act === 'rename') renameChatModal(conv);
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
      await api(`/api/conversations/${conv.id}`, { method: 'DELETE' });
      closeModal();
      delete S.runByConv[conv.id];
      delete S.lastSeenAt[conv.id];
      toast('Chat deleted');
      await loadConversationsQuiet();
      if (conv.id === S.activeId) {
        const next = S.conversations[0];
        if (next) await switchConversation(next.id);
        else {
          // Last chat deleted: land on the empty state. A new chat is
          // created only when the user starts one.
          closeEventStream();
          setRunActive(false); // no stream left to deliver run_ended; clear Stop now
          S.activeId = null;
          setMessages({ messages: [], hasMoreOlder: false });
          renderMessages();
          updateComposer();
        }
      }
    } catch (ex) { toast(ex.message || 'Delete failed', 'error'); }
  };
}

async function switchConversation(id) {
  if (id === S.activeId || S.switching) return;
  S.switching = true;
  saveDraft();
  closeConvMenu();
  closeSidebarDrawer();
  try {
    const data = await api(`/api/conversations/${id}`);
    closeEventStream();
    S.activeId = id;
    // Seed the Stop-button state synchronously — the SSE hello that corrects
    // it can lag, and without this the previous chat's run state leaks over.
    S.runActive = !!S.runByConv[id];
    setMessages(data);
    S.lastSeenAt[id] = Date.now();
    renderSidebar();
    renderMessages();
    openEventStream(id);
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
}
function closeSidebarDrawer() {
  $('#sidebar')?.classList.remove('open');
  const b = $('#side-backdrop');
  if (b) b.hidden = true;
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
  $('#menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.matchMedia('(max-width: 760px)').matches) openSidebarDrawer();
    else setSidebarCollapsed(!document.body.classList.contains('side-collapsed'));
  });
  $('#side-backdrop')?.addEventListener('click', closeSidebarDrawer);
  try {
    if (localStorage.getItem('orion-sidebar-collapsed') === '1') {
      document.body.classList.add('side-collapsed');
    }
  } catch {}
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.me) loadConversationsQuiet();
  });
}

/* ---------- chat view entry ---------- */
let chatWired = false;
async function renderChat() {
  renderUserChip();
  if (!chatWired) { wireChat(); chatWired = true; }
  wireUserMenuOnce();
  wireSidebarOnce();
  // Open the most recent chat. If none exists, create one quietly so the
  // page always lands in a regular chat tab — a chat is created only when
  // none exist, so refreshing never duplicates.
  if (!S.activeId) {
    const box = $('#messages');
    box.innerHTML = '<div class="skel" style="max-width:60%;"></div><div class="skel" style="max-width:80%;margin-left:auto"></div>';
    $('#empty-state').hidden = true;
    try {
      const list = await api('/api/conversations');
      if (list.length) {
        const data = await api(`/api/conversations/${list[0].id}`);
        S.activeId = list[0].id;
        setMessages(data);
      } else {
        const conv = await api('/api/conversations', { method: 'POST', body: { title: 'New chat' } });
        S.activeId = conv.id;
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

  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  $('#stop-btn').addEventListener('click', stopStream);

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
  const uploading = S.pendingUploads.some((p) => p.uploading);
  const hasFiles = S.pendingUploads.some((p) => !p.uploading && p.id != null);
  // Sending mid-run is allowed — the message is queued server-side.
  // Keep the send button visible/enabled based on text or staged files even
  // while a run is active; the stop button appears alongside it.
  $('#send-btn').disabled = uploading || (!hasText && !hasFiles);
  $('#send-btn').hidden = false;
  $('#stop-btn').hidden = !S.runActive;
}

async function sendMessage() {
  const input = $('#composer-input');
  const content = input.value.trim();
  const staged = S.pendingUploads.filter((p) => !p.uploading && p.id != null);
  if (S.pendingUploads.some((p) => p.uploading)) return; // wait for uploads
  if (!content && !staged.length) return;

  // Ensure a chat exists before posting into it: the first message
  // creates it (nothing is auto-created on page load).
  if (!S.activeId) {
    try {
      const conv = await api('/api/conversations', { method: 'POST', body: {} });
      const data = await api(`/api/conversations/${conv.id}`);
      S.activeId = conv.id;
      setMessages(data);
      renderMessages();
      openEventStream(S.activeId);
      await loadConversationsQuiet();
    } catch (e) { toast(e.message, 'error'); return; }
  }
  const convId = S.activeId;

  input.value = '';
  input.style.height = 'auto';
  if (S.clearComposerDraft) S.clearComposerDraft();
  S.pendingUploads = [];
  renderAttachTray();
  updateComposer();

  // Optimistic bubble, reconciled with the real row id below. The server
  // also publishes the row on the bus, which can arrive before the POST
  // response — upsertMessage dedupes by id either way.
  const local = appendUserMessage(content, staged.map((p) => ({ filename: p.filename, url: p.url })));

  let resp;
  try {
    resp = await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: { content, attachment_ids: staged.map((p) => p.id) },
    });
  } catch (e) {
    // If the bus already reconciled this message, the server did persist
    // it — don't remove it or resurrect the draft as if it never sent.
    if (!local._reconciled) {
      removeMessage(local);
      input.value = content; // restore the draft
      S.pendingUploads = staged; // keep the files staged so they can resend
      renderAttachTray();
      updateComposer();
    }
    toast(e.message || 'Send failed', 'error');
    return;
  }
  reconcileLocal(local, resp.message);
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
  return $('#messages').querySelector(`[data-mid="${CSS.escape(String(id))}"]`);
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
    for (const id of S.liveIds) {
      const el = msgElById(id);
      el?.querySelector('.typing-dots')?.remove();
      el?.querySelector('.content')?.classList.remove('caret');
    }
    S.liveIds.clear();
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
  es.addEventListener('run_ended', () => setRunActive(false));
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
    S.buffers.clear();
    S.toolRows.clear();
    renderMessages(); // live state re-derives from hello + subsequent events
  } catch { /* the next backoff tick retries */ }
}

// A vault secret was saved through the secure form: flip the widget card
// to its saved state and keep the local message copy in sync.
function onVaultEvent(d) {
  if (!d || !d.request_id) return;
  const safeId = String(d.request_id).replace(/["\\]/g, '');
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
    msg = { id: m.id, role: m.role, content: m.content || '', kind: m.kind || 'message', attachments: m.attachments || [], reactions: m.reactions || [] };
    S.messages.push(msg);
    $('#messages').appendChild(messageEl(msg));
    trimRenderedTop();
    $('#empty-state').hidden = true;
    added = true;
  } else if (msg.role === 'assistant' && S.liveIds.has(msg.id) && typeof m.content === 'string') {
    // Authoritative full-row republish (covers onNote appends the token
    // stream never carried). Only accept it when it isn't older than what
    // we've already streamed.
    const buf = S.buffers.get(msg.id) || '';
    if (m.content.length >= buf.length) {
      S.buffers.set(msg.id, m.content);
      msg.content = m.content;
      paintContent(msg);
    }
  }
  if (m.role === 'assistant' && S.runActive && !m.content) {
    // Fresh in-flight assistant row: typing indicator until tokens arrive.
    S.liveIds.add(m.id);
    const contentEl = msgElById(m.id)?.querySelector('.content');
    if (contentEl && !contentEl.querySelector('.typing-dots')) {
      const t = document.createElement('div');
      t.className = 'typing-dots';
      t.setAttribute('aria-label', 'Orion is thinking');
      t.innerHTML = '<span></span><span></span><span></span>';
      contentEl.appendChild(t);
    }
  }
  if (added) noteNewMessage(); else keepPlace();
}

function onBusToken(d) {
  if (!d || d.message_id == null) return;
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
  const contentEl = msgElById(d.message_id)?.querySelector('.content');
  if (!contentEl) return;
  contentEl.querySelector('.typing-dots')?.remove();
  contentEl.innerHTML = md(buf);
  contentEl.classList.add('caret');
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
    box.appendChild(el);
  }
  el.querySelector('.ttext').textContent = text;
  keepPlace();
}
function hideRunStatus() {
  document.getElementById('run-status')?.remove();
}
function onBusTool(d) {
  if (!d || d.status !== 'start') return;
  if (d.name === 'send_update') return; // the agent's own update line; no redundant status
  // Tool-only turns never stream tokens, so their typing dots would linger
  // forever — the status line says what's happening instead.
  if (d.message_id != null) msgElById(d.message_id)?.querySelector('.typing-dots')?.remove();
  showRunStatus(TOOL_STATUS_PHRASES[d.name] || 'Working…');
}

function onBusImage(d) {
  if (!d || !d.url || d.message_id == null) return;
  const imgsEl = msgElById(d.message_id)?.querySelector('.imgs');
  if (!imgsEl) return;
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = d.url;
  img.alt = d.filename || 'image';
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(d.url));
  imgsEl.appendChild(img);
  const msg = S.messages.find((x) => x.id === d.message_id);
  if (msg) (msg.attachments = msg.attachments || []).push({ url: d.url, filename: d.filename });
  keepPlace();
}

/* ============================================================
   Admin view — provider settings + user management.
   Admin-only; render() already guards the route.
   ============================================================ */
async function renderAdmin() {
  await Promise.all([loadProviderSettings(), loadAdminUsers()]);
  wireProviderFormOnce();
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
      signup_enabled: $('#set-signup').checked
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
  if (!S.adminUsers.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No users yet.</td></tr>`;
    return;
  }
  const usageById = {};
  for (const r of S.adminUsage || []) usageById[r.user_id] = r;
  for (const u of S.adminUsers) {
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
      value: cur === null || cur === undefined ? '' : String(cur),
      placeholder: 'e.g. 1M',
      okLabel: 'Save limit',
    });
    if (v === null) return; // cancelled
    const parsed = parseTokenLimit(v);
    if (!parsed.ok) { toast(parsed.error, 'error'); return; }
    try {
      await api(`/api/admin/users/${u.id}/limit`, { method: 'PATCH', body: { weekly_token_limit: parsed.value } });
      await loadAdminUsers();
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

    S.activeId = null;
    S.messages = []; S.hasMoreOlder = false; S.loadingOlder = false;
    hide2faStep();
    go('chat');
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

    S.activeId = null;
    S.messages = []; S.hasMoreOlder = false; S.loadingOlder = false;
    go('chat');
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
    if (lim === null || lim === undefined) {
      $('#usage-text').textContent = `${fmtTokens(used)} used this week — no limit set.`;
      $('#usage-bar-wrap').hidden = true;
    } else {
      const pct = Math.min(100, (used / lim) * 100);
      $('#usage-text').textContent = `${fmtTokens(used)} of ${fmtTokens(lim)} used this week`;
      const fill = $('#usage-fill');
      fill.style.width = pct.toFixed(1) + '%';
      fill.className = 'usage-fill' + (pct >= 100 ? ' full' : pct >= 90 ? ' hot' : '');
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
  $('#reset-everything').onclick = resetEverythingModal;
}

/* ---------- full reset: chat + sandbox, password + 2FA confirmed ---------- */
async function resetEverythingModal() {
  // Ask for the 2FA status fresh so the code field only appears when needed.
  let need2fa = false;
  try { need2fa = !!(await api('/api/auth/2fa/status')).enabled; } catch {}
  const bd = openModal(`
    <h3>Reset chat &amp; sandbox?</h3>
    <p class="muted">This wipes <b>all messages</b> in your chat and <b>everything</b> in the agent's sandbox — files, installed tools, the works. The sandbox starts over fresh. This can't be undone.</p>
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
      await api('/api/reset', { method: 'POST', body: {
        password: bd.querySelector('#reset-password').value,
        totp_code: need2fa ? bd.querySelector('#reset-totp').value : undefined
      }});
      closeModal();
      clearChatState();
      toast('Chat and sandbox reset');
    } catch (ex) {
      err.textContent = ex.message || 'Reset failed.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Reset everything';
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
      <span class="muted">${_twofaStatus.backup_codes_remaining != null ? esc(String(_twofaStatus.backup_codes_remaining)) + ' backup codes left' : ''}</span></div>
      <button id="twofa-disable-btn" class="btn danger">Disable 2FA</button>`;
    $('#twofa-disable-btn').onclick = () => disable2faModal();
    return;
  }
  box.innerHTML = `
    <p class="muted">Two-factor authentication adds a second step to sign-in using an authenticator app.</p>
    <button id="twofa-setup-btn" class="btn">Set up 2FA</button>
    <div id="twofa-setup" hidden>
      <p class="muted">Scan this with your authenticator app, then enter a code to confirm.</p>
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
      placeholder: 'Current password',
      okLabel: 'Continue',
      password: true,
    });
    if (pw === null) return;
    const wrap = $('#twofa-setup');
    wrap.hidden = false;
    $('#twofa-setup-btn').hidden = true;
    try {
      const d = await api('/api/auth/2fa/setup', { method: 'POST', body: { password: pw } });
      $('#twofa-secret').textContent = d.secret || '';
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
          showBackupCodes(r.backup_codes || []);
          _twofaStatus = await api('/api/auth/2fa/status');
          render2faBox();
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
  const pw = await passwordConfirmModal('Disable 2FA', 'Enter your password to turn off two-factor authentication.');
  if (!pw) return;
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: { password: pw } });
    _twofaStatus = await api('/api/auth/2fa/status');
    render2faBox();
    toast('2FA disabled');
  } catch (err) { toast('Disable failed: ' + err.message); }
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
    placeholder: 'e.g. iPhone',
    okLabel: 'Continue',
  });
  if (v === null) return;
  const name = v;
  // Adding a login method re-authenticates with the password first.
  const pw = await promptDialog({
    title: 'Confirm it’s you',
    message: 'Enter your current password to register this passkey.',
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
function truncUA(ua, n = 60) {
  if (!ua) return '';
  return ua.length > n ? ua.slice(0, n) + '…' : ua;
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
          <span class="row-title">${s.current ? '<span class="badge ok">This device</span> ' : ''}${esc(truncUA(s.user_agent, 40) || 'Unknown device')}</span>
          <span class="row-sub">${esc(s.ip || '')} · last active ${esc(fmtDateTime(s.last_seen_at || s.created_at))}</span>
        </div>
        ${s.current ? '' : '<button class="btn small danger">Revoke</button>'}`;
      const btn = row.querySelector('button');
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
        const p = await Notification.requestPermission();
        if (p !== 'granted') { toast('Notification permission not granted', 'error'); renderNotificationsTab(); return; }
        const { publicKey } = await api('/api/push/vapid-public-key');
        const reg = await navigator.serviceWorker.ready;
        const s = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToU8(publicKey),
        });
        await api('/api/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
        toast('Push notifications enabled');
      }
    } catch (e) {
      toast('Couldn\u2019t update notifications: ' + e.message, 'error');
    }
    renderNotificationsTab();
  };
}
