# Plan: Log every VFS slot-check to a Google Sheet

## Input

Feature description (typed prompt): log every `checkSlots()` result — source country, destination/mission, slot result, `visaCategoryCode`, timestamp — to a spreadsheet, so reliability of the checker (is it actually running, how often does it error) can be tracked over time.

This repo has no ticket tracker, doc store, or CI configured (no Jira/Linear/Confluence/Notion, not a git repo) — those sections of the standard plan template are omitted rather than filled with placeholders. There is also no DDD/Nx structure here; "Affected Apps/Libs" collapses to the three existing extension files.

**Decisions locked in with the user before writing this plan:**
- Write path: **Google Apps Script Web App** bound to the target Sheet (extension POSTs JSON, script appends a row). Rejected: Sheets REST API + OAuth (too heavy for pure logging), Google Form submission trick (fragile, no delivery confirmation).
- Call site: **background service worker**, with a `chrome.storage.local`-backed queue flushed via `chrome.alarms`. Rejected: firing the POST directly from `content.js` with no retry — would lose exactly the failure rows this feature exists to capture (tab navigation, offline, endpoint hiccup).

## Rollback Path

Purely additive: one new message type (`vfs-log`), two new functions in `background.js`, ~6 new lines in `content.js`, one new permission in `manifest.json`. Nothing existing is modified in place — `checkSlots()`'s fetch/notify/toast logic is untouched.

To roll back: revert the diff to `content.js`, `background.js`, `manifest.json`. To disable without reverting: leave `SHEET_LOG_URL` unset in `background.js` — `flushLogQueue()` no-ops when it's empty, so entries just accumulate harmlessly in `chrome.storage.local` (capped, see Risks) until re-enabled or the diff is reverted.

## Scope Decisions

**Minimum viable scope:** one Apps Script endpoint, one queue, one message type. No settings UI, no popup changes, no historical backfill (can't backfill — past checks were never logged), no read-path (extension never reads the sheet back).

**Complexity check:** 3 files touched (`content.js`, `background.js`, `manifest.json`) + 1 new external artifact (the Apps Script). Under the 8-file trigger — no scope escalation needed.

**Config placement:** `SHEET_LOG_URL` and `SHEET_LOG_TOKEN` are hardcoded consts in `background.js`, matching the existing pattern of hardcoding account-specific values (`loginUser`, `visaCategoryCode` in `content.js`). If this ever needs to support multiple accounts/sheets, move it to `chrome.storage` + a popup settings field — out of scope now since only one account is in use.

## Architecture Diagram

```
content.js: checkSlots()
  ├─ existing path (unchanged): fetch lift-api → showToast / sendPushAlert
  └─ new: build logEntry → chrome.runtime.sendMessage({type:'vfs-log', entry})
                                      │
                                      ▼
background.js (service worker)
  onMessage('vfs-log') → enqueueLogEntry(entry)
                              │
                              ▼
                    chrome.storage.local['vfsLogQueue']  (durable across
                    service-worker restarts — MV3 workers die between events)
                              │
              chrome.alarms 'vfs-log-flush' (~every 1 min) triggers
                              ▼
                     flushLogQueue()
                              │
                    POST JSON → Apps Script Web App URL
                    (header/body carries SHEET_LOG_TOKEN)
                         │              │
                    200 OK          non-200 / network error
                         │              │
              remove flushed        leave in queue, retry
              entries from queue    next alarm tick (capped at 500)
                                          │
                                          ▼
                               Google Sheet (via Apps Script doPost,
                               validates token, appends row)
```

## Tasks

### Task 1 — Apps Script: create the logging endpoint
- **Files:** none in this repo (lives in Google Apps Script, bound to the target Sheet). Document the script source in `docs/vfs-log-apps-script.gs` for reference/version history.
- **What:** `doPost(e)` — parse `e.postData.contents` as JSON, verify `payload.token === PROPERTIES.SHEET_LOG_TOKEN` (else return 403), append a row `[timestamp, sourceCountry, missionCode, vacCode, visaCategoryCode, result, earliestDate, errorMessage, httpStatus]` to a fixed sheet tab (e.g. `CheckLog`), return `{ok: true}`.
- **Deploy:** Deploy → New deployment → Web app, execute as "Me", access "Anyone" (unauthenticated, since the extension can't do Google OAuth) — the token is what stands in for auth here.
- **Dependencies:** none (do first — everything else needs the URL).
- **Completeness: 7/10** — happy path + bad-token rejection covered; no rate-limiting inside the script itself (rely on queue cap + Apps Script's own daily quota).

### Task 2 — `manifest.json`: permissions
- **Files to modify:** `manifest.json`
- Add `"alarms"` to `permissions`.
- Add `"https://script.google.com/*"` to `host_permissions` (Apps Script web app URLs resolve under this origin).
- **Dependencies:** none, parallelizable with Task 1.
- **Completeness: 10/10** — mechanical, no edge cases.

### Task 3 — `background.js`: queue + flush logic
- **Files to modify:** `background.js`
- Add consts: `SHEET_LOG_URL`, `SHEET_LOG_TOKEN`, `MAX_QUEUE_SIZE = 500`.
- `enqueueLogEntry(entry)`: read `vfsLogQueue` from `chrome.storage.local` (default `[]`), push `entry`, if `length > MAX_QUEUE_SIZE` drop oldest entries (`.slice(-MAX_QUEUE_SIZE)`), write back, then call `flushLogQueue()` immediately (don't wait for the next alarm — most checks should log in near-real-time when the network is fine).
- `flushLogQueue()`: read queue; if empty, return. If `SHEET_LOG_URL` is falsy, return (disabled state, see Rollback). POST the queue as a JSON array to `SHEET_LOG_URL` with `{token: SHEET_LOG_TOKEN, entries: queue}`. On success (`response.ok`), clear the queue. On failure, log a warning and leave the queue for the next alarm tick — do not throw (this runs inside an alarm listener with no caller to catch it).
- Register `chrome.alarms.create('vfs-log-flush', {periodInMinutes: 1})` at top level (service-worker-safe — `chrome.alarms` persists across worker restarts, unlike `setInterval`).
- `chrome.alarms.onAlarm.addListener` → if `alarm.name === 'vfs-log-flush'`, call `flushLogQueue()`.
- Extend the existing `chrome.runtime.onMessage` listener: handle `msg.type === 'vfs-log'` → `enqueueLogEntry(msg.entry)`, `sendResponse({ok: true})`. Fire-and-forget from the caller's side — no `return true` needed since there's nothing async the caller must wait on.
- **Dependencies:** Task 1 (needs the real URL to test end-to-end), Task 2 (needs `alarms` permission to not throw on `chrome.alarms.create`).
- **Completeness: 8/10** — covers success, failure/retry, queue cap. Does not cover partial-batch failure (Apps Script either accepts the whole batch or none) — acceptable since batches are typically 1 entry given the 1-per-minute check cadence and immediate flush-on-enqueue.

### Task 4 — `content.js`: build and send the log entry
- **Files to modify:** `content.js`, inside `checkSlots()` (around [content.js:172-345](content.js#L172-L345), the same function fixed for the earlier silent-error bug)
- After each of the three outcomes (slot available / no slot / caught error), build:
  ```js
  const logEntry = {
    timestamp: new Date().toISOString(),
    sourceCountry: countryCode,
    missionCode,
    vacCode,
    visaCategoryCode: payload.visaCategoryCode,
    result: 'slot_available' | 'no_slot' | 'error',
    earliestDate: data?.earliestDate ?? null,
    errorMessage: error?.message ?? null,
    httpStatus: response?.status ?? null
  };
  chrome.runtime.sendMessage({type: 'vfs-log', entry: logEntry}).catch(() => {});
  ```
- Note the `error` branch runs when `countryCode`/`missionCode`/`payload` may not be defined yet if `getAuthToken()` or `getUrlParams()` itself threw — guard with the values already resolved at that point, falling back to `getUrlParams()` freshly if needed, so a log entry is still emitted even for early failures.
- **Dependencies:** Task 3 (message type must exist on the receiving end, though sending to a not-yet-updated background.js just silently fails via the `.catch(() => {})`, so order isn't strictly blocking).
- **Completeness: 8/10** — covers all three outcomes including early-failure paths; does not attempt to log when `!isApplicationDetailPage()` (checker isn't running a real check there, so there's nothing to log — by design, not a gap).

## Data Layer

No database/migration involved — the "data layer" here is the Google Sheet itself (schema = column headers in the `CheckLog` tab, defined by Task 1's `doPost`). Not reversible in the schema-migration sense; if the row shape changes later, old rows simply have blank trailing columns — no backfill needed since this is an append-only log, not a queryable state store.

## Test Coverage Table

No automated test runner exists in this repo (plain unbundled extension, verification is manual in a real Chrome tab — see [CLAUDE.md](../../CLAUDE.md)). Manual verification steps per behavior:

| Behavior | Where | How to verify | Edge cases covered |
|---|---|---|---|
| Slot-available check logs a row | `content.js` checkSlots() + Sheet | Trigger a check on a page where `earliestDate` is present (or temporarily stub the response), confirm row appears in `CheckLog` within ~1 min | happy path |
| No-slot check logs a row | same | Normal check with no slot, confirm row with `result: 'no_slot'` | happy path |
| API-error check logs a row | same | Force a non-2xx (e.g. bad token) and confirm a row with `result: 'error'`, `httpStatus`, `errorMessage` populated | error path, ties into the earlier silent-error-toast fix |
| Queue survives offline endpoint | `background.js` | Point `SHEET_LOG_URL` at an unreachable host temporarily, run a few checks, confirm entries accumulate in `chrome.storage.local.get('vfsLogQueue')`, then restore the URL and confirm the next alarm tick flushes them all | reliability guarantee — this is the whole point of the queue |
| Queue cap holds | `background.js` | Manually seed `vfsLogQueue` with 600 fake entries via the extension's service-worker console, trigger `enqueueLogEntry`, confirm length caps at 500 | unbounded-growth risk |
| Feature disabled cleanly | `background.js` | Clear `SHEET_LOG_URL`, confirm `flushLogQueue()` returns immediately and no errors appear in the service-worker console | rollback path |

## Risks

1. **Apps Script web app URL is public (unauthenticated by Google, since the extension can't do OAuth).**
   Blast radius: anyone who obtains the URL could spam rows into the Sheet.
   Mitigation: shared-secret `token` check in `doPost`, rejecting mismatched/missing tokens with 403 before touching the Sheet.
   Detection: unexpected rows with a source/pattern that doesn't match the extension's own payload shape, or a spike in Apps Script execution count in the Google Cloud/Apps Script dashboard.

2. **Apps Script daily quota (consumer accounts: ~20,000 URL Fetch/execution calls/day).**
   Blast radius: at 1 check/minute that's ~1,440 calls/day from this alone — comfortably under quota for a single account, but would matter if this pattern is reused for multiple accounts/tabs later.
   Mitigation: batch the queue (Task 3 sends the whole queue in one POST, not one call per entry) so bursts don't multiply calls.
   Detection: `flushLogQueue()` failures logged in the service-worker console; queue length growing without shrinking is the visible symptom.

3. **`chrome.storage.local` queue grows unbounded if the endpoint is broken for a long time.**
   Blast radius: `chrome.storage.local` has an ~10MB default quota (unlimited with the `unlimitedStorage` permission, not requested here) — at small JSON entries this would take a very long outage to matter, but an unbounded queue is still a latent bug.
   Mitigation: `MAX_QUEUE_SIZE = 500` cap in `enqueueLogEntry`, dropping oldest entries (Task 3).
   Detection: manual check of `chrome.storage.local.get('vfsLogQueue')` length via the service-worker console during an incident.
