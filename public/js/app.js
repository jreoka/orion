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
const ROUTES = ['login', 'chat', 'admin', 'settings'];
const VIEW_ID = { login: 'view-auth', chat: 'view-chat', admin: 'view-admin', settings: 'view-settings' };
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
  for (const v of ROUTES) { const el = document.getElementById(VIEW_ID[v]); if (el) el.hidden = v !== r; }
  closeSidebar();
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
    el.innerHTML = `<span class="conv-title">${esc(c.title || 'New chat')}</span><button class="conv-edit" title="Rename chat">✎</button><button class="conv-del" title="Delete chat">✕</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.conv-del') || e.target.closest('.conv-edit') || e.target.closest('.conv-rename')) return;
      openConversation(c.id);
    });
    el.querySelector('.conv-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(c, el);
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
    S.conversations = [];
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
    const { options } = await api('/api/auth/passkey/login/options', { method: 'POST' });
    const cred = await navigator.credentials.get({ publicKey: webauthnOptionsFromJson(options) });
    const d = await api('/api/auth/passkey/login/verify', { method: 'POST', body: JSON.stringify(webauthnCredToJson(cred)) });
    if (d.need_2fa) { show2faStep(d.challenge); return; }
    S.me = d.user;
    S.conversations = [];
    S.activeId = null;
    S.messages = [];
    go('chat');
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return; // user cancelled
    errEl.textContent = err.message || 'Passkey sign-in failed.';
    errEl.hidden = false;
  }
}

/* ---------- conversation rename ---------- */
function startRename(c, el) {
  const titleEl = el.querySelector('.conv-title');
  const old = c.title || 'New chat';
  const input = document.createElement('input');
  input.className = 'conv-rename';
  input.value = old;
  titleEl.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save && val && val !== old) {
      try {
        const d = await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ title: val }) });
        c.title = d.title || val;
      } catch (err) { toast('Rename failed: ' + err.message); }
    }
    renderConvList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}


/* ---------- settings ---------- */
const SETTINGS_TABS = ['security', 'sessions', 'tasks', 'heartbeat'];
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
  else if (_settingsTab === 'tasks') renderTasksTab();
  else if (_settingsTab === 'heartbeat') renderHeartbeatTab();
}
function wireSettings() {
  document.querySelectorAll('.settings-tab').forEach(t => {
    t.onclick = () => { _settingsTab = t.dataset.tab; renderSettings(); };
  });
  wireSessionsTab();
  wireTasksTab();
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
    const d = await api('/api/auth/passkey/list');
    _passkeys = d.passkeys || [];
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
          await api(`/api/auth/passkey/${pk.id}`, { method: 'DELETE' });
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
    const { options } = await api('/api/auth/passkey/register/options', { method: 'POST' });
    const cred = await navigator.credentials.create({ publicKey: webauthnOptionsFromJson(options) });
    await api('/api/auth/passkey/register/verify', {
      method: 'POST',
      body: JSON.stringify({ ...webauthnCredToJson(cred), name: name.trim() || undefined }),
    });
    const d = await api('/api/auth/passkey/list');
    _passkeys = d.passkeys || [];
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
    const sessions = d.sessions || [];
    if (!sessions.length) { box.innerHTML = '<p class="muted">No sessions.</p>'; return; }
    box.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.innerHTML = `
        <div class="row-main">
          <span class="row-title">${s.is_current ? '<span class="badge ok">This device</span> ' : ''}${esc(truncUA(s.user_agent, 40) || 'Unknown device')}</span>
          <span class="row-sub">${esc(s.ip || '')} · last active ${esc(fmtDateTime(s.last_active_at || s.created_at))}</span>
        </div>
        ${s.is_current ? '' : '<button class="btn small danger">Revoke</button>'}`;
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

/* ----- tasks ----- */
function wireTasksTab() {
  document.querySelectorAll('input[name="task-kind"]').forEach(r => {
    r.addEventListener('change', () => {
      const kind = document.querySelector('input[name="task-kind"]:checked').value;
      $('#task-cron-wrap').hidden = kind !== 'cron';
      $('#task-once-wrap').hidden = kind !== 'once';
    });
  });
  document.querySelectorAll('#cron-presets .chip').forEach(ch => {
    ch.onclick = () => {
      $('#task-cron').value = ch.dataset.cron;
      document.querySelectorAll('#cron-presets .chip').forEach(c => c.classList.remove('active'));
      ch.classList.add('active');
    };
  });
  $('#task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#task-name').value.trim();
    const prompt = $('#task-prompt').value.trim();
    if (!name || !prompt) { toast('Name and prompt are required'); return; }
    const kind = document.querySelector('input[name="task-kind"]:checked').value;
    const body = { name, prompt };
    if (kind === 'once') {
      const at = $('#task-runat').value;
      if (!at) { toast('Pick a date and time'); return; }
      body.run_at = new Date(at).toISOString();
    } else {
      body.cron = $('#task-cron').value.trim();
      if (!body.cron) { toast('Enter a cron expression'); return; }
    }
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      $('#task-name').value = '';
      $('#task-prompt').value = '';
      $('#task-runat').value = '';
      await renderTasksTab();
      toast('Task created');
    } catch (err) { toast('Create failed: ' + err.message); }
  });
}
function taskScheduleLabel(t) {
  if (t.run_at && !t.cron) return 'once · ' + fmtDateTime(t.run_at);
  if (t.cron) {
    const presets = { '0 * * * *': 'hourly', '0 9 * * *': 'daily 9am', '0 9 * * 1': 'weekly Mon 9am' };
    return 'repeats · ' + (presets[t.cron] || t.cron);
  }
  return t.run_at ? 'once · ' + fmtDateTime(t.run_at) : '';
}
async function renderTasksTab() {
  const box = $('#tasks-box');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api('/api/tasks');
    const tasks = d.tasks || [];
    if (!tasks.length) { box.innerHTML = '<p class="muted">No scheduled tasks yet.</p>'; return; }
    box.innerHTML = '';
    for (const t of tasks) {
      const row = document.createElement('div');
      row.className = 'row-item task-row' + (t.enabled ? '' : ' disabled');
      row.innerHTML = `
        <label class="toggle" title="Enable/disable"><input type="checkbox"${t.enabled ? ' checked' : ''}><span class="knob"></span></label>
        <div class="row-main">
          <span class="row-title">${esc(t.name)}</span>
          <span class="row-sub">${esc(taskScheduleLabel(t))}${t.last_run_at ? ' · last ran ' + esc(fmtDateTime(t.last_run_at)) : ''}${t.last_status ? ' · ' + esc(t.last_status) : ''}</span>
        </div>
        <button class="btn small run">Run now</button>
        <button class="btn small danger del">Delete</button>`;
      row.querySelector('input').onchange = async (e) => {
        try {
          await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) });
          t.enabled = e.target.checked;
          row.classList.toggle('disabled', !t.enabled);
        } catch (err) { toast('Update failed: ' + err.message); e.target.checked = t.enabled; }
      };
      row.querySelector('.run').onclick = async () => {
        try { await api(`/api/tasks/${t.id}/run`, { method: 'POST' }); toast('Task run started'); renderTasksTab(); }
        catch (err) { toast('Run failed: ' + err.message); }
      };
      row.querySelector('.del').onclick = async () => {
        if (!await confirmDialog({ title: 'Delete task', message: `Delete “${t.name}”?`, confirmLabel: 'Delete', danger: true })) return;
        try { await api(`/api/tasks/${t.id}`, { method: 'DELETE' }); renderTasksTab(); }
        catch (err) { toast('Delete failed: ' + err.message); }
      };
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
      interval_hours: parseInt($('#hb-interval').value, 10),
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
    if (hb.interval_hours) $('#hb-interval').value = String(hb.interval_hours);
    $('#hb-prompt').value = hb.prompt || '';
  } catch (err) {
    toast('Couldn’t load heartbeat: ' + err.message);
  }
}
