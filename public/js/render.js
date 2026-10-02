/* Shared message rendering — used by the main chat (app.js) and the public
   share page (share.html). Anything here renders identically in both places:
   change it once and both stay in sync. Pure functions only: input -> HTML
   string, or DOM operations on passed-in nodes. Depends on markdown.js
   (esc, md) — load markdown.js before this file. */

/* ---------- attachments ---------- */

function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '');
}

const SVG_CLIP = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><path d="M11.5 7.5 6.8 12.2a2.1 2.1 0 0 1-3-3l5.7-5.7a3.5 3.5 0 0 1 5 5l-5.7 5.7a4.9 4.9 0 0 1-7-7l5.2-5.2"/></svg>';

function attachmentHtml(a) {
  if (isImageFile(a.filename)) {
    return `<img class="msg-img" src="${esc(a.url)}" alt="${esc(a.filename || 'image')}" loading="lazy">`;
  }
  return `<a class="chip file-chip" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" download="${esc(a.filename || '')}">${SVG_CLIP}<span>${esc(a.filename || 'file')}</span></a>`;
}

/* ---------- quote-reply ---------- */

function quoteHtml(m) {
  const q = m.reply_to_message;
  if (!q) return '';
  const who = q.role === 'assistant' ? 'Orion' : 'You';
  const excerpt = String(q.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 140) || '[attachment]';
  return `<button class="quote" data-quote="${q.id}" title="Jump to quoted message"><span class="quote-who">${esc(who)}</span><span class="quote-text">${esc(excerpt)}</span></button>`;
}

/* ---------- message action row ---------- */

// The copy button on its own — shared by the full row and the share page's
// copy-only row.
function copyButtonHtml() {
  return `<button class="rx-copy" data-copy aria-label="Copy message" title="Copy"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg></button>`;
}

function rxChipHtml(r) {
  return `<button class="rx-chip${r.mine ? ' mine' : ''}" data-rx="${esc(r.emoji)}" aria-label="Toggle ${esc(r.emoji)} reaction" title="${esc(r.agent ? 'Reacted by Orion' : 'Reacted by you')}">${esc(r.emoji)}${r.count > 1 ? `<span class="rx-n">${r.count}</span>` : ''}</button>`;
}

// Full interactive row for the main chat; pass { copyOnly: true } for the
// read-only share page (no reaction chips, no reply button).
function rxRowInner(m, opts) {
  if (opts && opts.copyOnly) return copyButtonHtml();
  const chips = (m.reactions || []).map(rxChipHtml).join('');
  return `${chips}<button class="rx-reply" data-reply aria-label="Reply to message" title="Reply"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5 3 7l3.5 3.5"/><path d="M3.5 7H10a3.5 3.5 0 0 1 0 7H8.5"/></svg></button>${copyButtonHtml()}<button class="rx-add" data-rxadd aria-label="Add reaction" title="Add reaction"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></button>`;
}

/* ---------- message bodies ---------- */

const LOGO_SVG = '<svg viewBox="0 0 490 490"><g class="logo-drift"><path d="M28.0,70.0L31.0,70.0L229.0,268.0L419.0,458.0L419.0,461.0L404.0,465.0L84.0,465.0L59.0,457.0L40.0,441.0L28.0,421.0L24.0,400.0L25.0,286.0L129.0,388.0L133.0,388.0L168.0,353.0L168.0,350.0L26.0,208.0L24.0,89.0L28.0,70.0Z" fill="#6974bc"/><path d="M92.0,25.0L412.0,26.0L429.0,32.0L451.0,50.0L461.0,69.0L465.0,88.0L465.0,203.0L461.0,203.0L450.0,193.0L359.0,101.0L356.0,101.0L321.0,136.0L321.0,139.0L465.0,284.0L465.0,403.0L461.0,419.0L458.0,419.0L70.0,31.0L70.0,28.0L77.0,26.0L92.0,25.0Z" fill="#6974bc"/></g></svg>';

// Inner HTML of .msg.user > .bubble
function userBubbleHtml(m, opts) {
  const hasText = !!(m.content && String(m.content).trim());
  const imgs = (m.attachments || []).length
    ? `<div class="u-imgs${hasText ? '' : ' no-text'}">${(m.attachments || []).map(attachmentHtml).join('')}</div>` : '';
  return `<div class="bubble">${quoteHtml(m)}${hasText ? md(m.content) : ''}${imgs}<div class="rx-row" data-rxrow>${rxRowInner(m, opts)}</div></div>`;
}

// Inner HTML of .msg.assistant (avatar + body)
function assistantBodyHtml(m, opts) {
  // Plan approval card: detect via pending_plan_id (live) or [plan:ID] prefix (history)
  let planId = m.pending_plan_id;
  if (!planId && m.content) {
    const pm = /^\[plan:(\d+)\]/.exec(m.content);
    if (pm) planId = pm[1];
  }
  if (planId) {
    return `
      <div class="a-avatar">
        <span class="logo-glyph" aria-hidden="true">${LOGO_SVG}</span>
      </div>
      <div class="a-body">
        <div class="content"><div class="plan-card" data-plan-id="${planId}">
          <div class="plan-loading">Loading plan…</div>
        </div></div>
        <div class="rx-row" data-rxrow>${rxRowInner(m, opts)}</div>
      </div>`;
  }
  // Mid-run question: render options as tappable buttons
  if (m.pending_question_id && m.question_options && m.question_options.length) {
    const opts = m.question_options.map((o, i) =>
      `<button class="btn small q-opt" data-qid="${m.pending_question_id}" data-opt="${i}">${escapeHtml(o)}</button>`
    ).join('');
    return `
      <div class="a-avatar">
        <span class="logo-glyph" aria-hidden="true">${LOGO_SVG}</span>
      </div>
      <div class="a-body">
        ${quoteHtml(m)}
        <div class="content">${m.content ? md(m.content) : ''}<div class="q-opts">${opts}</div></div>
        <div class="imgs">${(m.attachments || []).map(attachmentHtml).join('')}</div>
        <div class="rx-row" data-rxrow>${rxRowInner(m, opts)}</div>
      </div>`;
  }
  return `
      <div class="a-avatar">
        <span class="logo-glyph" aria-hidden="true">${LOGO_SVG}</span>
      </div>
      <div class="a-body">
        ${quoteHtml(m)}
        <div class="content">${m.content ? md(m.content) : ''}</div>
        <div class="imgs">${(m.attachments || []).map(attachmentHtml).join('')}</div>
        <div class="rx-row" data-rxrow>${rxRowInner(m, opts)}</div>
      </div>`;
}

/* ---------- work-log folding ---------- */

// Split a flat list of message rows into run segments. A new segment starts
// at each user message and at each run_start-marked assistant row, so a
// previous run's final answer is never demoted to "intermediate" when a new
// run's rows arrive with no user message between them.
function splitRuns(nodes) {
  const runs = [];
  let cur = [];
  for (const el of nodes) {
    const isUser =
      el.classList && el.classList.contains('msg') &&
      el.classList.contains('user') && !el.classList.contains('update');
    const isRunStart = el.dataset && el.dataset.runStart;
    if ((isUser || isRunStart) && cur.length) {
      runs.push(cur);
      cur = [];
    }
    cur.push(el);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

// An assistant row with real visible text: a candidate for "final answer"
// (the last one per run) or "intermediate" (any earlier one). Excludes
// tool-only placeholders, update notes, and the vault widget.
function isIntermediateCandidate(el) {
  if (
    !el.classList || !el.classList.contains('msg') ||
    !el.classList.contains('assistant') || el.classList.contains('update') ||
    el.classList.contains('vault-request') || el.classList.contains('msg-empty')
  )
    return false;
  const content = el.querySelector('.a-body .content');
  return !!content && content.textContent.trim().length > 0;
}

// Fold one run's intermediate chatter into a single expandable work log.
// liveIds: ids of rows belonging to an in-flight run — those are never
// folded. The share page passes an empty set (snapshots are never live).
function foldRunSegment(seg, liveIds) {
  // Belt and braces: skip if any row still carries a live marker.
  // Self-healing: unwrap any previously-folded (non-live) work log back
  // into plain rows first, so a re-fold never stacks a second tray on top
  // of the first — e.g. after a live run was folded by mistake during a
  // reconnect, then folded again at run end. One run always ends up with
  // exactly one work log.
  const flat = [];
  const staleTrays = [];
  for (const el of seg) {
    if (
      el.tagName === 'DETAILS' && el.classList.contains('worklog') &&
      !el.hasAttribute('data-live')
    ) {
      flat.push(...el.querySelectorAll(':scope > .wl-body > *'));
      staleTrays.push(el);
    } else {
      flat.push(el);
    }
  }
  if (
    flat.some(
      (el) =>
        (el.classList && el.classList.contains('update') && el.dataset.liveRun) ||
        (el.dataset && el.dataset.mid && liveIds.has(Number(el.dataset.mid)))
    )
  )
    return;

  // The final answer: the last assistant row with visible text.
  let finalIdx = -1;
  flat.forEach((el, i) => {
    if (isIntermediateCandidate(el)) finalIdx = i;
  });

  const group = [];
  flat.forEach((el, i) => {
    if (el.classList && el.classList.contains('msg') && el.classList.contains('update')) {
      group.push(el); // send_update note — always intermediate
    } else if (i !== finalIdx && isIntermediateCandidate(el) && !el.querySelector('.imgs > *, .u-imgs > *')) {
      group.push(el); // plain mid-run text — intermediate (keep ones with images visible)
    }
  });
  if (!group.length) return;
  const n = group.length;
  const details = document.createElement('details');
  details.className = 'worklog';
  details.innerHTML =
    `<summary><span class="wl-name">Work log</span>` +
    `<span class="wl-count">${n} ${n === 1 ? 'entry' : 'entries'}</span></summary>` +
    `<div class="wl-body"></div>`;
  const body = details.querySelector('.wl-body');
  // Anchor at the old tray's position when re-folding (group[0] may still
  // sit inside it) — never inside the tray being replaced.
  (staleTrays.length ? staleTrays[0] : group[0]).before(details);
  for (const el of group) body.appendChild(el);
  for (const t of staleTrays) t.remove(); // drop the emptied old trays
}
