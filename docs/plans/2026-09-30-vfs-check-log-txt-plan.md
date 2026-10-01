# Plan: Log every check activity to a local .txt file

## Input

Feature description (typed prompt): instead of the Google Sheet from [2026-09-30-vfs-check-log-sheet-plan.md](2026-09-30-vfs-check-log-sheet-plan.md), write every check activity (source country, destination/mission, slot result, `visaCategoryCode`, timestamp) to a plain local `.txt` file "for now" - a lower-effort interim that needs no Google account, Apps Script deployment, or external network call.

This repo has no ticket tracker, doc store, or CI configured (no Jira/Linear/Confluence/Notion, not a git repo), so those sections of the standard plan template are omitted rather than filled with placeholders.

**Scope of "activity" for this plan:** each `checkSlots()` result in `content.js` (slot found / no slot / error), same fields as the earlier Sheets plan. "For now" is read as: same data, different (simpler, local) sink. Logging additional activity types (login-watcher clicks, autofill events) is a real possibility but is out of the minimum viable scope below; see Scope Decisions.

## Rollback Path

Purely additive: one new message type (`vfs-log`, reused verbatim from the earlier Sheets plan so the two are compatible), two new functions in `background.js`, one new permission in `manifest.json`, ~6 new lines in `content.js`. Nothing existing is modified in place.

To roll back: revert the diff to `content.js`, `background.js`, `manifest.json`. To disable without reverting: flip a `const ENABLE_TXT_LOG = false` at the top of `background.js`; `appendLogEntry()` becomes a no-op and no file is ever written.

## Scope Decisions

**Minimum viable scope:** one flat text file, one entry format, no settings UI, no rotation UI, no read-path back into the extension (it's a write-only log for the user to open in a text editor).

**Complexity check:** 3 files touched (`content.js`, `background.js`, `manifest.json`). Under the 8-file trigger, no scope escalation needed.

**Why not reuse chrome.storage.local as the "file":** the ask is specifically a `.txt` file the user can open outside the browser, not extension-internal storage, so this plan writes through `chrome.downloads` to a real file on disk.

**Forward compatibility with the Sheets plan:** `content.js` sends the exact same `{type: 'vfs-log', entry}` message shape used in the Sheets plan. If the Sheets integration is built later, `background.js`'s `onMessage` handler can fan the same entry out to both the local file and the Apps Script POST, with zero changes to `content.js`.

## Affected Files

- `manifest.json` - add the `downloads` permission (not currently present).
- `background.js` - new queue/append logic and the actual `chrome.downloads.download()` call.
- `content.js` - build and send the log entry from `checkSlots()`.

No new services, no DDD boundaries apply (single-file extension, no backend).

## Architecture Diagram

```
content.js: checkSlots()
  |- existing path (unchanged): fetch lift-api -> showToast / sendPushAlert
  \- new: build logEntry -> chrome.runtime.sendMessage({type: 'vfs-log', entry})
                                    |
                                    v
background.js (service worker)
  onMessage('vfs-log') -> appendLogEntry(entry)
                              |
                              v
                  chrome.storage.local['vfsLogEntries']
                  (source of truth; capped at MAX_LOG_ENTRIES,
                   oldest dropped first)
                              |
                  scheduleLogWrite() - debounced ~3s so a burst
                  of entries becomes one file write, not many
                              |
                              v
                       writeLogFile()
                  format entries as pipe-delimited lines,
                  build a data: URL, call
                  chrome.downloads.download({conflictAction: 'overwrite'})
                              |
                              v
              Downloads/vfs-checker/vfs-check-log.txt
              (overwritten in full each write; chrome.downloads
               has no true append, see Risks)
```

## Tasks

### Task 1 - manifest.json: permission
- **Files to modify:** `manifest.json`
- Add `"downloads"` to `permissions` (alongside the existing `scripting`, `activeTab`, `tabs`, `notifications`, `offscreen`, `storage`).
- Users on an existing install will see Chrome's "extension wants a new permission" prompt on update; this is expected, not a bug.
- **Dependencies:** none, parallelizable with everything else.
- **Completeness: 10/10** - mechanical, no edge cases.

### Task 2 - background.js: entry storage, batching, file write
- **Files to modify:** `background.js`
- Add consts: `MAX_LOG_ENTRIES = 2000`, `LOG_WRITE_DEBOUNCE_MS = 3000`, `LOG_FILENAME = 'vfs-checker/vfs-check-log.txt'`, `ENABLE_TXT_LOG = true`.
- `appendLogEntry(entry)`: if `!ENABLE_TXT_LOG` return. Read `vfsLogEntries` from `chrome.storage.local` (default `[]`), push `entry`, if `length > MAX_LOG_ENTRIES` drop the oldest with `.slice(-MAX_LOG_ENTRIES)`, write back, call `scheduleLogWrite()`.
- `scheduleLogWrite()`: debounce with a module-level `logWriteTimer` - clear any pending timer, set a new `setTimeout(writeLogFile, LOG_WRITE_DEBOUNCE_MS)`. This turns a burst of near-simultaneous entries (unlikely at a 1-check/minute cadence today, but cheap insurance if more activity types are logged later) into a single file write.
- `writeLogFile()`: read `vfsLogEntries`, format each as one line (see format below), join with `\n`, build `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, call `chrome.downloads.download({url, filename: LOG_FILENAME, conflictAction: 'overwrite', saveAs: false})`. On the returned promise's rejection, `console.warn` the error and leave `vfsLogEntries` untouched so the next scheduled write retries with the same (plus any newly appended) data. Guard against overlapping writes with a `writeInFlight` boolean: if a write is in flight when the timer fires, just re-arm `scheduleLogWrite()` instead of calling `writeLogFile()` again immediately.
- Extend the existing `chrome.runtime.onMessage` listener: handle `msg.type === 'vfs-log'` by calling `appendLogEntry(msg.entry)`. Fire-and-forget, no `sendResponse` needed.
- **Line format (pipe-delimited, one entry per line):**
  ```
  2026-09-30T10:15:00.000Z | source=ind | destination=lva | vac=LVAIND | visaCategory=StudenL | result=no_slot | earliestDate=- | httpStatus=200 | error=-
  ```
- **Dependencies:** Task 1 (needs the `downloads` permission to not throw on `chrome.downloads.download`).
- **Completeness: 7/10** - covers append, batching, overwrite-retry-on-failure, and the cap. Does not cover the "user has 'Ask where to save each file' enabled in Chrome" case (see Risks) since the extension has no way to detect or change that setting.

### Task 3 - content.js: build and send the log entry
- **Files to modify:** `content.js`, inside `checkSlots()` (around [content.js:172-345](../../content.js#L172-L345))
- After each of the three outcomes (slot available / no slot / caught error), build the same `logEntry` shape as the Sheets plan:
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
- The `error` branch can run before `countryCode`/`missionCode`/`payload` are resolved (if `getAuthToken()` or `getUrlParams()` itself threw); fall back to re-calling `getUrlParams()` in the catch block if those locals are undefined, so an entry is still emitted for early failures.
- **Dependencies:** none strictly (sending to a not-yet-updated `background.js` just silently fails via `.catch(() => {})`), but do this after Task 2 so it can be tested end-to-end.
- **Completeness: 8/10** - covers all three outcomes including early-failure paths. Does not log when `!isApplicationDetailPage()`, since no real check runs there.

## Data Layer

No database. `chrome.storage.local['vfsLogEntries']` is the source of truth (capped at 2000 entries, oldest dropped first, see Task 2); the `.txt` file is a derived, fully-regenerated view of it on every write, not an independently-editable store. Not reversible in the schema-migration sense; if the line format changes later, old lines in the existing file simply stay in the old format since the file is plain text, not re-parsed.

## Test Coverage Table

No automated test runner exists in this repo (plain unbundled extension, verification is manual in a real Chrome tab, see [CLAUDE.md](../../CLAUDE.md)).

| Behavior | Where | How to verify | Edge cases covered |
|---|---|---|---|
| Slot-available check appends a line | `content.js` + `background.js` | Trigger a check with a stubbed `earliestDate` response, open `Downloads/vfs-checker/vfs-check-log.txt`, confirm a new line with `result=slot_available` | happy path |
| No-slot check appends a line | same | Normal check with no slot, confirm `result=no_slot` line | happy path |
| API-error check appends a line | same | Force a non-2xx response, confirm `result=error` with `httpStatus` and `error` populated | error path, same case the earlier silent-error-toast fix addressed |
| Burst of entries produces one write | `background.js` | Manually call `appendLogEntry` twice in quick succession from the service-worker console, confirm only one `chrome.downloads.download` call fires (check `chrome://downloads` history) | batching/debounce |
| File cap holds | `background.js` | Seed `vfsLogEntries` with 2100 fake entries via the service-worker console, call `appendLogEntry`, confirm stored length caps at 2000 | unbounded-growth risk |
| Feature disabled cleanly | `background.js` | Set `ENABLE_TXT_LOG = false`, confirm `appendLogEntry` returns immediately and no file write or console error occurs | rollback path |

## Auth & Data-Safety Impact

The log entry contains only `sourceCountry`, `missionCode`, `vacCode`, `visaCategoryCode`, `result`, `earliestDate`, `httpStatus`, `errorMessage`, and `timestamp`. It does not include the JWT (`getAuthToken()`'s return value), the hardcoded `loginUser` email, or any password. No credentials or session tokens are ever written to disk. The file lands in the user's own Downloads folder under a subfolder, readable only by whoever has local access to that machine, same trust boundary as any other browser download.

## Risks

1. **`chrome.downloads` has no true "append."** Each write regenerates the whole file from `vfsLogEntries` and re-downloads it with `conflictAction: 'overwrite'`. This also means a new entry shows up in `chrome://downloads` history on every write, not just the first.
   Blast radius: download history clutter; no data loss.
   Mitigation: the debounce in `scheduleLogWrite()` (Task 2) batches bursts into fewer writes; the entry cap keeps each write small.
   Detection: `chrome://downloads` growing unusually fast, or `vfs-check-log.txt`'s modified time changing far more often than the ~1/minute check cadence would suggest.

2. **If the user has Chrome's "Ask where to save each file before downloading" setting on, every write triggers a Save As dialog** instead of silently overwriting.
   Blast radius: the file effectively stops updating automatically until the user manually confirms each prompt, or dismisses/ignores them.
   Mitigation: document in `CLAUDE.md`/`README.md` that this setting must be off (`chrome://settings/downloads`) for automatic logging to work; the extension has no API to check or change this setting itself.
   Detection: user reports the log file isn't updating, or a stream of save dialogs appearing.

3. **Data URI size limit if `MAX_LOG_ENTRIES` is set too high or removed later.** Chrome's practical limit for `data:` URLs used in `chrome.downloads.download` is well above what 2000 short pipe-delimited lines produce (low hundreds of KB), but this is a soft ceiling worth knowing about before raising the cap.
   Blast radius: a write silently fails (download API rejects the URL) and the file stops updating, with only a `console.warn` in the service-worker console to notice it by.
   Mitigation: keep `MAX_LOG_ENTRIES` conservative (2000 lines is comfortably under any practical limit); if this needs to grow much larger, switch to a Blob URL or a native messaging host instead of a data URI.
   Detection: `writeLogFile()`'s rejection handler logging a warning; manual check of the file's last-modified time against the last few `checkSlots()` console logs.
