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

### Slot-checker loop (in `content.js`)
- Only runs on `/application-detail` pages (`isApplicationDetailPage()`); a MutationObserver-free polling approach instead uses hooked `history.pushState`/`replaceState`/`popstate` plus a 5s backup `setInterval` (`detectUrlChange`) to detect SPA navigation, since VFS is a client-routed Nuxt/Vue app that doesn't do full page loads.
- `checkSlots()` reads a JWT from `sessionStorage`/`localStorage` (`getAuthToken()`), POSTs to the hardcoded `lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable`, and either alerts (slot found) or logs (no slot / error) — always via the `finally` block calling `scheduleNextCheck()`, so the loop is self-perpetuating regardless of success/failure. A stuck `checking` flag is the only thing that would silently kill it.
- The request payload (`visaCategoryCode`, `loginUser`, `payCode`, the `ClientSource` header) is **hardcoded for one specific account/category**, not read from any config or the CSV. Repurposing this for a different VFS account, country, or visa category means editing these literals directly in `checkSlots()`.

### Page-state watchers (in `content.js`)
- `initLoginWatcher()` / `initDashboardWatcher()` poll for specific buttons (sign-in, "start new booking") appearing in the DOM and auto-click/auto-fill them once enabled — needed because VFS renders these controls asynchronously and disables them until some client-side condition is met (`isButtonEnabled`).
- These watchers and the slot-checker are independent state machines that both run continuously in the same content script; when debugging one, check whether the other's polling/logging is interleaved in the console before assuming a log line belongs to the feature you're editing.

### Message contracts to know
- Popup → content script: `{type: 'AUTOFILL', row, usernameValue, passwordValue}` → `{success, filled, foundUsernameField, foundPasswordField, ...}`.
- Content script → background: `{type: 'vfs-notify', title, message}` → `{ok, id}` or `{ok: false, error}`.
- Popup → background (self-test): `{type: 'vfs-test-notify'}`.
- Background → offscreen doc: `{target: 'offscreen', type: 'play-sound', source, volume}`.
