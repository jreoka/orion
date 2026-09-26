# Orion Phase 3 Brief — push notifications + abuse protection

User directives (2026-09-26). Implement AFTER the live-updates agent finishes
(per-conversation event stream, message queue, send_update, server-side stop),
since both touch server.js / app.js / sw.js.

## 1. Push notifications (mobile + desktop, Web Push/VAPID)

Backend (`src/`):
- `web-push` dependency. Generate VAPID keypair on first boot, store in settings
  table (private key never exposed via API).
- `push_subscriptions(user_id, endpoint, p256dh, auth, created_at)` table.
- `GET /api/push/vapid-public-key` → `{publicKey}`.
- `POST /api/push/subscribe {subscription}` (auth, upsert by endpoint).
- `DELETE /api/push/unsubscribe {endpoint}` (auth).
- Send triggers (only when the user has NO active event-stream subscriber on that
  conversation — i.e. not currently looking at it):
  - agent run ended (done/error/stopped) → title "Orion", body = conversation title
    + snippet of the final text.
  - task run produced output; heartbeat produced output.
  - Payload: `{title, body, url: '/#/chat/<convId>'}`.
- Helper `notifyUser(userId, {title, body, convId})` — no-op when no subscriptions.

Frontend (`public/`):
- Settings → new "Notifications" section: Enable button (requests permission,
  subscribes via PushManager with the VAPID key, POSTs subscription), Disable
  button, current state label. Only show if `('PushManager' in window)`.
- `sw.js`: `push` event → `showNotification(title, {body, icon, badge, data:{url}})`;
  `notificationclick` → focus existing client or open `data.url`.
- Support deep link `#/chat/<convId>` in the router (open that conversation).

## 2. Abuse detection + account lock (admins excluded)

Backend (`src/abuse.js`, new):
- `checkUserMessage(user, text)` called on every POST /messages BEFORE the run
  starts. Admins (`role === 'admin'`) are never checked.
- Two layers:
  - Heuristic triage (cheap, instant): fork-bomb / `rm -rf /` / `:(){:|:&}` /
    mkfs / dd-to-disk patterns, crypto-miner keywords, message > 20k chars,
    > 10 messages in 60 seconds. Each produces a flag + reason.
  - LLM judge (only when heuristics flag): uses the global provider via the
    existing llm client; system prompt classifies whether the user's request
    attempts to damage the VM, deliberately waste compute/tokens, exfiltrate
    data, or attack the platform. Returns `{verdict: 'ok'|'abusive', reason}`.
    Fail OPEN if no provider configured (log + allow).
- On `abusive`: lock the account —
  `UPDATE users SET disabled=1, abuse_locked=1, abuse_reason=?, abuse_locked_at=?`;
  revoke ALL sessions; stop/remove the user's sandbox container; publish a
  `run_ended {status:'error'}` + error event "Account locked for abuse".
  The offending message is still stored (evidence).
- Migration: `users` ADD `abuse_locked INTEGER DEFAULT 0`,
  `abuse_reason TEXT`, `abuse_locked_at INTEGER`.
- Login for locked/disabled users: 403 with specific message
  "Account locked — contact your administrator." (vs generic for wrong password).
- Admin: `PATCH /api/admin/users/:id` setting `disabled=0` also clears
  `abuse_locked/abuse_reason`. `GET /api/admin/users` includes
  `abuse_locked, abuse_reason`. Admin frontend: show a "locked" badge + reason
  in the users table (small addition to the existing admin UI).

## Tests
`/tmp/test-orion-phase3.mjs` (≥15 checks): VAPID key generation + subscribe/
unsubscribe round-trip; notify with no subscribers = no-op; heuristic flags fire
on fork bomb / miner text; judge called only on flag; abusive verdict locks account
(sessions revoked, sandbox stop attempted); admin messages never checked; locked
user cannot log in; admin re-enable clears the lock. All must pass.

## 3. Weekly token limits + per-user usage (admin)

Backend:
- Migration: `users` ADD `weekly_token_limit INTEGER` (NULL = unlimited;
  default 1000000 for new behavior — set existing rows to 1000000).
  New table `token_usage(user_id, week_start INTEGER, prompt_tokens INTEGER
  DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, week_start))`. `week_start` = Monday 00:00 UTC ms.
- Record usage on EVERY LLM call (chat runs, subagent child runs, task runs,
  heartbeat runs, abuse-judge calls) attributed to the owning user, from the
  API response `usage` object. New `src/usage.js`: `recordUsage(userId,
  {prompt_tokens, completion_tokens})`, `getWeeklyUsage(userId)` →
  `{week_start, prompt_tokens, completion_tokens, total_tokens, limit,
  remaining}`.
- Enforcement: at run start and before each LLM call, if `limit != null` and
  `total_tokens >= limit` → do not call the model; end the run with an assistant
  message "Weekly token limit reached — ask your admin to raise it." (tasks/
  heartbeat: log + skip silently-ish, store the notice as the run's message).
- Admin API:
  - `GET /api/admin/usage` → `[{user_id, username, week_start, prompt_tokens,
    completion_tokens, total_tokens, weekly_token_limit}]` (all users, current week).
  - `PATCH /api/admin/users/:id/limit {weekly_token_limit}` — integer ≥0 or
    null (null = unlimited). 0 is treated as unlimited? No — keep it strict:
    must be null or a positive integer; 0 would block everything, reject it.
  - `POST /api/admin/users/:id/usage/reset` → zeroes the user's current week row.
- Admin frontend: extend the Users table with "Usage" (e.g. "142k / 1M") and
  "Limit" columns; per-row controls: change limit (prompt for number, empty =
  unlimited), reset usage button with confirm.

## Tests (add to the phase-3 suite)
Usage recorded on a stubbed LLM call; week bucketing uses Monday UTC; limit
enforcement blocks the model call and surfaces the notice; unlimited (null)
never blocks; admin set-limit validation rejects 0/negative; reset zeroes the
row; usage endpoint lists all users with correct shapes.
