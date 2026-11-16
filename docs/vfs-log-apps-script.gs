// Apps Script source for the VFS check-log endpoint.
//
// Setup:
// 1. Open (or create) the target Google Sheet.
// 2. Extensions > Apps Script.
// 3. Replace Code.gs contents with this file, save.
// 4. In the sheet, add a tab named exactly "CheckLog" if it doesn't exist.
// 5. Project Settings > Script Properties > add a property named
//    SHEET_LOG_TOKEN with a long random value you generate yourself
//    (e.g. run `openssl rand -hex 24` locally). This is the shared
//    secret the extension must send on every request.
// 6. Deploy > New deployment > type "Web app":
//      Execute as: Me
//      Who has access: Anyone
//    Deploy, then copy the resulting /exec URL.
// 7. Put that URL in background.js as SHEET_LOG_URL, and the same
//    token value as SHEET_LOG_TOKEN.
//
// Redeploying after edits: Deploy > Manage deployments > edit the
// existing deployment > New version, so the /exec URL stays stable.

const SHEET_TAB_NAME = 'CheckLog';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const expectedToken = PropertiesService.getScriptProperties().getProperty('SHEET_LOG_TOKEN');

    if (!expectedToken || payload.token !== expectedToken) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, 403);
    }

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (entries.length === 0) {
      return jsonResponse({ ok: true, appended: 0 });
    }

    const sheet = getOrCreateSheet();
    const rows = entries.map((entry) => [
      entry.timestamp || '',
      entry.sourceCountry || '',
      entry.missionCode || '',
      entry.vacCode || '',
      entry.visaCategoryCode || '',
      entry.result || '',
      entry.earliestDate || '',
      entry.errorMessage || '',
      entry.httpStatus || '',
      entry.clientSourceOrigin || ''
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    return jsonResponse({ ok: true, appended: rows.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_TAB_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TAB_NAME);
    sheet.appendRow([
      'timestamp',
      'sourceCountry',
      'missionCode',
      'vacCode',
      'visaCategoryCode',
      'result',
      'earliestDate',
      'errorMessage',
      'httpStatus',
      'clientSourceOrigin' // added later: on an existing tab, type this header into column J by hand
    ]);
  }

  return sheet;
}

function jsonResponse(obj, statusCode) {
  // Apps Script web apps can't set arbitrary HTTP status codes on
  // ContentService output, so the caller (background.js) must treat
  // a non-{ok:true} JSON body as a failure regardless of transport status.
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
