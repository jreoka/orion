/* Shared Markdown renderer — the single pipeline used by the main chat
   (public/js/app.js) and the read-only share page (public/share.html).
   Keep feature parity HERE; do not fork a second renderer elsewhere.

   Blocks: fenced code (with copy button), ATX headings, GFM pipe tables,
   bulleted/numbered lists, blockquotes, paragraphs.
   Inline: images, [text](url) links, autolinked bare URLs, `code`,
   **bold**, *italic*. */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function inlineMd(s) {
  s = esc(s);
  // Images first, so ![alt](url) isn't half-eaten by the link pass.
  s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g,
    '<img class="msg-img" src="$2" alt="$1" loading="lazy">');
  // [text](url) links before the bare-URL autolinker (their URLs are
  // preceded by '(', which the autolink pattern won't match).
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Autolink bare URLs FIRST — before backticks/bold/italic wrap them in
  // <code>/<strong>/<em> (which would hide them from the linkifier).
  s = s.replace(/(^|[\s`*])(https?:\/\/[^\s<`*]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

// Split a table row on unescaped pipes; a leading/trailing pipe just marks
// the row edges ("| a | b |" -> ["a", "b"]).
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i++; }
    else if (ch === '|') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  let out = cells.length && cells[0].trim() === '' ? cells.slice(1) : cells;
  if (out.length && out[out.length - 1].trim() === '') out = out.slice(0, -1);
  return out.map((c) => c.trim());
}

// Delimiter row: every cell is at least one hyphen, optionally colon-aligned.
function isDelimRow(line) {
  if (!line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function delimAlign(cell) {
  const left = cell.startsWith(':'), right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

// If lines[i] starts a GFM pipe table (header + delimiter row), render it
// and return { html, nextIndex }. Otherwise return null.
function tryParseTable(lines, i) {
  const header = lines[i];
  if (!header.includes('|')) return null;
  const delim = lines[i + 1];
  if (delim == null || !isDelimRow(delim)) return null;
  const aligns = splitTableRow(delim).map(delimAlign);
  const headCells = splitTableRow(header);
  const n = Math.max(headCells.length, aligns.length);
  while (headCells.length < n) headCells.push('');
  while (aligns.length < n) aligns.push('left');
  let html = '<div class="tbl-wrap"><table><thead><tr>';
  for (let c = 0; c < n; c++)
    html += `<th style="text-align:${aligns[c]}">${inlineMd(headCells[c])}</th>`;
  html += '</tr></thead><tbody>';
  let j = i + 2;
  for (; j < lines.length; j++) {
    if (!lines[j].includes('|')) break;
    const rowCells = splitTableRow(lines[j]);
    if (!rowCells.length) break;
    html += '<tr>';
    for (let c = 0; c < n; c++)
      html += `<td style="text-align:${aligns[c]}">${inlineMd(rowCells[c] || '')}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return { html, nextIndex: j };
}

function mdBlocks(p) {
  const lines = String(p ?? '').split('\n');
  let html = '';
  const para = [];
  const flushPara = () => {
    if (para.length) { html += '<p>' + para.map(inlineMd).join('<br>') + '</p>'; para.length = 0; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flushPara();
      html += `<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`;
      continue;
    }
    const tbl = tryParseTable(lines, i);
    if (tbl) {
      flushPara();
      html += tbl.html;
      i = tbl.nextIndex - 1;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      const itemRe = ul ? /^\s*[-*]\s+(.*)/ : /^\s*\d+[.)]\s+(.*)/;
      html += `<${tag}>`;
      while (i < lines.length) {
        const it = lines[i].match(itemRe);
        if (!it) break;
        html += `<li>${inlineMd(it[1])}</li>`;
        i++;
      }
      html += `</${tag}>`;
      i--;
      continue;
    }
    const qm = line.match(/^\s*>\s?(.*)/);
    if (qm) {
      flushPara();
      const qs = [];
      while (i < lines.length) {
        const q2 = lines[i].match(/^\s*>\s?(.*)/);
        if (!q2) break;
        qs.push(q2[1]);
        i++;
      }
      html += `<blockquote>${qs.map(inlineMd).join('<br>')}</blockquote>`;
      i--;
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return html;
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
      html += mdBlocks(p);
    }
  });
  return html || '<br>';
}

// Delegated copy-button wiring for rendered code blocks.
function wireCopyButtons(root) {
  root.addEventListener('click', async (e) => {
    const cp = e.target.closest('.copybtn');
    if (!cp) return;
    const code = cp.closest('.codeblock').querySelector('code').dataset.code || '';
    try { await navigator.clipboard.writeText(code); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = code; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    cp.textContent = 'Copied ✓';
    setTimeout(() => { cp.textContent = 'Copy'; }, 1400);
  });
}
