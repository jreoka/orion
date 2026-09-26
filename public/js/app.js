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
  if (res.status === 401 && onUnauthorized) { onUnauthorized(); return null; }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
  return data;
}

/* ---------- state ---------- */
const S = {
  me: null,
  activeId: null,     // the single main chat's conversation id
  messages: [],        // [{id, role, content, attachments}]
  runActive: false,    // an agent run is in flight for the open conversation
  evt: null,           // EventSource for the open conversation's event bus
  evtRetry: 0,         // reconnect backoff step
  liveIds: new Set(),  // assistant message ids currently streaming
  buffers: new Map(),  // message id -> accumulated streamed text
  toolRows: new Map(), // message id -> [{name, el, open}]
  adminSettings: null,
  adminUsers: []
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
    // A push-notification tap while a tab is open: the service worker
    // focuses it and asks it to navigate to the conversation.
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'orion-navigate') {
        if (route() !== 'chat') location.hash = '#/chat';
        else renderChat();
      }
    });
  });
}

/* ---------- boot ---------- */
async function boot() {
  onUnauthorized = () => {
    S.me = null;
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

function renderAuth() {
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
function scrollBottom(force) {
  const box = $('#messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || near) box.scrollTop = box.scrollHeight;
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const empty = $('#empty-state');
  empty.hidden = S.messages.length > 0;
  for (const m of S.messages) box.appendChild(messageEl(m));
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
});

function messageEl(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
  wrap.dataset.mid = m.id || '';
  if (m.role === 'user') {
    wrap.innerHTML = `<div class="bubble">${md(m.content)}</div>`;
  } else {
    wrap.innerHTML = `
      <div class="a-avatar">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="5.5" fill="url(#orion-grad)"/>
          <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(-24 16 16)" fill="none" stroke="url(#orion-grad)" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="a-body">
        <div class="tools"></div>
        <div class="content">${m.content ? md(m.content) : ''}</div>
        <div class="imgs">${(m.attachments || []).map(attachmentHtml).join('')}</div>
      </div>`;
  }
  return wrap;
}

function appendUserMessage(content) {
  const m = { id: 'local-' + Date.now(), role: 'user', content };
  S.messages.push(m);
  $('#messages').appendChild(messageEl(m));
  $('#empty-state').hidden = true;
  scrollBottom(true);
  return m;
}

/* ---------- user chip + menu ---------- */
function renderUserChip() {
  const me = S.me;
  $('#user-avatar').textContent = (me.username[0] || '?').toUpperCase();
  $('#menu-admin').hidden = me.role !== 'admin';
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
      S.me = null; S.activeId = null; S.messages = [];
      go('login');
    } else if (act === 'settings') go('settings');
    else if (act === 'password') changePasswordModal();
    else if (act === 'sandbox') resetSandboxModal();
    else if (act === 'admin') go('admin');
  });
}
function closeUserMenu() { const m = $('#user-menu'); if (m) m.hidden = true; }

function changePasswordModal() {
  const bd = openModal(`
    <h3>Change password</h3>
    <p class="muted">Choose a new password for <b>${esc(S.me.username)}</b>.</p>
    <form id="pw-form">
      <label class="field"><span>New password</span>
        <input id="pw-new" type="password" autocomplete="new-password" required minlength="1">
      </label>
      <label class="field"><span>Confirm new password</span>
        <input id="pw-confirm" type="password" autocomplete="new-password" required minlength="1">
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
    const p1 = bd.querySelector('#pw-new').value;
    const p2 = bd.querySelector('#pw-confirm').value;
    const err = bd.querySelector('#pw-error');
    if (p1 !== p2) { err.textContent = 'Passwords don\u2019t match.'; err.hidden = false; return; }
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { password: p1 } });
      closeModal();
      toast('Password changed');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

async function resetSandboxModal() {
  const ok = await confirmDialog({
    title: 'Reset sandbox?',
    message: 'This wipes your agent\u2019s VM and files, then starts it fresh. Your chats are kept.',
    confirmLabel: 'Reset sandbox',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/api/sandbox/reset', { method: 'POST' });
    toast('Sandbox reset');
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------- chat view entry ---------- */
let chatWired = false;
async function renderChat() {
  renderUserChip();
  if (!chatWired) { wireChat(); chatWired = true; }
  wireUserMenuOnce();
  // One main chat: fetch (or create) it, then subscribe to its event bus.
  if (!S.activeId) {
    const box = $('#messages');
    box.innerHTML = '<div class="skel" style="max-width:60%"></div><div class="skel" style="max-width:80%;margin-left:auto"></div>';
    $('#empty-state').hidden = true;
    try {
      const data = await api('/api/chat');
      S.activeId = data.conversation.id;
      S.messages = data.messages || [];
    } catch {
      box.innerHTML = `<div class="conv-empty">Couldn't load the chat.</div>`;
      return;
    }
  }
  renderMessages();
  openEventStream(S.activeId);
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

  // Auto-grow, Enter to send.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    updateComposer();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  $('#stop-btn').addEventListener('click', stopStream);

  updateComposer();
}

function updateComposer() {
  const input = $('#composer-input');
  const hasText = input.value.trim().length > 0;
  // Sending mid-run is allowed — the message is queued server-side.
  // Keep the send button visible/enabled based on text even while a run is
  // active; the stop button appears alongside it.
  $('#send-btn').disabled = !hasText;
  $('#send-btn').hidden = false;
  $('#stop-btn').hidden = !S.runActive;
}

async function sendMessage() {
  const input = $('#composer-input');
  const content = input.value.trim();
  if (!content) return;

  // Ensure the main chat is loaded before posting into it.
  if (!S.activeId) {
    try {
      const data = await api('/api/chat');
      S.activeId = data.conversation.id;
      S.messages = data.messages || [];
      renderMessages();
      openEventStream(S.activeId);
    } catch (e) { toast(e.message, 'error'); return; }
  }
  const convId = S.activeId;

  input.value = '';
  input.style.height = 'auto';
  updateComposer();

  // Optimistic bubble, reconciled with the real row id below. The server
  // also publishes the row on the bus, which can arrive before the POST
  // response — upsertMessage dedupes by id either way.
  const local = appendUserMessage(content);

  let resp;
  try {
    resp = await api(`/api/conversations/${convId}/messages`, { method: 'POST', body: { content } });
  } catch (e) {
    removeMessage(local);
    input.value = content; // restore the draft
    updateComposer();
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
    await api(`/api/conversations/${S.activeId}/stop`, { method: 'POST' });
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
  if (S.messages.some((x) => x.id === real.id)) { removeMessage(local); return; }
  const el = msgElById(local.id);
  local.id = real.id;
  local.content = real.content;
  local.created_at = real.created_at;
  if (el) el.dataset.mid = String(real.id);
}

function paintContent(msg) {
  const contentEl = msgElById(msg.id)?.querySelector('.content');
  if (contentEl) contentEl.innerHTML = md(msg.content || '');
}

function setRunActive(on) {
  S.runActive = on;
  if (!on) {
    for (const id of S.liveIds) {
      const el = msgElById(id);
      el?.querySelector('.typing-dots')?.remove();
      el?.querySelector('.content')?.classList.remove('caret');
    }
    S.liveIds.clear();
    loadConversationsQuiet(); // pick up the server-side title
  }
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
  es.addEventListener('message', (e) => onBusMessage(parseBusEvent(e)?.message));
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
    S.messages = data.messages || [];
    S.buffers.clear();
    S.toolRows.clear();
    renderMessages(); // live state re-derives from hello + subsequent events
  } catch { /* the next backoff tick retries */ }
}

function onBusMessage(m) {
  if (!m || m.id == null || S.activeId == null) return;
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
    msg = { id: m.id, role: m.role, content: m.content || '', attachments: m.attachments || [] };
    S.messages.push(msg);
    $('#messages').appendChild(messageEl(msg));
    $('#empty-state').hidden = true;
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
  scrollBottom();
}

function onBusToken(d) {
  if (!d || d.message_id == null) return;
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
  scrollBottom();
}

function onBusTool(d) {
  if (!d || d.message_id == null) return;
  const toolsEl = msgElById(d.message_id)?.querySelector('.tools');
  if (!toolsEl) return;
  let rows = S.toolRows.get(d.message_id);
  if (!rows) { rows = []; S.toolRows.set(d.message_id, rows); }
  let row = [...rows].reverse().find((r) => r.name === d.name && r.open);
  if (!row) {
    const div = document.createElement('div');
    div.className = 'tool-row';
    div.innerHTML = `
      <button class="tool-head" type="button">
        <span class="dot running"></span>
        <span class="tname">⚙ ${esc(d.name || 'tool')}</span>
        <span class="tsummary"></span>
        <span class="tchev">▾</span>
      </button>
      <div class="tool-detail"></div>`;
    div.querySelector('.tool-head').addEventListener('click', () => div.classList.toggle('open'));
    toolsEl.appendChild(div);
    row = { name: d.name, el: div, open: true };
    rows.push(row);
  }
  const dot = row.el.querySelector('.dot');
  const sum = row.el.querySelector('.tsummary');
  const detail = row.el.querySelector('.tool-detail');
  const summary = d.summary || (d.args ? String(d.args).slice(0, 120) : '');
  if (summary) { sum.textContent = summary; detail.textContent = summary; }
  if (d.status === 'done') {
    dot.classList.remove('running');
    dot.classList.add('done');
    row.open = false;
    if (d.result_summary) detail.textContent = d.result_summary;
  } else {
    sum.textContent = sum.textContent || 'Running…';
  }
  scrollBottom();
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
  scrollBottom();
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
  $('#set-signup').checked = !!s.signup_enabled;
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
      S.adminSettings = await api('/api/admin/settings', { method: 'PUT', body });
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
    const usageText = `${fmtTokens(used)} / ${lim === null || lim === undefined ? '∞' : fmtTokens(lim)}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="u-name ${u.disabled ? 'u-disabled' : ''}">
        <span class="avatar">${esc((u.username[0] || '?').toUpperCase())}</span>${esc(u.username)}
      </span></td>
      <td>
        <span class="pill ${u.role === 'admin' ? 'admin' : 'user'}">${esc(u.role)}</span>
        ${u.disabled ? '<span class="pill off">disabled</span>' : ''}
        ${u.abuse_locked ? `<span class="pill danger" title="${esc(u.abuse_reason || 'locked for abuse')}">locked</span>` : ''}
      </td>
      <td class="muted">${Number(u.message_count) || 0}</td>
      <td class="muted" title="tokens used this week / weekly limit">${esc(usageText)}</td>
      <td class="muted">${esc(fmtDate(u.created_at))}</td>
      <td><div class="u-actions"></div></td>`;
    const acts = tr.querySelector('.u-actions');

    const mkBtn = (label, fn, { danger = false, disabled = false } = {}) => {
      const b = document.createElement('button');
      b.className = 'link-btn' + (danger ? ' danger' : '');
      b.textContent = label;
      b.disabled = disabled;
      b.onclick = fn;
      acts.appendChild(b);
    };

    mkBtn(u.role === 'admin' ? 'Remove admin' : 'Make admin', async () => {
      try {
        await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'user' : 'admin' } });
        await loadAdminUsers();
        toast(`${u.username} is ${u.role === 'admin' ? 'no longer' : 'now'} an admin`);
      } catch (e) { toast(e.message, 'error'); }
    }, { disabled: isSelf });

    mkBtn(u.disabled ? 'Enable' : 'Disable', async () => {
      try {
        await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } });
        await loadAdminUsers();
        toast(u.disabled ? `${u.username} enabled` : `${u.username} disabled`);
      } catch (e) { toast(e.message, 'error'); }
    }, { disabled: isSelf });

    mkBtn('Limit', async () => {
      const cur = u.weekly_token_limit;
      const v = window.prompt(
        `Weekly token limit for ${u.username} (tokens). Empty = unlimited.`,
        cur === null || cur === undefined ? '' : String(cur)
      );
      if (v === null) return; // cancelled
      try {
        const body = v.trim() === '' ? { weekly_token_limit: null } : { weekly_token_limit: Number(v) };
        await api(`/api/admin/users/${u.id}/limit`, { method: 'PATCH', body });
        await loadAdminUsers();
        toast(`Limit updated for ${u.username}`);
      } catch (e) { toast(e.message, 'error'); }
    });

    mkBtn('Reset usage', async () => {
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

    mkBtn('Delete', async () => {
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
    }, { danger: true, disabled: isSelf });

    body.appendChild(tr);
  }
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
    const d = await api('/api/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ challenge: _twofaChallenge, code }) });
    if (d.need_2fa) {
      show2faStep(d.challenge);
      errEl.textContent = 'Try again — that code didn’t match.';
      errEl.hidden = false;
      return;
    }
    S.me = d.user;

    S.activeId = null;
    S.messages = [];
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
    const d = await api('/api/auth/passkey/login/verify', { method: 'POST', body: JSON.stringify({ token, response: webauthnCredToJson(cred) }) });
    S.me = d;

    S.activeId = null;
    S.messages = [];
    go('chat');
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return; // user cancelled
    errEl.textContent = err.message || 'Passkey sign-in failed.';
    errEl.hidden = false;
  }
}

/* ---------- settings ---------- */
const SETTINGS_TABS = ['security', 'sessions', 'heartbeat', 'notifications'];
let _settingsTab = 'security';
let _twofaStatus = null;
let _passkeys = null;

async function renderSettings() {
  document.querySelectorAll('.settings-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === _settingsTab));
  for (const t of SETTINGS_TABS) {
    const el = document.getElementById('set-panel-' + t);
    if (el) el.hidden = t !== _settingsTab;
  }
  if (_settingsTab === 'security') renderSecurityTab();
  else if (_settingsTab === 'sessions') renderSessionsTab();
  else if (_settingsTab === 'heartbeat') renderHeartbeatTab();
  else if (_settingsTab === 'notifications') renderNotificationsTab();
}
function wireSettings() {
  document.querySelectorAll('.settings-tab').forEach(t => {
    t.onclick = () => { _settingsTab = t.dataset.tab; renderSettings(); };
  });
  wireSessionsTab();
  wireHeartbeatTab();
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
    const wrap = $('#twofa-setup');
    wrap.hidden = false;
    $('#twofa-setup-btn').hidden = true;
    try {
      const d = await api('/api/auth/2fa/setup', { method: 'POST' });
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
          const r = await api('/api/auth/2fa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
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
    await api('/api/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ password: pw }) });
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
  const name = prompt('Name this passkey (e.g. “iPhone”):', '') ?? '';
  try {
    const { token, options } = await api('/api/auth/passkey/register/options', { method: 'POST' });
    const cred = await navigator.credentials.create({ publicKey: webauthnOptionsFromJson(options) });
    await api('/api/auth/passkey/register/verify', {
      method: 'POST',
      body: JSON.stringify({ token, response: webauthnCredToJson(cred), name: name.trim() || undefined }),
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

/* ----- heartbeat ----- */
function wireHeartbeatTab() {
  $('#heartbeat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#hb-saved').hidden = true;
    const body = {
      enabled: $('#hb-enabled').checked,
      prompt: $('#hb-prompt').value.trim(),
    };
    try {
      await api('/api/heartbeat', { method: 'PUT', body: JSON.stringify(body) });
      $('#hb-saved').hidden = false;
      setTimeout(() => { $('#hb-saved').hidden = true; }, 2500);
    } catch (err) { toast('Save failed: ' + err.message); }
  });
}
async function renderHeartbeatTab() {
  $('#hb-saved').hidden = true;
  try {
    const d = await api('/api/heartbeat');
    const hb = d.heartbeat || d;
    $('#hb-enabled').checked = !!hb.enabled;
    $('#hb-prompt').value = hb.prompt || '';
  } catch (err) {
    toast('Couldn’t load heartbeat: ' + err.message);
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
