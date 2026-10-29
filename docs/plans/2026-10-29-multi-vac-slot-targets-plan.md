# Plan: Multi-center slot checks from CSV (`vacCode|visaCategoryCode`)

## Input

Feature description (typed prompt), plus a sample CSV (`VFSData - UAE-LTA (6).csv`) and two captured `CheckIsSlotAvailable` requests for are→lva.

New CSV shape:

```
email,password,source,destination,vacCode|visaCategoryCode
someone@gmail.com,<secret>,are,lva,"AUH|LL,DXB|LL"
```

The last cell holds one or more `vacCode|visaCategoryCode` pairs, comma-separated and quoted. Each pair is one Visa Application Center plus the category to check there. The captured requests show the API body needs both values per center:

```json
{"countryCode":"are","missionCode":"lva","vacCode":"DXB","visaCategoryCode":"LL","roleName":"Individual","loginUser":"<email>","payCode":""}
{"countryCode":"are","missionCode":"lva","vacCode":"AUH","visaCategoryCode":"LLN","roleName":"Individual","loginUser":"<email>","payCode":""}
```

**What the code does today (verified):**
- The CSV's old `visaCategoryCode` column is **never used**. `content.js:579` hardcodes `visaCategoryCode: 'EmployL'`.
- `vacCode` is derived from the URL as `${missionCode}${countryCode}`.toUpperCase() (`content.js:526-527`), e.g. `LVAARE`. That is not a real center code.
- The popup only stores username/password in `chrome.storage.local` (`popup.js:70-79`). Nothing else from the row reaches `checkSlots()`.
- `ClientSource` is a hardcoded constant (`content.js:597-598`). It differs between the two captured requests, so VFS likely generates it per request or per session.

**Decisions locked in with the user:**
- D1 Route scope: **new format on every route**. Old CSVs with a single `visaCategoryCode` value (e.g. `EmployL`) keep working: a pair with no `|` is treated as a category with the legacy derived `vacCode`.
- D2 Multiple centers: **check all pairs every cycle, staggered** (one request after another with a gap), not round-robin.
- D3 ClientSource: **unknown whether the hardcoded value works**, so capture the value the VFS page itself sends and reuse it, falling back to the hardcoded constant.

No ticket tracker or doc store is attached to this repo, so the ticket/ADR/Slack post-actions are omitted. R.I.C.E. gate skipped: this modifies existing code.

**Security note:** the pasted curl commands contain a live `authorize` JWT and Cloudflare cookies. None of it is copied into this plan or the code. Treat that session as exposed (log out of it).

## Rollback Path

All changes are in 4 tracked files plus 2 new files. Rollback = `git revert <commit>` and reload the unpacked extension.

Partial disable without a revert:
- ClientSource capture: remove the `page-hook.js` entry from `manifest.json` `content_scripts`. `content.js` falls back to the hardcoded constant when no captured value exists.
- Multi-target: if `vfsSlotTargets` is missing from storage, `checkSlots()` falls back to exactly today's single request (`LVAARE`-style vacCode + `EmployL`), so clearing extension storage restores old behaviour.

No data migration. Storage keys are additive (`vfsSlotTargets`, `VFS_CLIENT_SOURCE`). Two-way door.

## Scope Decisions

**Minimum viable scope:**
1. Popup parses the pair column into `[{vacCode, visaCategoryCode}]` and stores it.
2. `checkSlots()` loops over stored targets with a stagger, one API call per target.
3. Capture the page's own `ClientSource` header.

**Out of scope:** per-row route switching inside one tab (one tab still checks one account), UI for editing targets in the popup, changes to the login/dashboard watchers, changes to the Google Sheet script (it already has `vacCode` and `visaCategoryCode` columns, `docs/vfs-log-apps-script.gs:43-44`).

**Complexity check:** 6 files (4 modified, 2 new), 0 new services. Under the 8-file trigger.

**Why a shared parser file:** the parser is the one piece with real edge cases (quoting, whitespace, legacy values, dupes). Putting it in `slot-targets.js` with a `module.exports` guard lets `node --test` cover it without adding npm or a build step. `popup.html` loads it with a plain `<script>` tag.

## Affected Files

| File | Change | Blast radius if wrong |
|---|---|---|
| `slot-targets.js` (new) | `parseSlotTargets(cell)` pure parser | Wrong targets stored; checks hit wrong center |
| `popup.html` | load `slot-targets.js` before `popup.js` | Popup throws, CSV upload broken |
| `popup.js` | find pair column, parse, save `vfsSlotTargets` on both upload and "Autofill selected row" | Targets missing; falls back to legacy single check |
| `content.js` | read targets, loop with stagger, per-target payload/log, one summary notification, read captured ClientSource | Slot checker loop; a stuck `checking` flag kills polling silently |
| `page-hook.js` (new) | MAIN-world script wrapping `fetch` and `XMLHttpRequest.setRequestHeader` to record `ClientSource` for `lift-api.vfsglobal.com` calls into `sessionStorage` | A throw here could break the VFS page's own requests; must be wrapped in try/catch and never alter the request |
| `manifest.json` | add second `content_scripts` entry: `page-hook.js`, `"world": "MAIN"`, `"run_at": "document_start"`; bump version to 1.8 | Extension fails to load if malformed |
| `CLAUDE.md` | update "Slot-checker loop" and message contract sections | Docs drift |

Ownership: single maintainer (this repo). One user, one account per tab.

## Architecture Diagram

```
popup.js (CSV upload / Autofill button)
  └─ parseSlotTargets(row["vacCode|visaCategoryCode"])      [slot-targets.js]
  └─ chrome.storage.local.set({ vfsAutofillUsername, vfsAutofillPassword,
                                vfsSlotTargets: [{vacCode, visaCategoryCode}, ...] })
  └─ redirect tab → /{source}/en/{destination}/login

VFS page (MAIN world)
  page-hook.js wraps fetch / XHR.setRequestHeader
  └─ on request to lift-api.vfsglobal.com with ClientSource header
       → sessionStorage["VFS_CLIENT_SOURCE"] = value      (shared with isolated world)

content.js (isolated world) on /application-detail, every 2.5 min:
  checkSlots()
    ├─ session age >= 29m → session_timeout backoff → logout       (unchanged, once per cycle)
    ├─ targets = getStoredSlotTargets()  || [legacyTarget]
    └─ for each target (gap STAGGER_MS between calls):
         POST CheckIsSlotAvailable
           headers: Authorize=JWT, ClientSource=captured || HARDCODED, Route={cc}/en/{mc}
           body:    {countryCode, missionCode, vacCode, visaCategoryCode, roleName, loginUser, payCode}
         ├─ 429      → setBackoffState → log → stopChecker → triggerUiLogout → ABORT remaining targets
         ├─ !ok      → log error for this target → continue to next target
         ├─ earliestDate → collect into found[]; log slot_available
         └─ none     → log no_slot
       sendCheckLogEntry(...) per target → background → Sheet (unchanged path)
    after loop:
         found[] non-empty → one toast + one push + one alert listing every center/date
         found[] empty     → one "No slot available (N centers)" toast + push
    finally: checking=false; scheduleNextCheck() unless in backoff
```

## Tasks

### 1. Add `slot-targets.js` parser + tests
- **Create:** `slot-targets.js`, `tests/slot-targets.test.js`
- `parseSlotTargets(cell)` returns `[{vacCode, visaCategoryCode}]`:
  - split on `,`, trim each, drop empties
  - `A|B` → `{vacCode: A.toUpperCase(), visaCategoryCode: B}` (category kept as-is; `LL` vs `LLN` are case-significant enough not to touch)
  - no `|` (legacy `EmployL`) → `{vacCode: null, visaCategoryCode: value}`; `null` means "derive from URL" in content.js
  - pair with empty side (`|LL`, `DXB|`) → skipped and reported in a second return field `invalid: [...]`
  - dedupe on `vacCode|visaCategoryCode`
- `findSlotTargetColumn(row)` returns the value of the first key matching `/vaccode|visacategory/i`, so the old header `visaCategoryCode` and the new `vacCode|visaCategoryCode` both work.
- Export guard: `if (typeof module !== 'undefined') module.exports = { parseSlotTargets, findSlotTargetColumn };`
- **Tests:** run with `node --test "tests/*.test.js"` (no npm; a bare directory arg fails on Node 22). Cases in the test table below.
- Dependencies: none. Parallelizable with Task 4.
- Completeness: 9/10

### 2. Popup: store targets
- **Modify:** `popup.html` (add `<script src="slot-targets.js"></script>` before `popup.js`), `popup.js`
- Replace `saveAutofillCredentials(username, password)` (`popup.js:70-79`) with `saveRowConfig(row)` that stores username, password, and `vfsSlotTargets`. Call it at both existing sites (`popup.js:56` and `popup.js:142`).
- Always overwrite `vfsSlotTargets` (review finding 2). Missing column → store `[]`, which content.js treats as the legacy single check. Never leave a previous upload's centers in place.
- If `invalid` is non-empty or zero targets parse, show it in `setStatus(..., 'error')` but still store credentials (login autofill must not break because of a bad pair).
- Status line on load: `Loaded 1 row(s). Centers: AUH|LL, DXB|LL`.
- Existing `splitCSVLine` (`popup.js:178-196`) already handles the quoted cell; no change needed there. Verify with the sample file.
- Dependencies: Task 1.
- Completeness: 8/10

### 3. content.js: multi-target check loop
- **Modify:** `content.js`
- Add `SLOT_TARGETS_KEY = 'vfsSlotTargets'` and `getStoredSlotTargets()` next to `getStoredAutofillCredentials()` (`content.js:309-325`), same promise pattern.
- Add `STAGGER_MS = 8000` near `CHECK_INTERVAL_MS` (`content.js:12`). Add +/- 2s jitter.
- Split `checkSlots()` (`content.js:476-748`):
  - Keep the page check, `checking` guard, token check, and session-age check at the top, run once per cycle.
  - Build `targets`: stored list, mapping `vacCode: null` to the legacy `${missionCode}${countryCode}`.toUpperCase(). If storage is empty, use `[{ vacCode: legacy, visaCategoryCode: 'EmployL' }]` so today's behaviour is preserved.
  - New `checkOneTarget(target, ctx)` holding today's fetch + response handling (`content.js:575-700`), returning `{status: 'rate_limited' | 'slot' | 'none' | 'error', earliestDate}`. It calls `sendCheckLogEntry` with the real `target.vacCode` and `target.visaCategoryCode` (replaces the hardcoded `'EmployL'` at `content.js:560, 728`).
  - Loop: `await checkOneTarget`; on `rate_limited` run today's 429 path (`content.js:614-637`) and `return` (the `finally` still clears `checking`); between targets `await sleep(STAGGER_MS)`; before each target re-check `isApplicationDetailPage()` and `getAuthToken()` and stop if either is gone (user navigated away mid-cycle).
  - After the loop: one combined slot alert (`showToast`, `sendPushAlert`, `alert`) listing `vacCode/visaCategoryCode: date` for every hit. Move the blocking `alert()` (`content.js:667`) here so it can't stall the remaining targets. One "No slot available (checked N centers)" push instead of N.
  - `clearBackoffState()` on the first 2xx, same as today.
- Interval stays 2.5 min measured from the end of a cycle (existing `scheduleNextCheck()` in `finally`), so N targets lengthen the cycle and never overlap.
- Log line per target: `[VFS Extension] Checking DXB/LL (1/2)`.
- Dependencies: Task 2 for real data (can be written in parallel against the storage contract).
- Completeness: 8/10

### 4. Capture ClientSource from the page
- **Create:** `page-hook.js`. **Modify:** `manifest.json`, `content.js`
- `page-hook.js` (MAIN world, `document_start`):
  - Wrap `window.fetch`: if URL contains `lift-api.vfsglobal.com`, read `clientsource` from `init.headers` (Headers object, plain object, or array form) or from `input.headers` when `input` is a `Request` (review finding 3), and write `sessionStorage.setItem('VFS_CLIENT_SOURCE', value)` plus `VFS_CLIENT_SOURCE_TS`. Always call the original fetch with unchanged arguments.
  - Wrap `XMLHttpRequest.prototype.open` (remember URL) and `setRequestHeader` (match `clientsource` case-insensitively). Always call the original.
  - Everything inside `try/catch`; a failure must never break the page's own requests.
  - Guard against double install with `window.__VFS_PAGE_HOOK__`.
- `manifest.json`: add a second `content_scripts` entry (`matches: https://visa.vfsglobal.com/*`, `js: [page-hook.js]`, `run_at: document_start`, `world: MAIN`). Add `"minimum_chrome_version": "111"` (review finding 6). Bump `version` to `1.8`.
- `content.js`: `getClientSource()` returns `{value, origin}`. Uses `sessionStorage['VFS_CLIENT_SOURCE']` only if `VFS_CLIENT_SOURCE_TS >= VFS_LAST_LOGIN_TS` (review finding 3: a value from before the last login is stale), otherwise the existing constant (moved to `FALLBACK_CLIENT_SOURCE`). Before the page makes its first `lift-api` call the fallback is used (review Q4, accepted). Log which one was used per cycle (first 12 chars only).
- Add `clientSourceOrigin: 'captured' | 'fallback'` to every `sendCheckLogEntry` and a matching column in `docs/vfs-log-apps-script.gs` (review finding 5), so Risk 1 is visible in the Sheet.
- Our own `fetch` from `content.js` runs in the isolated world, so the MAIN-world hook does not see it and cannot record our value back into storage.
- Dependencies: none. Parallelizable with Task 1.
- Completeness: 7/10. Unknown until tested: whether VFS binds ClientSource to a single request body/timestamp. See Risk 1.

### 5. Docs
- **Modify:** `CLAUDE.md`: Slot-checker section (payload is no longer hardcoded; targets come from `vfsSlotTargets`; ClientSource capture; MAIN-world hook), message/storage contracts, CSV format with an example row.
- Dependencies: Tasks 2-4.
- Completeness: 9/10

### 6. Manual verification in Chrome
- Reload the extension, upload the sample CSV, log in, reach `/application-detail` for are→lva.
- Check console for: captured ClientSource used (not fallback), two requests ~8s apart with `vacCode` DXB/AUH in the body (DevTools Network, filter `CheckIsSlotAvailable`), HTTP 200 for both, two Sheet rows with real vacCode/category, one summary notification.
- Upload an old-format CSV (`...,ind,lva,EmployL`): confirm a single request with `LVAIND` + `EmployL`, i.e. unchanged behaviour.
- Force a 429 path check by reading code path only (don't provoke VFS); confirm remaining targets are skipped in logic review.
- Dependencies: Tasks 1-4.

## Data Layer

No database. Storage changes (additive, no migration):

| Store | Key | Written by | Shape |
|---|---|---|---|
| `chrome.storage.local` | `vfsSlotTargets` | popup.js | `[{vacCode: string \| null, visaCategoryCode: string}]` |
| page `sessionStorage` | `VFS_CLIENT_SOURCE`, `VFS_CLIENT_SOURCE_TS` | page-hook.js | string, epoch ms string |

## Test Coverage Table

| Behavior | File | Type | Edge cases covered |
|---|---|---|---|
| Parse multi pair cell | `tests/slot-targets.test.js` | unit (`node --test`) | `"AUH\|LL,DXB\|LL"`, spaces around `,` and `\|`, trailing comma |
| Legacy single value | `tests/slot-targets.test.js` | unit | `EmployL` → `{vacCode: null, ...}` |
| Invalid pairs reported | `tests/slot-targets.test.js` | unit | `\|LL`, `DXB\|`, `A\|B\|C`, empty cell |
| Dedupe + vacCode uppercase | `tests/slot-targets.test.js` | unit | `dxb\|LL,DXB\|LL` → one entry |
| Column lookup old/new header | `tests/slot-targets.test.js` | unit | `visaCategoryCode`, `vacCode\|visaCategoryCode`, missing column |
| Popup stores targets on upload and on Autofill button | manual | e2e (Chrome) | bad pair still saves creds; status shows error |
| One request per target, staggered | manual | e2e | DevTools Network timing and bodies |
| 429 on target 1 skips target 2 | manual (code review) | review | not provoked against live VFS |
| Error on target 1 still checks target 2 | manual | e2e | simulate by temporarily setting an invalid vacCode |
| Legacy CSV unchanged | manual | e2e | `LVAIND` + `EmployL` single request |
| ClientSource captured and used | manual | e2e | console shows "captured"; falls back when hook entry removed |
| Page requests unaffected by hook | manual | e2e | VFS login and dashboard still work with hook loaded |

## Auth & Data-Safety Impact

- No new credentials stored. `vfsSlotTargets` contains center and category codes only.
- `page-hook.js` reads one request header and writes it to `sessionStorage`, which VFS's own scripts can already read. It never logs the full value and never touches the `Authorize` header or request bodies.
- Plan and code must not contain the JWT/cookies from the pasted curls.

## Risks

1. **ClientSource is single-use or bound to the request body.**
   - What: the captured value from the page's last request is rejected for our body (different `vacCode`), giving 401/403 for every check.
   - Blast radius: all slot checks fail; no alerts. The loop keeps running and logging errors.
   - Mitigation: fallback constant still tried if no capture exists; Task 6 checks the HTTP status for both centers. If this fails, the next step is to trigger the page's own "check availability" UI per center instead of calling the API directly (separate plan).
   - Detection: Sheet rows with `result=error`, `httpStatus` 401/403; "VFS check failed" push alerts.

2. **More requests per cycle raise 429 frequency.**
   - What: 2+ centers per 2.5 min doubles the request rate, triggering the 429 logout/backoff cycle more often.
   - Blast radius: longer cooldowns (`attempt * 10` min), fewer checks overall.
   - Mitigation: stagger with jitter; 429 aborts the rest of the cycle immediately; `STAGGER_MS` and `CHECK_INTERVAL_MS` are single constants to tune. Popup warns when a row lists more than 4 centers.
   - Detection: `rate_limited` rows in the Sheet, compared against the week before this change.

3. **Long cycle collides with session timeout or navigation.**
   - What: a cycle that spans the 29-minute mark, or the user navigates off `/application-detail` mid-cycle, sends requests with a stale context.
   - Blast radius: a few failed requests; worst case a stuck `checking` flag stops polling.
   - Mitigation: re-check page and token before each target; `checking = false` stays in `finally`; session age is checked at cycle start, and a cycle of N×8s is far below the 29-minute window.
   - Detection: console `Check already running. Skipping.` repeating with no API calls; no new Sheet rows.

4. **VFS anti-bot scripts notice the patched `fetch`/XHR** (review finding 7).
   - What: the page flags the session because `window.fetch` is no longer native.
   - Blast radius: login or API calls blocked for that tab.
   - Mitigation: remove the `page-hook.js` entry from `manifest.json`; content.js falls back to the hardcoded ClientSource.
   - Detection: login/dashboard breaks only with the hook loaded; Cloudflare challenge loops.

## Review record

**2026-10-29, eng lens (`/bstack:plan-review eng`).** Findings and outcome:

| # | Type | Finding | Outcome |
|---|---|---|---|
| 1 | BLOCKER | `node --test tests/` fails on Node 22 (verified locally: `fail 1`) | Addressed: Task 1 uses `node --test "tests/*.test.js"` |
| 2 | BLOCKER | Stale `vfsSlotTargets` survive a re-upload without the pair column | Addressed: Task 2 always overwrites, `[]` when missing |
| 3 | BLOCKER | Captured ClientSource from a previous session reused after re-login; `Request`-object fetch input not read | Addressed: Task 4 compares capture TS to `VFS_LAST_LOGIN_TS`; reads `Request.headers` |
| 4 | QUESTION | First check may run before the page captures a ClientSource | Accepted by user: use fallback, log origin |
| 5 | NICE | Log `clientSourceOrigin` to the Sheet | Addressed: Task 4 |
| 6 | NICE | `minimum_chrome_version: 111` for `world: MAIN` | Addressed: Task 4 |
| 7 | NICE | Anti-bot detection of patched fetch | Addressed: Risk 4 |

N/A for this repo: endpoint auth roles, DDD boundaries, migrations, async queues.
