# Plan: UAE (`are`) slot check by driving the page's dropdowns

## Input

Feature request (typed prompt, with 4 screenshots of the `/application-detail` step "Appointment Details"). Follows `2026-10-29-multi-vac-slot-targets-plan.md`.

**Why:** for `are`, our own `CheckIsSlotAvailable` call returns 401. The `ClientSource` header looks generated per request by the VFS page, so a captured or hardcoded value does not work. Instead of calling the API ourselves, the extension operates the page's dropdowns and lets the page make the call with a valid header.

**Requested behaviour:**
1. Applies when the URL country is `are` (`/are/en/lva/...`). Other routes keep the current API flow.
2. Three dropdowns, filled in order, with a **10 second gap between each selection**:
   - "Choose your Application Centre": options "Latvia Visa application center- Abu Dhabi" and "...- Dubai". Picked from the CSV `vacCode` (AUH, DXB).
   - "Choose your appointment category": options "Do not test category", "Long Stay", "Short Stay". Pick "Do not test category" if present, otherwise "Long Stay" (user's decision, ignores the CSV category value on this flow).
   - "Choose your sub-category": pick the first option.
3. If a dropdown has a single option the page auto-selects it. Skip that step.
4. **Slot detection (user's decision): read the page's own API response.** `page-hook.js` already wraps `fetch`/XHR in the page's MAIN world, so it also records the response of the page's own `CheckIsSlotAvailable` call. No on-screen text is parsed.

**Assumptions to confirm (cheap to change):**
- The 10 s gap also applies between centres in one cycle.
- The 2.5 minute timer still runs from the end of a cycle.
- The CSV pair `AUH|LL` still selects the centre from `AUH`; the `LL` part is not used for `are`.

No ticket tracker is attached. R.I.C.E. gate skipped (modifies existing code).

## Open item blocking implementation

I cannot open the logged-in VFS page, so selectors are unverified. Before coding I need, from the VFS tab (DevTools, Elements, right-click the element, Copy, Copy outerHTML):
- the `<mat-select ...>` element of each of the three dropdowns (one paste is enough, I need its attributes such as `formcontrolname`, `id`, `aria-label`),
- one `<mat-option>` from an opened list.

Fallback if not provided: find each dropdown by its label text ("Choose your Application Centre", and so on) and the `mat-select` nearest to it. This is the first approach in Task 2 anyway, so the HTML is a check, not a dependency.

## Rollback Path

Additive. The dropdown flow is behind one check (`countryCode === 'are'`) at the top of `checkSlots()`. To disable without reverting: change `UI_FLOW_COUNTRIES` to `[]`; every route then uses the existing API flow. Full rollback: `git revert` the commit and reload the extension. `page-hook.js` response recording is passive and can be removed by dropping its manifest entry. No data migration; storage keys are additive (`VFS_LAST_SLOT_RESPONSE` in sessionStorage). Two-way door.

## Scope Decisions

**Minimum viable scope:** one UI flow function, one pure option-matching helper, response capture in the hook. No popup changes, no new CSV columns, no settings UI, no change to non-`are` routes.

**Out of scope:** booking steps after "Appointment Details", the category from the CSV, auto-detecting centre labels from the page (a small static map covers AUH and DXB), any other country.

**Complexity check:** 5 files (content.js, page-hook.js, slot-targets.js, tests/slot-targets.test.js, CLAUDE.md). Under the 8-file trigger.

## Affected Files

| File | Change | Blast radius if wrong |
|---|---|---|
| `content.js` | `runUiFlowCycle()`, dropdown helpers, branch in `checkSlots()`, shared alert/backoff handling | Slot loop; a stuck `checking` flag stops polling |
| `page-hook.js` | record page's own `CheckIsSlotAvailable` request body + response (status, `earliestDate`) | Must never alter or delay the page's requests |
| `slot-targets.js` | pure helpers `matchCentreOption`, `pickCategoryOption`, `VAC_CENTRE_LABELS` | Wrong centre or category selected |
| `tests/slot-targets.test.js` | tests for the helpers | none |
| `CLAUDE.md` | document the flow, new sessionStorage key, selectors | docs drift |

Ownership: single maintainer.

## Architecture Diagram

```
content.js: checkSlots()  (every 2.5 min, on /application-detail)
  countryCode == 'are' ?
   ├─ no  → existing API loop (unchanged)
   └─ yes → runUiFlowCycle(targets)
        for each target {vacCode}:                      (10s gap before every step below)
          1. select Application Centre  ← matchCentreOption(options, vacCode)   [skip if single]
          2. select appointment category ← pickCategoryOption(options)          [skip if single]
          3. select sub-category         ← first option                         [skip if single]
          page (not us) calls CheckIsSlotAvailable with its own ClientSource
                │
   page-hook.js (MAIN world) wraps fetch/XHR
        └─ on lift-api CheckIsSlotAvailable: store {ts, status, vacCode, visaCategoryCode,
           earliestDate} in sessionStorage['VFS_LAST_SLOT_RESPONSE']
                │
          4. wait up to RESPONSE_WAIT_MS for a record with ts > step-3 time and matching vacCode
             ├─ 429             → rate_limited → existing backoff + logout (abort rest)
             ├─ earliestDate    → slot_available (collected)
             ├─ other 2xx       → no_slot
             └─ none in time    → error "no response from page"
          sendCheckLogEntry per target → background → Sheet (unchanged)
        after loop: one combined alert / no-slot push / error push (same as API flow)
        finally: checking=false; scheduleNextCheck() unless in backoff
```

## Tasks

### 1. Pure helpers + tests
- **Modify:** `slot-targets.js`, `tests/slot-targets.test.js`
- `VAC_CENTRE_LABELS = { AUH: 'abu dhabi', DXB: 'dubai' }`.
- `matchCentreOption(optionTexts, vacCode)` → index or -1: case-insensitive `includes` of the label for that `vacCode`. Unknown `vacCode` → -1 (caller logs an error for that target and moves on). `null` vacCode (legacy) → 0.
- `pickCategoryOption(optionTexts)` → index of the first option matching `/do not test category/i`, else index of `/long stay/i`, else -1.
- Tests: both centres, unknown code, null code, category priority (test-category present and absent), `Long Stay` fallback, none found, case and whitespace variants.
- `null` vacCode only reaches `matchCentreOption` if Task 4 passes raw stored targets (review finding 1); a test pins `null → 0`.
- Dependencies: none. Completeness: 9/10

### 2. Dropdown driver in `content.js`
- **Modify:** `content.js`
- Constants: `UI_FLOW_COUNTRIES = ['are']`, `UI_STEP_GAP_MS = 10000`, `RESPONSE_WAIT_MS = 20000`.
- `findSelectByLabel(labelText)`: locate the label element containing the text, return the nearest `mat-select` within its section; verify against the HTML from the open item.
- `readOptions(select)`: click the trigger, wait for `mat-option` elements in `.cdk-overlay-container`, return `{texts, elements}`; always close the panel (Escape) if nothing is clicked.
- `selectOption(select, pickFn)`: if the select is disabled or has 1 option, it is already selected, return `{skipped: true}`; otherwise click the matched option, wait for the panel to close.
- `selectedText(select)`: text of `.mat-mdc-select-value-text` / `.mat-select-value-text`, used to detect auto-selected and already-selected state.
- Already-selected centre: selecting the same value does not fire the page's call, so first select the other centre (extra 10 s gap), then the target. With 2+ CSV centres the cycle alternates and this never triggers; it only happens with a single-centre CSV (review Q4). The switched-away centre's page response is logged to the Sheet as its own row, not discarded.
- Every step: `await sleep(UI_STEP_GAP_MS)` before acting; re-check `isApplicationDetailPage()` and `getAuthToken()` after each gap and stop the cycle if either is gone (same guard as the API loop).
- User-interaction guard (review Q5): remember the option text set at each step. Before each next step, compare `selectedText()` of the dropdowns already set; on mismatch stop the cycle and log `result=error`, "user interaction detected". No retry within the cycle; the next cycle starts fresh.
- Log each step: label, chosen option text, or `skipped (single option)` (review finding 6).
- Dependencies: Task 1. Completeness: 7/10 (selectors unverified until the HTML is provided).

### 3. Capture the page's own response in `page-hook.js`
- **Modify:** `page-hook.js`
- For requests to `lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable` only:
  - fetch: record request body (string) and `response.clone().json()` result, status.
  - XHR: wrap `send(body)` to keep the body, and add a `loadend` listener that reads `status` and the body by `responseType` (review finding 3): `xhr.response` when `'json'`, `responseText` when `''`/`'text'`, otherwise log once "unsupported responseType" and record status only. Never touch `responseText` for other types (it throws).
- Write `sessionStorage['VFS_LAST_SLOT_RESPONSE'] = JSON.stringify({ts, status, vacCode, visaCategoryCode, earliestDate})`. Parse the request body inside try/catch.
- The `ClientSource` capture from the previous plan stays for non-`are` routes.
- Everything in try/catch; never await or alter the original call; never store the JWT or cookies.
- Dependencies: none, parallel with Tasks 1 and 2. Completeness: 7/10

### 4. Wire the flow into `checkSlots()`
- **Modify:** `content.js`
- After the session-age check, if `UI_FLOW_COUNTRIES.includes(countryCode)`, call `runUiFlowCycle(rawTargets, ctx)`. It returns the same per-target statuses (`slot` / `none` / `error` / `rate_limited`), so the existing alert, 429 backoff, Sheet logging (`clientSourceOrigin: 'page'`) and `finally` code is reused unchanged.
- Pass **raw** stored targets (`getStoredSlotTargets()`), not `getSlotTargets()` output, so a legacy `vacCode: null` stays `null` and means "selected or first centre" instead of the derived `LVAARE` (review finding 1). Empty storage → one `{vacCode: null}` target.
- `waitForPageResponse(sinceTs, vacCode)`: `sinceTs` = the moment that target's **step 1** starts, not step 3 (review finding 2: when the sub-category is auto-selected, the page's call fires at step 2). Return the latest record with `ts >= sinceTs` and matching `vacCode` (any vacCode when target is `null`); if none yet, poll every 500 ms up to `RESPONSE_WAIT_MS` after the last step.
- Sheet row `visaCategoryCode` = the category option text actually chosen (e.g. "Do not test category"), since the CSV category is unused on this flow (review finding 6).
- Remove the hardcoded `clientSource` object from the API flow only if the user confirms (the line on `content.js` ~747 currently holds a pasted value, left untouched).
- Dependencies: Tasks 2 and 3. Completeness: 8/10

### 5. Docs
- **Modify:** `CLAUDE.md`: new flow, key `VFS_LAST_SLOT_RESPONSE`, label and option rules, the 10 s gap, why `are` is different. Correct "Nuxt/Vue" to Angular (Material) where it describes the VFS SPA (review finding 7).
- Dependencies: Tasks 2-4. Completeness: 9/10

### 6. Manual verification in Chrome (cannot be automated here)
- Reload the extension, refresh the VFS tab, log in, open `/application-detail` for are→lva.
- Expect: three selections each 10 s apart, one `CheckIsSlotAvailable` call made by the page per target (DevTools Network), `VFS_LAST_SLOT_RESPONSE` updated, one Sheet row per target, no 401.
- Check: a single-option dropdown is skipped; the already-selected centre case switches away and back; page works normally with the hook loaded.

## Data Layer

None. One additive sessionStorage key: `VFS_LAST_SLOT_RESPONSE` = `{ts, status, vacCode, visaCategoryCode, earliestDate}`.

## Test Coverage Table

| Behavior | File | Type | Edge cases covered |
|---|---|---|---|
| Centre option from vacCode | `tests/slot-targets.test.js` | unit | AUH, DXB, unknown, null, case and spacing |
| Category option rule | `tests/slot-targets.test.js` | unit | test-category present, absent, no Long Stay, empty list |
| Dropdown selection order and 10 s gaps | manual | e2e (Chrome) | timing visible in console logs |
| Single-option dropdown skipped | manual | e2e | auto-selected sub-category |
| Already-selected centre re-triggers the call | manual | e2e | switch away and back |
| Response capture (fetch and XHR) | stubbed node smoke test | unit-style | matching vacCode, 429 status, bad body, XHR `responseType` `''`/`'json'`/`'blob'` |
| Response matched when sub-category auto-selected | manual | e2e | page call fires at step 2 |
| Legacy CSV (null vacCode) on `are` | manual | e2e | uses selected/first centre, no `LVAARE` error |
| User clicks a dropdown mid-cycle | manual | e2e | cycle stops, "user interaction detected" row |
| 429 from page's call → backoff | code review | review | not provoked on live VFS |
| Non-`are` route unchanged | manual | e2e | API flow still used |

The slot loop and dropdown driver live inside the `content.js` function wrapper and cannot be unit-tested without refactoring; that gap is accepted.

## Auth & Data-Safety Impact

- The extension no longer sends its own `CheckIsSlotAvailable` call for `are`, so it no longer needs a valid `ClientSource` there. It still reads the JWT via `getAuthToken()` for the session check.
- The hook reads slot response bodies (dates only) and writes them to the page's own sessionStorage. It must not record the `Authorize` header, cookies, or request headers other than the existing `ClientSource` capture.
- The tokens and cookies the user pasted into the chat during debugging should be treated as exposed (log out of that session).

## Risks

1. **Re-selecting the same value does not make the page call the API.**
   - What: on cycle 2 the target centre is already selected, so nothing is requested and we time out.
   - Blast radius: every cycle after the first records "no response"; no alerts.
   - Mitigation: switch to the other centre first, then the target. If the page offers only one centre, fall back to toggling the category option, and if that fails, report the limitation in the log.
   - Detection: Sheet rows with `result=error` and message "no response from page".

2. **Selectors break or differ from the screenshots (Angular Material version, hidden panels).**
   - Blast radius: the `are` checker does nothing but log errors.
   - Mitigation: find by label text, log which element was found, always close an opened panel; confirm with the outerHTML from the open item.
   - Detection: console `[VFS Extension] dropdown not found: <label>`; Sheet errors.

3. **Slow cycles and extra page traffic.**
   - What: 3 steps x 10 s per centre plus a possible switch-away step makes a cycle 1 to 2.5 minutes, and each selection can trigger the page's own calls, raising 429 risk.
   - Blast radius: longer cooldowns via the existing backoff.
   - Mitigation: single `UI_STEP_GAP_MS` constant; a 429 recorded by the hook aborts the cycle and runs the existing logout path.
   - Detection: `rate_limited` rows in the Sheet.

4. **Response capture breaks or is noticed.**
   - What: reading `response.clone()` or XHR `loadend` fails, or VFS anti-bot detects the patched APIs.
   - Blast radius: the `are` flow reports "no response", other routes unaffected.
   - Mitigation: try/catch everywhere, remove the manifest entry to disable; the original request is never delayed.
   - Detection: errors in the Sheet; login or dashboard breaks only with the hook loaded.

## Review record

**2026-10-29, eng lens (`/bstack:plan-review`, default mode).** Findings and outcome:

| # | Type | Finding | Outcome |
|---|---|---|---|
| 1 | BLOCKER | `getSlotTargets()` turns `vacCode: null` into `LVAARE`, so legacy CSVs on `are` always fail `matchCentreOption` (verified in `content.js`) | Addressed: Task 4 passes raw stored targets |
| 2 | BLOCKER | Matching only responses after step 3 misses the page call fired at step 2 when sub-category auto-selects | Addressed: Task 4 matches from step 1 start, latest record |
| 3 | BLOCKER | XHR `responseText` throws for non-text `responseType` | Addressed: Task 3 reads by `responseType` |
| 4 | QUESTION | Switch-away only for single-centre CSV; its extra page response | User: log it as its own Sheet row |
| 5 | QUESTION | User interaction during a 1-2.5 min cycle | User: add guard, stop cycle on mismatch |
| 6 | NICE | Log chosen option per step; real category text in Sheet | Addressed: Tasks 2, 4 |
| 7 | NICE | CLAUDE.md says Nuxt/Vue; selectors are Angular Material | Addressed: Task 5 |

Still open (non-blocking, see "Open item"): `mat-select`/`mat-option` outerHTML to confirm selectors. N/A: endpoint auth, DDD, migrations, queues.
