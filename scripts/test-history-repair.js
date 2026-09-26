// Regression test: loadHistory repairs user messages interleaved between
// an assistant's tool_calls and their tool results.
// Stored order: assistant(tool_calls) → user → tool → tool
// Model sees:   assistant(tool_calls) → tool → tool → user
// Without the repair, models return empty on the split sequence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-hist-'));
process.env.ORION_DATA = tmp;

const { db } = await import('../src/db.js');
const { loadHistory } = await import('../src/agent.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } };

const mkConvo = (id) => db.prepare(
  'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, 1, ?, ?, ?)'
).run(id, 't', 1, 1);
const mkIns = (cid) => db.prepare(
  `INSERT INTO messages (conversation_id, role, content, kind, tool_calls, tool_call_id, created_at)
   VALUES (${cid}, ?, ?, 'message', ?, ?, ?)`
);
const TC = JSON.stringify([{ id: 'x', type: 'function', function: { name: 'web_search', arguments: '{}' } }]);

// Interleaved: user message arrived between tool_calls and results.
mkConvo(1);
const ins = mkIns(1);
ins.run('user', 'warren?', null, null, 1);
ins.run('assistant', '', TC, null, 2);
ins.run('user', 'troy?', null, null, 3);
ins.run('tool', 'junk1', null, 'x', 4);
ins.run('tool', 'junk2', null, 'y', 5);
ins.run('assistant', 'warren answer', null, null, 6);

const hist = await loadHistory(1, 100);
const seq = hist.map(m => m.role).join(',');
ok('interleaved user moved after tool group', seq === 'user,assistant,tool,tool,user,assistant');
ok('troy question preserved in order', hist[4].role === 'user' && hist[4].content === 'troy?');
ok('tool_calls survive repair', Array.isArray(hist[1].tool_calls) && hist[1].tool_calls[0].id === 'x');

// Dangling tool_calls with no results are stripped (providers reject them).
mkConvo(2);
const ins2 = mkIns(2);
ins2.run('user', 'hello?', null, null, 1);
ins2.run('assistant', 'thinking', TC, null, 2);
ins2.run('user', 'are you there?', null, null, 3);
const hist2 = await loadHistory(2, 100);
ok('dangling tool_calls stripped', hist2[1].role === 'assistant' && !hist2[1].tool_calls);
ok('users after dangling turn kept', hist2[2].content === 'are you there?');

// Normal history is untouched.
mkConvo(3);
const ins3 = mkIns(3);
ins3.run('user', 'q1', null, null, 1);
ins3.run('assistant', 'a1', null, null, 2);
ins3.run('user', 'q2', null, null, 3);
const hist3 = await loadHistory(3, 100);
ok('clean history untouched', hist3.map(m => m.role).join(',') === 'user,assistant,user');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
