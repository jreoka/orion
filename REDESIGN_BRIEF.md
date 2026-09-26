# Orion Web UI Redesign Brief

User directives (2026-09-26). Apply as a single redesign pass AFTER the v2 feature UI
(settings, 2FA, passkeys, sessions, tasks, heartbeat) is finished and committed,
so the new design covers all screens.

## Goals
- Full web UI redesign: more minimal and cool.
- Mobile-first: must look and feel great on phones (touch targets, bottom-anchored
  nav/composer, safe-area insets, no hover-dependent controls).
- Keep the dark theme and indigo/violet accent identity; reduce chrome, borders,
  and visual noise. Generous whitespace, refined typography.

## Motion (tasteful, not overused)
- Logo: subtle animation on the minimal mark (e.g. gentle pulse / slow orbit of
  the belt dots). Should feel alive, not distracting.
- Typing: streaming caret while the agent responds; animated typing indicator
  (three bouncing dots) while waiting for the first token.
- Background: animated blue dot grid, slightly star-like (slow twinkle/drift).
  Use SPARINGLY — e.g. login screen and empty states only. Never behind chat
  message text or dense UI; keep it dim and slow.

## Scope
- All views: login (incl. 2FA step + passkey button), chat, settings (4 tabs),
  admin. Sidebar/drawer, composer, message list, tool rows, lightbox, modals.
- Keep all element IDs and API contracts the same unless there's a strong reason;
  the backend is untouched by this pass.
- PWA assets (icons, manifest) already updated to the minimal mark — keep.
