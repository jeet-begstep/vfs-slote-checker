const fileInput = document.getElementById('csvFile');
const status = document.getElementById('status');
const previewRoot = document.querySelector('.preview-body');
const rowPicker = document.getElementById('rowPicker');
const rowSelect = document.getElementById('rowSelect');
const autofillBtn = document.getElementById('autofillBtn');
const autofillStatus = document.getElementById('autofillStatus');

let loadedRows = [];

function setStatus(message, tone = 'info') {
  status.textContent = message;
  status.className = `status ${tone}`;
}

function setAutofillStatus(message, tone = '') {
  autofillStatus.textContent = message;
  autofillStatus.className = `autofill-status ${tone}`.trim();
}

fileInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;

  console.log('[VFS Extension] Selected file:', file.name, file.size, 'bytes');
  setStatus(`Reading ${file.name}...`, 'info');

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const rows = parseCSV(e.target.result);
      console.log('[VFS Extension] Parsed CSV rows:', rows);
      loadedRows = rows;

      if (!rows.length) {
        setStatus('CSV file is empty or invalid.', 'error');
        previewRoot.innerHTML = '<div class="empty">No valid rows found.</div>';
        rowPicker.classList.remove('visible');
        return;
      }

      renderPreview(rows);
      populateRowPicker(rows);

      rows.forEach((row) => console.log('[VFS Extension] Row:', row));

      const rowToSend = rows[0] || {};
      const sourceCountry = rowToSend.source || 'default';
      const destinationCountry = rowToSend.destination || 'default';

      const baseVfsUrl = `https://visa.vfsglobal.com/${sourceCountry || 'default'}/en/${destinationCountry || 'default'}`;
      console.log('[VFS Extension] Redirecting active tab to base VFS URL:', baseVfsUrl);
      const { targets, invalid } = saveRowConfig(rowToSend);
      setStatus(`Loaded ${rows.length} row(s). ${describeTargets(targets, invalid)}`, invalid.length ? 'error' : 'success');
      await redirectToVfsLogin(sourceCountry, destinationCountry);
    } catch (err) {
      setStatus(`Error parsing file: ${err.message}`, 'error');
    }
  };

  reader.onerror = () => {
    setStatus('Error reading file.', 'error');
  };

  reader.readAsText(file);
});

const MAX_RECOMMENDED_TARGETS = 4;

// Saves credentials and slot-check targets for content.js. Always overwrites
// vfsSlotTargets so centers from a previous upload are never checked by mistake;
// an empty list makes content.js fall back to its legacy single check.
function saveRowConfig(row) {
  const usernameValue = row.email || row.user || row.username || '';
  const passwordValue = row.password || row.pass || '';
  const { targets, invalid } = parseSlotTargets(findSlotTargetColumn(row));

  try {
    chrome.storage.local.set({
      vfsAutofillUsername: usernameValue,
      vfsAutofillPassword: passwordValue,
      vfsSlotTargets: targets
    });
  } catch (e) {
    console.error('[VFS Extension] Failed to save row config to storage:', e);
  }

  console.log('[VFS Extension] Saved slot targets:', targets, 'invalid:', invalid);
  return { targets, invalid };
}

function describeTargets(targets, invalid) {
  const parts = [];
  if (targets.length) {
    const list = targets.map((t) => `${t.vacCode || '(auto)'}|${t.visaCategoryCode}`).join(', ');
    parts.push(`Centers: ${list}.`);
  } else {
    parts.push('No centers found, using default check.');
  }
  if (invalid.length) parts.push(`Invalid: ${invalid.join(', ')}.`);
  if (targets.length > MAX_RECOMMENDED_TARGETS) {
    parts.push(`${targets.length} centers per cycle may trigger rate limits.`);
  }
  return parts.join(' ');
}

async function redirectToVfsLogin(sourceCountry, destinationCountry) {
  console.log('[VFS Extension] Redirecting to VFS login page with source:', sourceCountry, 'and destination:', destinationCountry);
  const baseVfsUrl = `https://visa.vfsglobal.com/${sourceCountry || 'default'}/en/${destinationCountry || 'default'}/login`;
  console.log('[VFS Extension] Redirecting active tab to base VFS URL:', baseVfsUrl);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    chrome.tabs.update(tab.id, { url: baseVfsUrl });
  } else {
    console.error('[VFS Extension] No active tab found to redirect.');
  }
}

function populateRowPicker(rows) {
  if (rows.length === 0) {
    rowPicker.classList.remove('visible');
    return;
  }

  rowSelect.innerHTML = '';
  rows.forEach((row, idx) => {
    const label = rowLabel(row, idx);
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = label;
    rowSelect.appendChild(opt);
  });

  rowPicker.classList.add('visible');
  setAutofillStatus('');
}

function rowLabel(row, idx) {
  const keys = Object.keys(row);
  const nonSecretKeys = keys.filter((k) => !/pass|secret|token|credential/i.test(k));
  const parts = nonSecretKeys.slice(0, 3).map((k) => `${k}: ${row[k]}`);
  return parts.length ? `Row ${idx + 1} — ${parts.join(', ')}` : `Row ${idx + 1}`;
}

autofillBtn.addEventListener('click', async () => {
  const idx = Number(rowSelect.value);
  const row = loadedRows[idx];
  if (!row) {
    setAutofillStatus('No row selected.', 'error');
    return;
  }

  autofillBtn.disabled = true;
  autofillBtn.textContent = 'Filling...';
  setAutofillStatus('Filling selected row...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('visa.vfsglobal.com')) {
    autofillBtn.disabled = false;
    autofillBtn.textContent = 'Autofill selected row';
    setAutofillStatus('Open the VFS Global login page first, then click Autofill.', 'error');
    return;
  }

  const usernameValue = row.email || row.user || row.username || '';
  const passwordValue = row.password || row.pass || '';
  const { targets, invalid } = saveRowConfig(row);
  const targetsSummary = describeTargets(targets, invalid);
  const targetsTone = invalid.length ? 'error' : 'success';

  chrome.tabs.sendMessage(tab.id, { type: 'AUTOFILL', row, usernameValue, passwordValue }, (response) => {
    autofillBtn.disabled = false;
    autofillBtn.textContent = 'Autofill selected row';

    if (chrome.runtime.lastError) {
      setAutofillStatus('Could not reach the page. Reload once after installing/updating the extension.', 'error');
      return;
    }
    if (!response || !response.success) {
      setAutofillStatus('Could not find matching fields on this page.', 'error');
      return;
    }
    setAutofillStatus(`Filled ${response.filled} field(s). ${targetsSummary} Review and log in manually.`, targetsTone);
  });
});

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = splitCSVLine(lines[0]).map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = (values[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function renderPreview(rows) {
  if (rows.length === 0) {
    previewRoot.innerHTML = '<div class="empty">No rows found.</div>';
    return;
  }

  const headers = Object.keys(rows[0]);
  let html = '<table><thead><tr>';
  headers.forEach((h) => (html += `<th>${escapeHTML(h)}</th>`));
  html += '</tr></thead><tbody>';

  rows.slice(0, 10).forEach((row) => {
    html += '<tr>';
    headers.forEach((h) => {
      const isSecret = /pass|secret|token|credential/i.test(h);
      const val = isSecret ? '••••••' : row[h];
      html += `<td>${escapeHTML(val)}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';

  if (rows.length > 10) {
    html += `<div class="empty">...and ${rows.length - 10} more row(s).</div>`;
  }

  previewRoot.innerHTML = html;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// --- notification self-test -------------------------------------------------

const testNotifyBtn = document.getElementById('testNotifyBtn');
const testNotifyStatus = document.getElementById('testNotifyStatus');

if (testNotifyBtn) {
  testNotifyBtn.addEventListener('click', async () => {
    testNotifyStatus.textContent = 'Sending...';
    testNotifyStatus.className = 'autofill-status';

    try {
      const result = await chrome.runtime.sendMessage({ type: 'vfs-test-notify' });

      if (result && result.ok) {
        testNotifyStatus.textContent = 'Sent. If you see nothing, allow Chrome in macOS System Settings > Notifications.';
        testNotifyStatus.className = 'autofill-status success';
      } else {
        testNotifyStatus.textContent = `Failed: ${result && result.error}`;
        testNotifyStatus.className = 'autofill-status error';
      }
    } catch (error) {
      testNotifyStatus.textContent = `Failed: ${error.message}`;
      testNotifyStatus.className = 'autofill-status error';
    }
  });
}
