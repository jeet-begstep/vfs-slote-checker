# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension for `visa.vfsglobal.com` (VFS Global visa appointment booking). It has grown from a simple "Login" shortcut button into three loosely related features living in the same content script:

1. **Slot checker** — polls the VFS appointment-availability API and alerts when a slot opens.
2. **Login/booking autofill** — watches the login and dashboard pages and auto-clicks/auto-fills through a Nuxt/Vue SPA.
3. **CSV-driven autofill from the popup** — the toolbar popup reads a CSV of credentials and pushes a row into the page via `chrome.tabs.sendMessage`.

There is no build system, package manager, or test suite — this is plain unbundled JS loaded directly by Chrome. There are no npm scripts to run; "developing" means editing the files and reloading the unpacked extension at `chrome://extensions`.

## Running/testing changes

- Load unpacked: `chrome://extensions` → enable Developer mode → Load unpacked → select this folder.
- After editing `background.js`, `offscreen.js`, or `manifest.json`, click the reload icon for the extension on `chrome://extensions`.
- After editing `content.js`, reload the extension AND refresh the VFS tab (content scripts are re-injected only on navigation/reload).
- There is no headless test runner; verification is manual, in a real Chrome tab on `https://visa.vfsglobal.com/*`, watching the `[VFS Extension]` console logs.
- `*.bak` files (`content.js.bak`, `manifest.json.bak`) are manual backups kept in the repo, not build artifacts — check them before assuming a change is novel.

## Architecture

### Process split (MV3 constraints drive this)
- `content.js` — injected into VFS pages (`content_scripts.matches` in `manifest.json`). All page interaction, the slot-check polling loop, and DOM automation live here. It's a single IIFE with a `window.__VFS_SLOT_CHECKER_RUNNING__` guard to prevent double-injection.
- `background.js` — the MV3 service worker. It exists *only* because `chrome.notifications` and audio playback are not available to content scripts or service workers respectively:
  - Content script → `chrome.runtime.sendMessage({type: 'vfs-notify', ...})` → background shows the OS notification.
  - Background has no Audio API either, so it creates an `offscreen.html` document (`chrome.offscreen.createDocument`, reason `AUDIO_PLAYBACK`) and messages *that* to actually play `sounds/ding.wav`.
  - So a single alert fans out: content script → background (notification) → offscreen doc (sound). If notifications/sound ever silently stop working, check which hop broke, not just `content.js`.
- `popup.js` / `popup.html` — the toolbar popup. Parses a user-supplied CSV client-side, then messages the *active tab's* content script (`type: 'AUTOFILL'`) to fill username/password fields and redirect to the right country/mission login URL.
- `page-hook.js` — a second content script running in the page's **MAIN world** at `document_start` (needs Chrome 111+). It wraps `fetch` and `XMLHttpRequest.setRequestHeader` only to copy the `ClientSource` header of the page's own `lift-api.vfsglobal.com` requests into `sessionStorage['VFS_CLIENT_SOURCE']` (+ `_TS`). `sessionStorage` is shared between the MAIN and isolated worlds, which is how `content.js` reads it. If VFS's anti-bot scripts ever object to the patched `fetch`, remove its `manifest.json` entry; `content.js` falls back to a hardcoded value.
- `slot-targets.js` — pure CSV-cell parser shared by the popup (`<script>` tag) and `tests/` (`module.exports` guard). Tests: `node --test "tests/*.test.js"` (a bare directory arg fails on Node 22).

### CSV format
```
email,password,source,destination,vacCode|visaCategoryCode
someone@example.com,<pw>,are,lva,"AUH|LL,DXB|LL"
```
The last column is one or more `vacCode|visaCategoryCode` pairs (comma-separated, so the cell must be quoted). `vacCode` is the Visa Application Center. A legacy single value (`EmployL`, old header `visaCategoryCode`) still works: it becomes `{vacCode: null}` and `content.js` derives `${mission}${country}` as before. The popup always overwrites `chrome.storage.local['vfsSlotTargets']` on upload/Autofill, `[]` when the column is missing.

### Slot-checker loop (in `content.js`)
- Only runs on `/application-detail` pages (`isApplicationDetailPage()`); a MutationObserver-free polling approach instead uses hooked `history.pushState`/`replaceState`/`popstate` plus a 5s backup `setInterval` (`detectUrlChange`) to detect SPA navigation, since VFS is a client-routed Nuxt/Vue app that doesn't do full page loads.
- `checkSlots()` reads a JWT from `sessionStorage`/`localStorage` (`getAuthToken()`), POSTs to the hardcoded `lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable`, and either alerts (slot found) or logs (no slot / error) — always via the `finally` block calling `scheduleNextCheck()`, so the loop is self-perpetuating regardless of success/failure. A stuck `checking` flag is the only thing that would silently kill it.
- Each cycle checks every target in `vfsSlotTargets` one after another (`checkOneTarget()`), `STAGGER_MS` (8s ± 2s jitter) apart; the 2.5-minute timer starts after the whole cycle ends, so cycles never overlap. Empty storage → one legacy target (`${mission}${country}` + `EmployL`).
  - A 429 on any target skips the remaining targets, still alerts on any slot found earlier in the cycle, then runs the backoff/logout path below. `clearBackoffState()` runs once at the end of a cycle that had a 2xx and no 429 (not per target), so the attempt counter still escalates. Other errors are logged for that target and the loop moves on.
  - Before each target after the first, the loop re-checks the page and JWT and stops if either is gone.
  - Alerts are combined: one slot alert (toast + push + blocking `alert()`, after all targets are checked), one "no slot" push, one error push per cycle.
- `countryCode`/`missionCode`/`Route` come from the URL; `loginUser` from stored credentials. `ClientSource` comes from `getClientSource()`: the value captured by `page-hook.js` if it was captured no earlier than 2 minutes before `VFS_LAST_LOGIN_TS` (older means a previous session), else `FALLBACK_CLIENT_SOURCE`. Each Sheet log entry records `clientSourceOrigin` (`captured`/`fallback`), so 401/403s can be tied to the source.

### Forced re-login / backoff (in `content.js`)
- Two independent triggers force a logout-and-cooldown cycle from inside `checkSlots()`, and both drive the *same* mechanism: `stopChecker()` → `triggerUiLogout()` (clicks the My Account → Logout menu, falling back to clearing the JWT and redirecting to `/login`) → `setBackoffState(attempt, minutes, reason)`.
  1. **HTTP 429** from the slot API — `reason: 'rate_limit'`, backoff escalates `attempt * 10` minutes per consecutive 429.
  2. **Session age ≥ 29 minutes** — `reason: 'session_timeout'`, fixed `SESSION_TIMEOUT_COOLDOWN_MIN` (10 min) cooldown regardless of attempt count. Session age is `Date.now() - lastLoginTs`, where `lastLoginTs` is stamped by `recordLoginTime()` into `localStorage['VFS_LAST_LOGIN_TS']` the moment `initDashboardWatcher()` sees the dashboard page — i.e. it's a proxy for "login succeeded just now," not a decode of the JWT's actual `iat`/`exp`. A manual refresh of an already-open dashboard tab will reset this clock.
- Backoff state lives in `localStorage` (`VFS_429_IN_BACKOFF`, `VFS_429_ATTEMPT`, `VFS_429_NEXT_RETRY_TS`, `VFS_429_REASON`) so it survives the navigation to `/login` that `triggerUiLogout()` causes. `getBackoffState()`/`clearBackoffState()` are the only readers/writers — don't touch those keys directly.
- On `/login`, `initLoginWatcher()`/`tryAutoFillLogin()` check `getBackoffState()` and, while `inBackoff`, render the red countdown banner (`updateCooldownBanner`, text varies by `reason`) instead of auto-filling; autofill only resumes once the cooldown timer (`handleLoginCooldown`'s `setInterval`) hits zero.
- A successful (non-429) API response calls `clearBackoffState()`, but does **not** reset `VFS_LAST_LOGIN_TS` — only a fresh arrival at the dashboard does that, so the 29-minute clock keeps counting across successful slot checks within a session.

### Page-state watchers (in `content.js`)
- `initLoginWatcher()` / `initDashboardWatcher()` poll for specific buttons (sign-in, "start new booking") appearing in the DOM and auto-click/auto-fill them once enabled — needed because VFS renders these controls asynchronously and disables them until some client-side condition is met (`isButtonEnabled`).
- These watchers and the slot-checker are independent state machines that both run continuously in the same content script; when debugging one, check whether the other's polling/logging is interleaved in the console before assuming a log line belongs to the feature you're editing.

### Message contracts to know
- Popup → content script: `{type: 'AUTOFILL', row, usernameValue, passwordValue}` → `{success, filled, foundUsernameField, foundPasswordField, ...}`.
- Content script → background: `{type: 'vfs-notify', title, message}` → `{ok, id}` or `{ok: false, error}`.
- Popup → background (self-test): `{type: 'vfs-test-notify'}`.
- Background → offscreen doc: `{target: 'offscreen', type: 'play-sound', source, volume}`.
- Popup → content script via `chrome.storage.local`: `vfsAutofillUsername`, `vfsAutofillPassword`, `vfsSlotTargets: [{vacCode: string|null, visaCategoryCode}]`.
- Content script → background: `{type: 'vfs-log', entry}`, where `entry` includes `vacCode`, `visaCategoryCode`, `clientSourceOrigin`, `result`. Logged once per target per cycle.
