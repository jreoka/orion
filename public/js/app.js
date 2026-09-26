/* ============================================================
   Orion — single-page app
   Vanilla JS. Hash routing: #/login, #/chat, #/admin.
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
  conversations: [],
  activeId: null,
  messages: [],        // [{id, role, content, attachments}]
  streaming: false,
  aborter: null,
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
const ROUTES = ['login', 'chat', 'admin'];
const VIEW_ID = { login: 'view-auth', chat: 'view-chat', admin: 'view-admin' };
function route() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.includes(h) ? h : 'chat';
}
function go(r) { location.hash = '#/' + r; }

async function render() {
  const r = route();
  if (!S.me && r !== 'login') { go('login'); return; }
  if (S.me && r === 'login') { go('chat'); return; }
  if (r === 'admin' && S.me && S.me.role !== 'admin') { go('chat'); return; }
  for (const v of ROUTES) $('#' + VIEW_ID[v]).hidden = v !== r;
  closeSidebar();
  if (r === 'login') renderAuth();
  else if (r === 'chat') renderChat();
  else if (r === 'admin') renderAdmin();
}
window.addEventListener('hashchange', render);

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
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
}

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-signup').classList.toggle('active', mode === 'signup');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('#auth-error').hidden = true;
}

function wireGlobal() {
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
      S.me = await api(authMode === 'login' ? '/api/auth/login' : '/api/auth/signup', {
        method: 'POST', body: { username, password }
      });
      $('#auth-password').value = '';
      go('chat');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // Sidebar drawer (mobile)
  $('#hamburger').onclick = openSidebar;
  $('#sidebar-close').onclick = closeSidebar;
  $('#sidebar-backdrop').onclick = closeSidebar;
  $('#new-chat-mobile').onclick = () => { newConversation(); };

  // Image lightbox
  $('#lightbox-close').onclick = () => { $('#lightbox').hidden = true; };
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#lightbox').hidden = true; closeModal(); closeUserMenu(); }
  });
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebar-backdrop').hidden = false;
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  const bd = $('#sidebar-backdrop');
  if (bd) bd.hidden = true;
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

/* ---------- conversation list ---------- */
async function loadConversations() {
  const list = $('#conv-list');
  list.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  try {
    S.conversations = (await api('/api/conversations')) || [];
  } catch (e) {
    list.innerHTML = `<div class="conv-empty">Couldn't load chats.</div>`;
    return;
  }
  renderConvList();
}

function renderConvList() {
  const list = $('#conv-list');
  if (!S.conversations.length) {
    list.innerHTML = `<div class="conv-empty">No chats yet.<br>Start one below.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const c of S.conversations) {
    const el = document.createElement('div');
    el.className = 'conv-item' + (c.id === S.activeId ? ' active' : '');
    el.innerHTML = `<span class="conv-title">${esc(c.title || 'New chat')}</span><button class="conv-del" title="Delete chat">✕</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.conv-del')) return;
      openConversation(c.id);
    });
    const del = el.querySelector('.conv-del');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = 'Sure?';
        setTimeout(() => { del.classList.remove('confirm'); del.textContent = '✕'; }, 2500);
        return;
      }
      try {
        await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
        S.conversations = S.conversations.filter((x) => x.id !== c.id);
        if (S.activeId === c.id) { S.activeId = null; S.messages = []; }
        renderConvList();
        renderMessages();
        toast('Chat deleted');
      } catch (ex) { toast(ex.message, 'error'); }
    });
    list.appendChild(el);
  }
  list.scrollTop = 0;
}

async function newConversation() {
  if (S.streaming) return;
  try {
    const c = await api('/api/conversations', { method: 'POST', body: {} });
    S.conversations.unshift(c);
    S.activeId = c.id;
    S.messages = [];
    renderConvList();
    renderMessages();
    $('#composer-input').focus();
  } catch (e) { toast(e.message, 'error'); }
}

async function openConversation(id) {
  if (S.streaming) stopStream();
  S.activeId = id;
  renderConvList();
  const box = $('#messages');
  box.innerHTML = '<div class="skel" style="max-width:60%"></div><div class="skel" style="max-width:80%;margin-left:auto"></div>';
  $('#empty-state').hidden = true;
  try {
    const data = await api(`/api/conversations/${id}`);
    if (!data) return; // session expired mid-load; boot() already redirected
    S.messages = data.messages || [];
    // Sync title in case it changed server-side.
    const c = S.conversations.find((x) => x.id === id);
    if (c && data.conversation) c.title = data.conversation.title;
    renderConvList();
  } catch (e) {
    box.innerHTML = `<div class="conv-empty">Couldn't load this chat.</div>`;
    return;
  }
  renderMessages();
  closeSidebar();
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
  $('#user-name').textContent = me.username;
  $('#user-avatar').textContent = (me.username[0] || '?').toUpperCase();
  const badge = $('#user-role');
  badge.hidden = me.role !== 'admin';
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
      S.me = null; S.conversations = []; S.activeId = null; S.messages = [];
      go('login');
    } else if (act === 'password') changePasswordModal();
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
  await loadConversations();
  // Deep-link or resume: pick the newest conversation, or start fresh.
  if (!S.activeId && S.conversations.length) {
    S.activeId = S.conversations[0].id;
    try {
      const data = await api(`/api/conversations/${S.activeId}`);
      S.messages = data.messages || [];
    } catch { S.messages = []; }
  }
  renderConvList();
  renderMessages();
  updateComposer();
}

let userMenuWired = false;
function wireUserMenuOnce() { if (!userMenuWired) { wireUserMenu(); userMenuWired = true; } }

/* ============================================================
   Composer + SSE streaming
   The reply arrives as `event: <type>` / `data: <json>` frames
   over a POST stream (fetch + ReadableStream, so we can abort).
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
  $('#new-chat').onclick = newConversation;

  // Suggestion chips fill the composer.
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-suggest]');
    if (!chip) return;
    input.value = chip.dataset.suggest;
    input.dispatchEvent(new Event('input'));
    input.focus();
  });

  updateComposer();
}

function updateComposer() {
  const input = $('#composer-input');
  const hasText = input.value.trim().length > 0;
  $('#send-btn').disabled = !hasText || S.streaming;
  $('#send-btn').hidden = S.streaming;
  $('#stop-btn').hidden = !S.streaming;
}

async function sendMessage() {
  const input = $('#composer-input');
  const content = input.value.trim();
  if (!content || S.streaming) return;

  // Ensure there's a conversation to post into.
  if (!S.activeId) {
    try {
      const c = await api('/api/conversations', { method: 'POST', body: {} });
      S.conversations.unshift(c);
      S.activeId = c.id;
      renderConvList();
    } catch (e) { toast(e.message, 'error'); return; }
  }

  input.value = '';
  input.style.height = 'auto';
  appendUserMessage(content);
  updateComposer();
  closeSidebar();

  // Assistant placeholder the stream writes into.
  const aMsg = { id: 'stream-' + Date.now(), role: 'assistant', content: '', attachments: [] };
  S.messages.push(aMsg);
  const el = messageEl(aMsg);
  $('#messages').appendChild(el);
  $('#empty-state').hidden = true;
  const contentEl = el.querySelector('.content');
  const toolsEl = el.querySelector('.tools');
  const imgsEl = el.querySelector('.imgs');
  contentEl.classList.add('caret');
  scrollBottom(true);

  S.streaming = true;
  S.aborter = new AbortController();
  updateComposer();

  let text = '';
  const toolRows = []; // {name, el, detail}

  const upsertTool = (name, status, summary) => {
    let row = [...toolRows].reverse().find((r) => r.name === name && r.open);
    if (!row) {
      const div = document.createElement('div');
      div.className = 'tool-row';
      div.innerHTML = `
        <button class="tool-head" type="button">
          <span class="dot running"></span>
          <span class="tname">⚙ ${esc(name)}</span>
          <span class="tsummary"></span>
          <span class="tchev">▾</span>
        </button>
        <div class="tool-detail"></div>`;
      div.querySelector('.tool-head').addEventListener('click', () => div.classList.toggle('open'));
      toolsEl.appendChild(div);
      row = { name, el: div, open: true };
      toolRows.push(row);
    }
    const dot = row.el.querySelector('.dot');
    const sum = row.el.querySelector('.tsummary');
    const detail = row.el.querySelector('.tool-detail');
    if (summary) { sum.textContent = summary; detail.textContent = summary; }
    if (status === 'done') {
      dot.classList.remove('running');
      dot.classList.add('done');
      row.open = false;
    } else {
      sum.textContent = sum.textContent || 'Running…';
    }
    scrollBottom();
  };

  const finish = () => {
    contentEl.classList.remove('caret');
    S.streaming = false;
    S.aborter = null;
    aMsg.content = text;
    updateComposer();
    scrollBottom(true);
    // Pick up the server-side title (and ordering) after a reply.
    loadConversationsQuiet();
  };

  try {
    await streamEvents(`/api/conversations/${S.activeId}/messages`, content, S.aborter.signal, {
      token: (d) => {
        text += d.text || '';
        contentEl.innerHTML = md(text);
        contentEl.classList.add('caret');
        scrollBottom();
      },
      tool: (d) => upsertTool(d.name || 'tool', d.status, d.summary),
      image: (d) => {
        if (!d.url) return;
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = d.url;
        img.alt = d.filename || 'image';
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(d.url));
        imgsEl.appendChild(img);
        (aMsg.attachments = aMsg.attachments || []).push({ url: d.url, filename: d.filename });
        scrollBottom();
      },
      error: (d) => {
        contentEl.classList.remove('caret');
        contentEl.innerHTML = `<div class="msg-error">${esc(d.message || 'Something went wrong.')}</div>`;
      }
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      // Stopped by the user — keep the partial reply.
    } else {
      contentEl.classList.remove('caret');
      contentEl.innerHTML = `<div class="msg-error">${esc(e.message || 'Connection failed.')}</div>`;
    }
  } finally {
    finish();
  }
}

function stopStream() {
  if (S.aborter) S.aborter.abort();
}

// Refresh the sidebar list without the skeleton flash.
async function loadConversationsQuiet() {
  try {
    S.conversations = await api('/api/conversations');
    renderConvList();
  } catch { /* non-fatal */ }
}

/* Parse SSE frames: `event: <type>\ndata: <json>\n\n`.
   Frames can split across network chunks, so buffer and scan for \n\n. */
async function streamEvents(url, content, signal, handlers) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const d = await res.json(); msg = d.error || d.message || msg; } catch {}
    throw new Error(msg);
  }
  if (!res.body) throw new Error('Streaming not supported in this browser.');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const handleFrame = (frame) => {
    let ev = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5));
    }
    const raw = dataLines.join('\n').trim();
    if (!raw || ev === 'message') return;
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { return; }
    const fn = handlers[ev];
    if (fn) fn(data);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  buf += dec.decode();
  if (buf.trim()) handleFrame(buf);
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
  body.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
  try {
    S.adminUsers = await api('/api/admin/users');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" class="muted">Couldn't load users.</td></tr>`;
    return;
  }
  renderAdminUsers();
}

function renderAdminUsers() {
  const body = $('#users-body');
  body.innerHTML = '';
  if (!S.adminUsers.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">No users yet.</td></tr>`;
    return;
  }
  for (const u of S.adminUsers) {
    const isSelf = S.me && u.id === S.me.id;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="u-name ${u.disabled ? 'u-disabled' : ''}">
        <span class="avatar">${esc((u.username[0] || '?').toUpperCase())}</span>${esc(u.username)}
      </span></td>
      <td>
        <span class="pill ${u.role === 'admin' ? 'admin' : 'user'}">${esc(u.role)}</span>
        ${u.disabled ? '<span class="pill off">disabled</span>' : ''}
      </td>
      <td class="muted">${Number(u.message_count) || 0}</td>
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
