# Plan: Playwright runner that cycles accounts (Option A)

## Input
User request: stop relying on a manually opened tab. A Node program on the user's Mac should open VFS in a visible browser, let the extension check slots for 23 minutes, log out, close the tab, wait a cooldown, then reopen the login page with the next account (a -> b -> c -> a ...). The user ticks the captcha by hand. Chosen approach: **Option A**, a Playwright runner that drives the existing extension. No logic is rewritten.

No ticket or spec. Related prior plans: `2026-10-29-are-dropdown-flow-plan.md`, `2026-10-29-multi-vac-slot-targets-plan.md`. No `bin/bstack-solutions`, `TODOS.md` or `.claude/rules` exist in this repo, so those checks were skipped.

## Rollback Path
Two-way door. The runner lives in a new `runner/` folder and is started by hand (`npm run runner`). Rollback = stop the process and delete `runner/`, `package.json`, `package-lock.json`. The only change to existing code is `runnerMode` in `content.js`, which defaults to off, so the extension behaves exactly as today when loaded by hand. Revert is one `git revert`.

## Scope Decisions
**Minimum viable scope:** runner opens one persistent Chromium window, loops accounts, owns the 23 min / cooldown timing, and pauses for the captcha. It reuses the extension for autofill, slot checks, alerts and Sheet logging.

**Complexity check:** about 6 new files plus 2 small edits. Under the 8-file trigger. Justified.

**Existing coverage:** the extension already does 23 min timeout, logout, 5 min cooldown and account rotation inside one tab (commit `d502c01`). The runner must take over the timing and rotation, otherwise two clocks fight. Hence `runnerMode` (Task 3).

**Decisions made (no further input needed):**
- Playwright's bundled Chromium, not branded Chrome. Branded Chrome 137+ ignores `--load-extension`.
- Headed, persistent profile at `runner/.profile/` (gitignored). Keeps the captcha-cleared cookies and looks less like a bot than a fresh profile.
- Runner owns: account order, session length, cooldown. Extension owns: autofill, slot checks, alerts, logout click.
- Fresh tab per session. Close the tab after logout.
- Captcha: runner waits up to 10 min for the dashboard URL. After 10 min it counts the attempt as failed, closes the tab, and moves to the next account.

## Affected Apps / Libs
- New: `runner/` (Node, ESM). No DDD boundary issue; the repo is a flat extension.
- Modified: `content.js` (runnerMode), `slot-targets.js` (move `parseCSV` here so the runner and popup share it), `popup.js` (use shared `parseCSV`), `.gitignore`, `CLAUDE.md`.
- New dependency: `playwright` (dev). First package manager use in the repo; the extension itself stays unbundled.

Blast radius: only the user's own VFS accounts. Worst case is account lock or ban (see Risks).
Ownership in production: the user runs it locally. No on-call.

## Architecture Diagram
```
 CSV (accounts)                          runner/index.js  (Node, Mac)
   |                                          |
   v                                          | launchPersistentContext
 runner/accounts.js --> [a,b,c]               |   headed Chromium
                                              |   --load-extension=<repo>
                                              v
              +------------------ per-account loop ------------------+
              |  1 set chrome.storage (creds,targets,category,       |
              |    vfsRunnerMode=true)  via extension page evaluate  |
              |  2 clear VFS_429_* localStorage (addInitScript)      |
              |  3 newPage -> /<src>/en/<dst>/login                  |
              |        extension autofills, clicks Sign In           |
              |        USER ticks captcha  (runner notifies, waits   |
              |        <=10 min for dashboard URL)                   |
              |  4 dashboard seen -> start 23 min clock              |
              |        extension content.js checks slots every cycle |
              |  5 extension logs out at >=23 min (or 429) and writes|
              |        vfsRunnerEvent {type, ts} to chrome.storage   |
              |        runner polls it; fallback: force logout at    |
              |        27 min (session limit ~29)                    |
              |  6 page.close(), clear vfsglobal cookies             |
              |  7 cooldown: 5 min (session) or n*10 min (429)       |
              |  8 next account (i+1) % n                            |
              +-------------------------------------------------------+
   failure paths: captcha timeout -> skip account, no cooldown extra
                  429 -> escalating cooldown, counter shared across accounts
                  browser crash -> runner relaunches context, resumes same index
```

## Tasks

1. **Scaffold** (sequential, first). Create `package.json` (**no `"type"` field**: `slot-targets.js` and the tests are CommonJS; the runner is CommonJS too; devDependency `playwright`, script `runner`), `.gitignore` entries for `node_modules/`, `runner/.profile/`, `runner/accounts.csv`. Run `npx playwright install chromium`.
   Files: `package.json`, `.gitignore`. Completeness: 9/10.

2. **Shared CSV parsing** (parallel with 3). Move `parseCSV` + `splitCSVLine` from `popup.js:189-225` into `slot-targets.js` with a `module.exports` entry; popup calls it via the existing `<script>` tag. Add tests.
   Files: `slot-targets.js`, `popup.js`, `tests/slot-targets.test.js`. Completeness: 9/10.

3. **runnerMode in the extension** (parallel with 2). In `content.js`:
   - Read `vfsRunnerMode` from `chrome.storage.local`.
   - At the 23 min check (`content.js` ~line 1220): in runner mode skip `rotateToNextAccount()` and `setBackoffState()`, still call `triggerUiLogout()`, then write `vfsRunnerEvent = {type:'session_timeout', ts}`.
   - In the 429 branch (~line 1309): same, `type:'rate_limit'`; skip the in-tab backoff and rotation.
   - **Order matters:** the event is written, and the stored autofill credentials are removed, *before* `triggerUiLogout()` runs, because the logout navigates and can tear the content script down. Removing the credentials also stops the login watcher from signing straight back in on the `/login` page after logout. The decision itself is a pure helper `planSessionEnd(runnerMode, reason)` in `slot-targets.js`, unit-tested.
   - Once the dashboard is reached, write `vfsRunnerEvent = {type:'logged_in', ts}` next to `recordLoginTime()`, so the runner knows the captcha is done.
   Flag off = zero behaviour change.
   Files: `content.js`. Completeness: 8/10.

4. **Accounts loader** (depends on 2). `runner/accounts.js`: read `runner/accounts.csv` (path overridable by argv), return `[{username, password, source, destination, targets, category}]` using `parseCSV`, `parseSlotTargets`, `findCategoryColumn`. Skip rows without credentials. Rotation order = file order.
   Files: `runner/accounts.js`. Completeness: 9/10.

5. **Scheduler (pure functions)** (parallel with 4). `runner/schedule.js`: `nextIndex(i, n)`, `cooldownMs(reason, consecutive429)` (session 5 min, 429 `n*10` min), `SESSION_CAP_MS` (27 min). Pure, unit-tested.
   Files: `runner/schedule.js`, `tests/schedule.test.js`. Completeness: 10/10.

6. **Browser + storage bridge** (depends on 1). `runner/browser.js`:
   - `launchPersistentContext('runner/.profile', {headless:false, args:['--disable-extensions-except=<repo>','--load-extension=<repo>']})`.
   - Find the extension id from `context.waitForEvent('serviceworker')`.
   - Open `chrome-extension://<id>/runner-bridge.html` (an empty page added to the extension) once and keep it open; `evaluate(chrome.storage.local.set/get)` runs there. Used instead of the service worker handle because MV3 workers go idle.
   - `context.addInitScript` that removes `VFS_429_*` keys from `localStorage` on every `visa.vfsglobal.com` load.
   Files: `runner/browser.js`. Completeness: 8/10.

7. **Session loop** (depends on 3, 4, 5, 6). `runner/index.js`:
   - Per account: set storage (creds, `vfsSlotTargets`, `vfsUiCategory`, `vfsRunnerMode:true`, clear `vfsRunnerEvent`), open `/<source>/en/<destination>/login`.
   - Wait for `logged_in` event (max 10 min, macOS notification at 30 s: "Tick the captcha").
   - Wait for `session_timeout` / `rate_limit` event, or `SESSION_CAP_MS` after `logged_in`. On cap, click logout by evaluating the same fallback as `triggerUiLogout()`: clear JWT and navigate to `/login`.
   - After the event, wait up to 30 s for the page URL to match `/login`; if it doesn't, log `logout_unconfirmed`. Then close the page. Cookies are **not** cleared by default (it would also drop the Cloudflare clearance cookie); `--clear-cookies` enables it. Log to `runner/runner.log` (JSON lines, no passwords), then sleep the cooldown (printed countdown), next account.
   - SIGINT closes the context cleanly. If the browser disconnects, relaunch and retry the same index.
   Files: `runner/index.js`. Completeness: 8/10.

8. **Docs** (last). `CLAUDE.md`: runner section, run command, `runnerMode` contract, new storage keys (`vfsRunnerMode`, `vfsRunnerEvent`). Short `runner/README.md` with CSV location and first-run steps.
   Files: `CLAUDE.md`, `runner/README.md`. Completeness: 8/10.

Order: 1 -> (2 || 3) -> (4 || 5 || 6) -> 7 -> 8. Each task fits one agent in about 30 min.

## Data Layer
None. State: `chrome.storage.local` (`vfsAccounts` kept for the manual flow, runner adds `vfsRunnerMode`, `vfsRunnerEvent`) and the Chromium profile directory. Nothing irreversible.

## Test Coverage Table
| Behavior | File | Type | Edge cases covered |
|---|---|---|---|
| CSV parse (shared) | `tests/slot-targets.test.js` | unit | quoted `"AUH\|LL,DXB\|LL"`, CRLF, empty lines, missing columns |
| Accounts loader | `tests/accounts.test.js` | unit | rows without password skipped, legacy single vacCode, empty file |
| `planSessionEnd` | `tests/slot-targets.test.js` | unit | runner on/off x session_timeout/rate_limit: backoff, rotation, signal |
| `nextIndex` | `tests/schedule.test.js` | unit | n=1, wrap-around, n=0 |
| `cooldownMs` | `tests/schedule.test.js` | unit | session = 5 min, 429 escalation 10/20/30, counter reset after success |
| runnerMode branches in `content.js` | manual | manual in Chrome | flag on: no rotation, no in-tab backoff, event written; flag off: unchanged |
| Full loop, 2 accounts | manual | manual | lower `SESSION_MAX_AGE_MS` to 2 min and cooldown to 30 s; confirm a->b->a, tab closes, banner absent |
| Captcha timeout | manual | manual | do not tick; confirm skip after the wait limit |
| Browser crash | manual | manual | kill Chromium mid-session; confirm relaunch on same account |

`content.js` is not unit-testable (IIFE, DOM); that gap is the existing norm in this repo.

## Auth & Data-Safety Impact
- Passwords sit in `runner/accounts.csv` and in extension storage. Both are gitignored/local. The runner must never log passwords (log the email only).
- The persistent profile holds VFS session cookies. Keep it out of git and cloud sync.
- Clearing cookies after each session ends the login cleanly; the captcha-cleared state is kept in the profile, not in cookies we delete only for `vfsglobal.com`. If this causes a captcha on every login, the user is already expected to tick it.

## Risks
1. **Bot detection blocks the automated browser.**
   - Blast radius: runner cannot log in; at worst repeated blocks flag the accounts.
   - Mitigation: headed browser, persistent profile, human-paced delays, no stealth hacks. Fail closed: after 3 consecutive captcha timeouts the runner stops instead of retrying forever.
   - Detection: runner logs "captcha timeout" or a 403 page title per attempt.
2. **Terms of service / account ban.** Automating VFS may break their terms; rate-limiting and the 429 logic suggest they watch for it. Blast radius: the user's accounts. Mitigation: cooldowns are kept (5 min / escalating), one session at a time, no parallel accounts. Detection: 429 / 403 events in the Sheet log. Decision for the user: accept this risk knowingly.
3. **Two clocks disagree** (extension logout vs runner cap), leaving a stale tab or a double logout. Mitigation: runnerMode disables the extension's own cooldown and rotation; the runner cap (27 min) sits above the extension's 23 min check, which can fire up to about 2.5 min late. Detection: runner logs which side ended each session (`event` vs `cap`). If the cap fires often, lower the extension's check interval or move the cap.

## Review record
`/bstack:plan-review --mode=eng` on 2026-11-16. Findings and disposition:
1. `"type":"module"` breaks CJS tests: **Addressed** (Task 1, runner is CommonJS).
2. Event lost on navigation: **Addressed** (Task 3, write before logout).
3. Tab closed before logout confirmed: **Addressed** (Task 7, 30 s wait, `logout_unconfirmed`).
4. Cookie clearing: **Addressed** (off by default, `--clear-cookies`).
5. Shared 429 counter: **Addressed** (kept shared, every 429 logged with the account email).
6. Presence every ~28 min: **Addressed in part** (`--until HH:MM`; macOS notification on captcha wait). Overnight use still needs the user at the keyboard.
7. Persistent log: **Addressed** (`runner/runner.log`).
8. Idle time after the budget guard: **Deferred** (follow-up).
9. Storage bridge: **Addressed** (`runner-bridge.html`).
10. Pure session-end helper: **Addressed** (`planSessionEnd`).
11. Clean shutdown: **Addressed in part** (clear `vfsRunnerMode` on exit and start; on Ctrl+C the JWT is cleared and the browser closed, the server-side session is not explicitly ended).

## Open items before coding
- Confirm all CSV rows share one source/destination. The loop uses each row's own values, so mixed rows work, but the extension's URL logic has only been tested with `are` -> `lva`.
- Next step: `/bstack:implement docs/plans/2026-11-16-playwright-runner-plan.md`.
