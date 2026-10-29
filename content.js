 (() => {
  'use strict';

  // Prevent duplicate initialization
  if (window.__VFS_SLOT_CHECKER_RUNNING__) {
    console.log('[VFS Extension] Already running');
    return;
  }

  window.__VFS_SLOT_CHECKER_RUNNING__ = true;

  const CHECK_INTERVAL_MS = 2.5 * 60 * 1000; // 2.5 minutes
  const STAGGER_MS = 30000; // gap between centers within one cycle
  const STAGGER_JITTER_MS = 2000;
  const LEGACY_VISA_CATEGORY_CODE = 'EmployL';
  const API_URL =
    'https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable';

  // Used only when page-hook.js hasn't captured the page's own ClientSource
  // since the last login.
  const FALLBACK_CLIENT_SOURCE =
    'imMG/l4MmYDsEvVPyHan3Tsc8dbxyD66qU4ZBAHKdDpkczriHRLjkHzXgYB97EXeat02vIldwprT+J+KOiXkH6btSCRq92U2f91aTt/B5XSq2XBUxYbA5OuL8CG3bnyxGChchENtdnUGvQz8eF4mZJjBy84dgS78ETWrQZnCFY+TLVbCzZ635iwf2JGwZjE5gC2p6ejNFdTrRQZmfmVbms7mH5Z4cALUUuFS3XjYxzYJmFmz/i+3Bg+V8Jg0o7OGs0xcfpbQs/Cij2PtjSqrgE0JJxiEmNLJFwZvDYplnZSK0PcttKJMJX9NkCwyIcXHePVVcfMzF26y5bJTtyGtlQ==';

  let timer = null;
  let checking = false;
  let lastUrl = location.href;

  console.log('[VFS Extension] Content script started');
  console.log('[VFS Extension] Current URL:', location.href);

  // -------------------------------------------------------
  // URL / VFS ROUTE
  // -------------------------------------------------------

  function isApplicationDetailPage() {
    return window.location.pathname
      .toLowerCase()
      .includes('/application-detail');
  }

  function isDashboardPage() {
    const url = window.location.href.toLowerCase();
    return url.includes('/dashboard');
  }

  function getUrlParams() {
    const pathSegments = window.location.pathname
      .split('/')
      .filter(Boolean);

    const countryCode = pathSegments[0]
      ? pathSegments[0].toLowerCase()
      : 'ind';

    const missionCode = pathSegments[2]
      ? pathSegments[2].toLowerCase()
      : 'lva';

    return {
      countryCode,
      missionCode
    };
  }

  // -------------------------------------------------------
  // 429 BACKOFF STATE & PERSISTENCE
  // -------------------------------------------------------

  const BACKOFF_STORAGE_KEY_ATTEMPT = 'VFS_429_ATTEMPT';
  const BACKOFF_STORAGE_KEY_RETRY_TS = 'VFS_429_NEXT_RETRY_TS';
  const BACKOFF_STORAGE_KEY_ACTIVE = 'VFS_429_IN_BACKOFF';
  const BACKOFF_STORAGE_KEY_REASON = 'VFS_429_REASON';

  // -------------------------------------------------------
  // SESSION AGE TRACKING (force re-login every 29 minutes)
  // -------------------------------------------------------

  const LOGIN_TIME_STORAGE_KEY = 'VFS_LAST_LOGIN_TS';
  const SESSION_MAX_AGE_MS = 27 * 60 * 1000; // 29 minutes
  const SESSION_TIMEOUT_COOLDOWN_MIN = 10; // minutes

  function recordLoginTime() {
    try {
      localStorage.setItem(LOGIN_TIME_STORAGE_KEY, String(Date.now()));
      console.log('[VFS Extension] Login time recorded:', new Date().toLocaleString());
    } catch (e) {}
  }

  function getLoginTime() {
    try {
      const ts = Number(localStorage.getItem(LOGIN_TIME_STORAGE_KEY) || 0);
      return ts || null;
    } catch (e) {
      return null;
    }
  }

  function getSessionAgeMs() {
    const loginTs = getLoginTime();
    if (!loginTs) return 0;
    return Date.now() - loginTs;
  }

  function getBackoffState() {
    try {
      const inBackoff = localStorage.getItem(BACKOFF_STORAGE_KEY_ACTIVE) === 'true';
      const attempt = Number(localStorage.getItem(BACKOFF_STORAGE_KEY_ATTEMPT) || 0);
      const nextRetryTs = Number(localStorage.getItem(BACKOFF_STORAGE_KEY_RETRY_TS) || 0);
      const reason = localStorage.getItem(BACKOFF_STORAGE_KEY_REASON) || 'rate_limit';
      const remainingMs = Math.max(0, nextRetryTs - Date.now());
      return {
        inBackoff,
        attempt,
        nextRetryTs,
        remainingMs,
        reason
      };
    } catch (e) {
      return { inBackoff: false, attempt: 0, nextRetryTs: 0, remainingMs: 0, reason: 'rate_limit' };
    }
  }

  function setBackoffState(attempt, backoffMinutes, reason = 'rate_limit') {
    try {
      const nextRetryTs = Date.now() + backoffMinutes * 60 * 1000;
      localStorage.setItem(BACKOFF_STORAGE_KEY_ACTIVE, 'true');
      localStorage.setItem(BACKOFF_STORAGE_KEY_ATTEMPT, String(attempt));
      localStorage.setItem(BACKOFF_STORAGE_KEY_RETRY_TS, String(nextRetryTs));
      localStorage.setItem(BACKOFF_STORAGE_KEY_REASON, reason);
      console.log(
        `[VFS Extension] Backoff set (${reason}): attempt ${attempt}, waiting ${backoffMinutes}m until ${new Date(nextRetryTs).toLocaleTimeString()}`
      );
    } catch (e) {
      console.error('[VFS Extension] Failed to save backoff state:', e);
    }
  }

  function clearBackoffState() {
    try {
      localStorage.removeItem(BACKOFF_STORAGE_KEY_ACTIVE);
      localStorage.removeItem(BACKOFF_STORAGE_KEY_ATTEMPT);
      localStorage.removeItem(BACKOFF_STORAGE_KEY_RETRY_TS);
      localStorage.removeItem(BACKOFF_STORAGE_KEY_REASON);
      console.log('[VFS Extension] 429 Backoff state cleared');
    } catch (e) {}
  }

  // -------------------------------------------------------
  // MY ACCOUNT DROPDOWN & LOGOUT AUTOMATION
  // -------------------------------------------------------

  function getMyAccountTrigger() {
    const candidateSelectors = [
      'button[aria-haspopup="menu"]',
      'button.mat-mdc-menu-trigger',
      'button.mat-menu-trigger',
      'a.mat-mdc-menu-trigger',
      'a.mat-menu-trigger',
      '[aria-label*="account" i]',
      '[aria-label*="profile" i]',
      '[aria-label*="user" i]',
      '.account-menu',
      '.profile-menu',
      '.user-menu',
      'button',
      'a',
      'div[role="button"]'
    ];

    for (const selector of candidateSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (!isElementVisible(el)) continue;

        const text = (el.textContent || el.value || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const id = (el.id || '').toLowerCase();
        const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();

        const matchesAccountText =
          text.includes('my account') ||
          text.includes('account') ||
          text.includes('profile') ||
          aria.includes('my account') ||
          aria.includes('account') ||
          aria.includes('profile') ||
          id.includes('account') ||
          className.includes('account') ||
          /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text);

        if (matchesAccountText) {
          return el;
        }

        // Also check if positioned in the top-right header area
        const rect = el.getBoundingClientRect();
        if (rect.top < 120 && rect.right > window.innerWidth * 0.5) {
          if (
            className.includes('menu-trigger') ||
            el.hasAttribute('aria-haspopup') ||
            aria.includes('user') ||
            text.includes('@')
          ) {
            return el;
          }
        }
      }
    }

    return null;
  }

  function getLogoutMenuItem() {
    const candidateContainers = [
      '.mat-mdc-menu-panel',
      '.mat-menu-panel',
      '.cdk-overlay-container',
      '[role="menu"]',
      '.dropdown-menu',
      'body'
    ];

    const itemSelectors = [
      'button',
      'a',
      '[role="menuitem"]',
      '.mat-mdc-menu-item',
      '.mat-menu-item',
      'span',
      'div'
    ];

    for (const containerSel of candidateContainers) {
      const container = document.querySelector(containerSel);
      if (!container) continue;

      for (const itemSel of itemSelectors) {
        const items = container.querySelectorAll(itemSel);
        for (const item of items) {
          if (!isElementVisible(item)) continue;

          const text = (item.textContent || item.value || '').trim().toLowerCase();
          const aria = (item.getAttribute('aria-label') || '').trim().toLowerCase();

          if (
            text.includes('logout') ||
            text.includes('log out') ||
            text.includes('sign out') ||
            text.includes('signout') ||
            aria.includes('logout') ||
            aria.includes('sign out')
          ) {
            return item;
          }
        }
      }
    }

    return null;
  }

  async function triggerUiLogout(maxWaitMs = 8000) {
    console.log('[VFS Extension] Initiating UI logout via My Account dropdown...');
    showToast('⚠️ 429 Rate Limit hit. Logging out...', 'error');

    const start = Date.now();
    let menuOpened = false;

    // 1. Try to find and click the "My Account" trigger
    while (Date.now() - start < maxWaitMs) {
      if (!menuOpened) {
        const accountTrigger = getMyAccountTrigger();
        if (accountTrigger) {
          console.log('[VFS Extension] Found My Account trigger in top-right:', accountTrigger);
          accountTrigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
          accountTrigger.focus();
          accountTrigger.click();
          menuOpened = true;
          await new Promise((r) => setTimeout(r, 600)); // wait for overlay animation
        }
      }

      if (menuOpened) {
        const logoutItem = getLogoutMenuItem();
        if (logoutItem) {
          console.log('[VFS Extension] Found Logout menu item in dropdown:', logoutItem);
          logoutItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
          logoutItem.focus();
          logoutItem.click();
          console.log('[VFS Extension] Clicked Logout button successfully.');
          showToast('✅ Logged out successfully.', 'success');
          return true;
        }
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    console.warn('[VFS Extension] UI Logout elements not found, using fallback logout.');
    // Fallback: Clear JWT tokens and redirect to login page
    try {
      sessionStorage.removeItem('JWT');
      localStorage.removeItem('JWT');
    } catch (e) {}

    const { countryCode, missionCode } = getUrlParams();
    const loginUrl = `https://visa.vfsglobal.com/${countryCode}/en/${missionCode}/login`;
    console.log('[VFS Extension] Fallback redirecting to login:', loginUrl);
    window.location.href = loginUrl;
    return false;
  }

  // -------------------------------------------------------
  // AUTOFILL CREDENTIALS (saved by the popup before redirecting to login)
  // -------------------------------------------------------

  const AUTOFILL_USERNAME_KEY = 'vfsAutofillUsername';
  const AUTOFILL_PASSWORD_KEY = 'vfsAutofillPassword';

  function getStoredAutofillCredentials() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({ username: '', password: '' });
        return;
      }
      chrome.storage.local.get([AUTOFILL_USERNAME_KEY, AUTOFILL_PASSWORD_KEY], (result) => {
        resolve({
          username: (result && result[AUTOFILL_USERNAME_KEY]) || '',
          password: (result && result[AUTOFILL_PASSWORD_KEY]) || ''
        });
      });
    });
  }

  function clearStoredAutofillCredentials() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.remove([AUTOFILL_USERNAME_KEY, AUTOFILL_PASSWORD_KEY]);
  }

  // [{vacCode, visaCategoryCode}] parsed from the CSV by the popup (slot-targets.js).
  const SLOT_TARGETS_KEY = 'vfsSlotTargets';

  // Appointment category text from the CSV "category" column ('' = default pick).
  function getStoredUiCategory() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve('');
        return;
      }
      chrome.storage.local.get(['vfsUiCategory'], (result) => {
        resolve(String((result && result.vfsUiCategory) || '').trim());
      });
    });
  }

  function getStoredSlotTargets() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve([]);
        return;
      }
      chrome.storage.local.get([SLOT_TARGETS_KEY], (result) => {
        const targets = result && result[SLOT_TARGETS_KEY];
        resolve(Array.isArray(targets) ? targets.filter((t) => t && t.visaCategoryCode) : []);
      });
    });
  }

  // -------------------------------------------------------
  // CLIENT SOURCE (captured from the page by page-hook.js)
  // -------------------------------------------------------

  const CLIENT_SOURCE_STORAGE_KEY = 'VFS_CLIENT_SOURCE';
  const CLIENT_SOURCE_TS_STORAGE_KEY = 'VFS_CLIENT_SOURCE_TS';
  // The page sends lift-api requests during login, slightly before the dashboard
  // watcher stamps VFS_LAST_LOGIN_TS. Anything older is from a previous session.
  const CLIENT_SOURCE_LOGIN_TOLERANCE_MS = 2 * 60 * 1000;

  function getClientSource() {
    try {
      const value = sessionStorage.getItem(CLIENT_SOURCE_STORAGE_KEY);
      const capturedTs = Number(sessionStorage.getItem(CLIENT_SOURCE_TS_STORAGE_KEY) || 0);
      const loginTs = getLoginTime() || 0;

      if (value && capturedTs >= loginTs - CLIENT_SOURCE_LOGIN_TOLERANCE_MS) {
        console.log(
          `[VFS Extension] ClientSource captured ${Math.round((Date.now() - capturedTs) / 1000)}s ago`
        );
        return { value, origin: 'captured' };
      }

      console.log(
        '[VFS Extension] ClientSource not used:',
        value
          ? `captured value is older than last login (captured ${new Date(capturedTs).toLocaleTimeString()}, login ${new Date(loginTs).toLocaleTimeString()})`
          : 'nothing captured yet (is page-hook.js loaded? reload the extension and refresh the tab)'
      );
    } catch (e) {}

    return { value: FALLBACK_CLIENT_SOURCE, origin: 'fallback' };
  }

  // -------------------------------------------------------
  // TOKEN
  // -------------------------------------------------------

  function getAuthToken() {
    try {
      const sessionToken = sessionStorage.getItem('JWT');

      if (sessionToken) {
        console.log('[VFS Extension] JWT found in sessionStorage');
        return sessionToken;
      }

      const localToken = localStorage.getItem('JWT');

      if (localToken) {
        console.log('[VFS Extension] JWT found in localStorage');
        return localToken;
      }

      console.log('[VFS Extension] JWT not found');

      return null;
    } catch (error) {
      console.error(
        '[VFS Extension] Failed to read JWT:',
        error
      );

      return null;
    }
  }

  // -------------------------------------------------------
  // NOTIFICATION
  // -------------------------------------------------------

  async function sendPushAlert(title, message) {
    console.log('[VFS Extension] ALERT:', title, message);

    // chrome.notifications does NOT exist in content scripts, so the desktop
    // notification and its sound are raised by the background service worker.
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'vfs-notify',
        title: title,
        message: message
      });

      if (!result || !result.ok) {
        console.warn(
          '[VFS Extension] Background notification failed:',
          result && result.error
        );
      }
    } catch (error) {
      console.error(
        '[VFS Extension] Could not reach background worker:',
        error
      );
    }

    // In-page beep as well. Only audible while this tab is open, but it is
    // instant and does not depend on macOS notification permissions.
    try {
      const AudioContext =
        window.AudioContext ||
        window.webkitAudioContext;

      if (AudioContext) {
        const audioContext = new AudioContext();

        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const oscillator =
          audioContext.createOscillator();

        const gainNode =
          audioContext.createGain();

        oscillator.type = 'sine';

        oscillator.frequency.setValueAtTime(
          880,
          audioContext.currentTime
        );

        gainNode.gain.setValueAtTime(
          0.5,
          audioContext.currentTime
        );

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.start();

        oscillator.stop(
          audioContext.currentTime + 1.5
        );
      }
    } catch (error) {
      console.log(
        '[VFS Extension] Sound blocked:',
        error
      );
    }
  }

  // -------------------------------------------------------
  // CHECK LOG (Google Sheet via background worker)
  // -------------------------------------------------------

  function sendCheckLogEntry({
    countryCode,
    missionCode,
    vacCode,
    visaCategoryCode,
    clientSourceOrigin = null,
    result,
    earliestDate = null,
    errorMessage = null,
    httpStatus = null
  }) {
    const entry = {
      timestamp: new Date().toISOString(),
      sourceCountry: countryCode,
      missionCode,
      vacCode,
      visaCategoryCode,
      clientSourceOrigin,
      result,
      earliestDate,
      errorMessage,
      httpStatus
    };

    chrome.runtime.sendMessage({ type: 'vfs-log', entry }).catch(() => {});
  }

  // -------------------------------------------------------
  // CHECK SLOT
  // -------------------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Resolves stored targets to concrete {vacCode, visaCategoryCode} pairs.
  // vacCode null (legacy "EmployL" CSV) or no stored targets -> derived vacCode,
  // which preserves the pre-multi-center behaviour.
  async function getSlotTargets(legacyVacCode) {
    const stored = await getStoredSlotTargets();

    if (!stored.length) {
      return [{ vacCode: legacyVacCode, visaCategoryCode: LEGACY_VISA_CATEGORY_CODE }];
    }

    return stored.map((target) => ({
      vacCode: target.vacCode || legacyVacCode,
      visaCategoryCode: target.visaCategoryCode
    }));
  }

  // One API call for one center/category. Never throws.
  async function checkOneTarget(target, ctx) {
    const logBase = {
      countryCode: ctx.countryCode,
      missionCode: ctx.missionCode,
      vacCode: target.vacCode,
      visaCategoryCode: target.visaCategoryCode,
      clientSourceOrigin: ctx.clientSource.origin
    };

    try {
      const token = getAuthToken();

      if (!token) {
        throw new Error('No JWT');
      }

      const payload = {
        countryCode: ctx.countryCode,
        missionCode: ctx.missionCode,
        vacCode: target.vacCode,
        visaCategoryCode: target.visaCategoryCode,
        roleName: 'Individual',
        loginUser: ctx.loginUser,
        payCode: ''
      };

      const response = await fetch(API_URL, {
        method: 'POST',

        headers: {
          'Accept':
            'application/json, text/plain, */*',

          'Accept-Language':
            'en-GB,en-US;q=0.9,en;q=0.8',

          'Authorize': token,

          'ClientSource': ctx.clientSource.value,

          'Content-Type':
            'application/json;charset=UTF-8',

          'Route': ctx.routeHeader
        },

        body: JSON.stringify(payload)
      });

      console.log(
        `[VFS Extension] API status (${target.vacCode}/${target.visaCategoryCode}):`,
        response.status
      );

      if (response.status === 429) {
        console.warn('[VFS Extension] 429 Too Many Requests detected');

        sendCheckLogEntry({
          ...logBase,
          result: 'rate_limited',
          errorMessage: 'HTTP 429 Too Many Requests',
          httpStatus: 429
        });

        return { status: 'rate_limited' };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.warn(
          `[VFS Extension] HTTP ${response.status} for ${target.vacCode}/${target.visaCategoryCode} (ClientSource ${ctx.clientSource.origin}):`,
          body.slice(0, 300)
        );
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      // 2xx: backoff is cleared once per cycle in checkSlots(), not here, so a
      // 429 on a later center still escalates from the previous attempt count.
      const data = await response.json();

      console.log(
        '[VFS Extension] API response:',
        data
      );

      if (data && data.earliestDate) {
        console.log(
          '[VFS Extension] 🚨 SLOT AVAILABLE:',
          target.vacCode,
          data.earliestDate
        );

        sendCheckLogEntry({
          ...logBase,
          result: 'slot_available',
          earliestDate: data.earliestDate,
          httpStatus: response.status
        });

        return { status: 'slot', earliestDate: data.earliestDate };
      }

      console.log(
        `[VFS Extension] No slot available at ${target.vacCode}/${target.visaCategoryCode}`
      );

      sendCheckLogEntry({
        ...logBase,
        result: 'no_slot',
        httpStatus: response.status
      });

      return { status: 'none' };

    } catch (error) {

      console.log(
        `[VFS Extension] API error (${target.vacCode}/${target.visaCategoryCode}):`,
        error
      );

      sendCheckLogEntry({
        ...logBase,
        result: 'error',
        errorMessage: error?.message,
        httpStatus: error?.message?.startsWith('HTTP ')
          ? Number(error.message.slice(5))
          : null
      });

      return { status: 'error', errorMessage: error?.message };
    }
  }

  // Calls the API once per target, STAGGER_MS apart. Stops at the first 429.
  async function runApiCycle(targets, ctx) {
    const results = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      if (i > 0) {
        const jitter = Math.round((Math.random() * 2 - 1) * STAGGER_JITTER_MS);
        await sleep(STAGGER_MS + jitter);

        // User may have navigated away or been logged out during the gap.
        if (!isApplicationDetailPage() || !getAuthToken()) {
          console.log(
            '[VFS Extension] Page or session changed mid-cycle. Skipping remaining targets.'
          );
          break;
        }
      }

      console.log(
        `[VFS Extension] Checking ${target.vacCode}/${target.visaCategoryCode} (${i + 1}/${targets.length})`
      );

      const result = await checkOneTarget(target, ctx);
      results.push({ label: `${target.vacCode}/${target.visaCategoryCode}`, ...result });

      if (result.status === 'rate_limited') break;
    }

    return results;
  }

  // -------------------------------------------------------
  // UAE DROPDOWN FLOW
  // The page itself calls CheckIsSlotAvailable (with a valid ClientSource)
  // when the dropdowns change; page-hook.js copies the result into
  // sessionStorage['VFS_LAST_SLOT_RESPONSE'] and we read it from there.
  // -------------------------------------------------------

  const UI_FLOW_COUNTRIES = ['are'];
  const UI_STEP_GAP_MS = 10000; // wait before every dropdown selection
  const RESPONSE_WAIT_MS = 20000;
  // Pause between finishing one centre and starting the next (the page answered "Repeated Delay", code 33, to faster switching).
  const CENTRE_GAP_MS = 20000;
  // HTTP 409 + retry-after: the page shows a countdown (max ~30s), closes it and re-sends the call itself.
  const RETRY_WAIT_MS = 40000;
  // Worst case for one centre: 3 gated steps + response wait + slack.
  const UI_TARGET_BUDGET_MS = 3 * UI_STEP_GAP_MS + RESPONSE_WAIT_MS + RETRY_WAIT_MS + CENTRE_GAP_MS + 15000;
  const SLOT_RESPONSE_STORAGE_KEY = 'VFS_LAST_SLOT_RESPONSE';

  const UI_LABELS = {
    centre: 'choose your application centre',
    category: 'choose your appointment category',
    subCategory: 'choose your sub-category'
  };

  // Innermost element whose text contains labelText.
  function findLabelElement(labelText) {
    const candidates = Array.from(
      document.querySelectorAll('mat-label, label, legend, h1, h2, h3, h4, h5, h6, p, span, div')
    ).filter((el) =>
      normalizeOptionText(el.textContent).includes(labelText) &&
      // Text inside a dropdown (placeholder, selected value) is not the label.
      !el.closest('mat-select')
    );

    return candidates.find((el) =>
      !Array.from(el.children).some((child) => normalizeOptionText(child.textContent).includes(labelText))
    ) || null;
  }

  // First mat-select after the label, in the nearest ancestor that contains one.
  function findSelectByLabel(labelText) {
    const labelEl = findLabelElement(labelText);
    if (!labelEl) return null;

    for (let node = labelEl.parentElement; node && node !== document.body; node = node.parentElement) {
      const select = Array.from(node.querySelectorAll('mat-select')).find((s) =>
        labelEl.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (select) return select;
    }

    return null;
  }

  function selectedText(select) {
    const el = select && select.querySelector('.mat-mdc-select-value-text, .mat-select-value-text');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function isSelectDisabled(select) {
    return select.getAttribute('aria-disabled') === 'true' ||
      select.classList.contains('mat-mdc-select-disabled') ||
      select.classList.contains('mat-select-disabled');
  }

  function getOpenOptions() {
    const overlay = document.querySelector('.cdk-overlay-container');
    if (!overlay) return [];
    let options = Array.from(overlay.querySelectorAll('mat-option'));
    if (!options.length) options = Array.from(overlay.querySelectorAll('[role="option"]'));
    return options.filter(isElementVisible);
  }

  function optionText(option) {
    const el = option.querySelector('.mdc-list-item__primary-text, .mat-option-text') || option;
    return el.textContent.replace(/\s+/g, ' ').trim();
  }

  async function openSelect(select) {
    const trigger = select.querySelector('.mat-mdc-select-trigger, .mat-select-trigger') || select;
    trigger.click();

    for (let i = 0; i < 30; i++) {
      const options = getOpenOptions();
      if (options.length) return options;
      await sleep(100);
    }

    return [];
  }

  // waitForAutoClose: true after clicking an option (the panel closes itself);
  // false when nothing was clicked, so the panel is still open on purpose.
  async function closeSelectPanel(waitForAutoClose = true) {
    // The panel normally closes by itself after an option click (~200ms
    // animation), so give it time before sending anything.
    for (let i = 0; waitForAutoClose && i < 4 && getOpenOptions().length; i++) await sleep(150);
    if (!getOpenOptions().length) return;

    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
    );
    await sleep(300);
    if (!getOpenOptions().length) return;

    // Last resort: the most recently opened backdrop (our panel's), never the
    // first one, which could belong to a dialog.
    const backdrops = document.querySelectorAll('.cdk-overlay-transparent-backdrop, .cdk-overlay-backdrop');
    const backdrop = backdrops[backdrops.length - 1];
    if (backdrop) backdrop.click();

    await sleep(300);
  }

  // Opens the dropdown under labelText, clicks option pickIndex(texts), closes it.
  // A disabled or single-option dropdown that already has a value is skipped.
  async function uiSelect(labelText, pickIndex) {
    const select = findSelectByLabel(labelText);
    if (!select) return { ok: false, error: `dropdown not found: ${labelText}` };

    const current = selectedText(select);

    if (isSelectDisabled(select)) {
      return current
        ? { ok: true, skipped: true, text: current }
        : { ok: false, error: `dropdown disabled: ${labelText}` };
    }

    const options = await openSelect(select);
    if (!options.length) {
      await closeSelectPanel(false);
      return { ok: false, error: `no options: ${labelText}` };
    }

    const texts = options.map(optionText);
    const idx = pickIndex(texts);

    // A single option the page already selected: nothing to do, but only if it
    // is the one we want (otherwise fall through to the "no matching option"
    // error instead of waiting for a response that will never match).
    if (texts.length === 1 && current && idx === 0) {
      await closeSelectPanel(false);
      return { ok: true, skipped: true, text: current };
    }

    if (idx < 0) {
      await closeSelectPanel(false);
      return { ok: false, error: `no matching option for ${labelText}: ${texts.join(' | ')}` };
    }

    const unchanged = normalizeOptionText(texts[idx]) === normalizeOptionText(current);
    const clickedAt = Date.now();
    options[idx].click();
    await sleep(500);
    await closeSelectPanel();

    return { ok: true, text: texts[idx], clickedAt, unchanged };
  }

  function readSlotResponse() {
    try {
      return JSON.parse(sessionStorage.getItem(SLOT_RESPONSE_STORAGE_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  // The page may call the API at step 2 (sub-category auto-selected) or at
  // step 3, so prefer a response after the last click, else accept any
  // response since step 1 began.
  async function waitForPageResponse(sinceTs, lastActionTs, vacCode) {
    const matches = (record, fromTs) =>
      record &&
      record.ts >= fromTs &&
      (!vacCode || !record.vacCode || String(record.vacCode).toUpperCase() === vacCode);

    let deadline = Date.now() + RESPONSE_WAIT_MS;
    let pending409 = null; // last 409 seen: wait for the page's automatic retry
    while (Date.now() < deadline) {
      const record = readSlotResponse();
      if (matches(record, lastActionTs) && (!pending409 || record.ts > pending409.ts)) {
        if (record.status !== 409) return record;
        console.log('[VFS Extension] HTTP 409 from page, waiting for its automatic retry');
        pending409 = record;
        deadline = Date.now() + RETRY_WAIT_MS;
      }
      await sleep(500);
    }

    if (pending409) return pending409; // no retry arrived: reported as HTTP 409
    const record = readSlotResponse();
    return matches(record, sinceTs) ? record : null;
  }

  function finishUiTarget(target, ctx, label, categoryText, result) {
    const resultName = {
      slot: 'slot_available',
      none: 'no_slot',
      rate_limited: 'rate_limited',
      error: 'error'
    }[result.status];

    sendCheckLogEntry({
      countryCode: ctx.countryCode,
      missionCode: ctx.missionCode,
      vacCode: target.vacCode,
      visaCategoryCode: categoryText,
      clientSourceOrigin: 'page',
      result: resultName,
      earliestDate: result.earliestDate || null,
      errorMessage: result.errorMessage || null,
      httpStatus: result.httpStatus || null
    });

    if (result.status === 'error') {
      console.warn(`[VFS Extension] ${label}: ${result.errorMessage}`);
    }

    return { label, extra: Boolean(target.extra), ...result };
  }

  // Centre -> category -> sub-category, UI_STEP_GAP_MS before each, then the
  // page's own response. Never throws.
  async function runUiFlowTarget(target, ctx) {
    const label = `${target.vacCode || 'centre'}${target.extra ? ' (switch)' : ''}`;
    const sinceTs = Date.now();
    const expected = []; // what we set, for the user-interaction guard
    let lastActionTs = sinceTs;
    let categoryText = null;
    let centreUnchanged = false;

    const steps = [
      { label: UI_LABELS.centre, pick: (texts) => matchCentreOption(texts, target.vacCode) },
      { label: UI_LABELS.category, pick: (texts) => pickCategoryOption(texts, ctx.uiCategory) },
      { label: UI_LABELS.subCategory, pick: (texts) => (texts.length ? 0 : -1) }
    ];

    try {
      for (const step of steps) {
        await sleep(UI_STEP_GAP_MS);

        if (!isApplicationDetailPage() || !getAuthToken()) {
          return finishUiTarget(target, ctx, label, categoryText, {
            status: 'error',
            errorMessage: 'page or session changed mid-cycle',
            abort: true
          });
        }

        // Only a dropdown that exists and shows a different value counts; one
        // that is briefly missing (Angular re-render) or empty is not the user.
        const changed = expected.find((e) => {
          const now = normalizeOptionText(selectedText(findSelectByLabel(e.label)));
          return now && now !== normalizeOptionText(e.text);
        });
        if (changed) {
          return finishUiTarget(target, ctx, label, categoryText, {
            status: 'error',
            errorMessage: `user interaction detected (${changed.label})`,
            abort: true
          });
        }

        const result = await uiSelect(step.label, step.pick);
        if (!result.ok) {
          return finishUiTarget(target, ctx, label, categoryText, {
            status: 'error',
            errorMessage: result.error
          });
        }

        console.log(
          `[VFS Extension] ${label}: ${step.label} -> ${result.skipped ? `skipped (single option: ${result.text})` : result.text}`
        );

        if (result.clickedAt) lastActionTs = result.clickedAt;
        if (step.label === UI_LABELS.centre) centreUnchanged = Boolean(result.unchanged || result.skipped);
        if (step.label === UI_LABELS.category) categoryText = result.text;
        expected.push({ label: step.label, text: result.text });
      }

      if (centreUnchanged) {
        console.warn(
          `[VFS Extension] ${label}: centre was already selected; the page may not re-check it.`
        );
      }

      const record = await waitForPageResponse(sinceTs, lastActionTs, target.vacCode);

      if (!record) {
        return finishUiTarget(target, ctx, label, categoryText, {
          status: 'error',
          errorMessage: centreUnchanged
            ? 'no response from page (centre unchanged, nothing to re-check)'
            : 'no response from page'
        });
      }

      console.log(`[VFS Extension] ${label}: page response`, record);

      if (record.status === 429) {
        return finishUiTarget(target, ctx, label, categoryText, { status: 'rate_limited', httpStatus: 429 });
      }

      if (record.status < 200 || record.status >= 300) {
        return finishUiTarget(target, ctx, label, categoryText, {
          status: 'error',
          errorMessage: `HTTP ${record.status}`,
          httpStatus: record.status
        });
      }

      if (record.earliestDate) {
        return finishUiTarget(target, ctx, label, categoryText, {
          status: 'slot',
          earliestDate: record.earliestDate,
          httpStatus: record.status
        });
      }

      return finishUiTarget(target, ctx, label, categoryText, { status: 'none', httpStatus: record.status });

    } catch (error) {
      await closeSelectPanel().catch(() => {});
      return finishUiTarget(target, ctx, label, categoryText, {
        status: 'error',
        errorMessage: error?.message || String(error)
      });
    }
  }

  async function runUiFlowCycle(rawTargets, ctx) {
    const centreSelect = findSelectByLabel(UI_LABELS.centre);

    if (!centreSelect) {
      return [finishUiTarget({ vacCode: null }, ctx, 'centre', null, {
        status: 'error',
        errorMessage: `dropdown not found: ${UI_LABELS.centre}`
      })];
    }

    const currentCode = vacCodeForCentreText(selectedText(centreSelect));

    // Raw stored targets keep vacCode null for legacy CSVs -> the selected
    // (or first) centre. The CSV category is not used on this flow, so
    // AUH|LL and AUH|LLN collapse to one centre. See planUiTargets().
    const targets = planUiTargets(rawTargets, currentCode);

    console.log(
      '[VFS Extension] UI flow targets:',
      targets.map((t) => `${t.vacCode || 'first'}${t.extra ? ' (switch)' : ''}`).join(', '),
      '| currently selected:',
      currentCode || 'unknown'
    );

    const results = [];

    for (const [i, target] of targets.entries()) {
      if (i > 0) await sleep(CENTRE_GAP_MS);

      // A centre takes ~3 steps + the response wait. Don't start one that could
      // run past the session limit; the next cycle's session check handles the
      // logout.
      if (getSessionAgeMs() + UI_TARGET_BUDGET_MS >= SESSION_MAX_AGE_MS) {
        console.log(
          '[VFS Extension] Session close to the 29m limit. Skipping remaining centres this cycle.'
        );
        break;
      }

      const result = await runUiFlowTarget(target, ctx);
      results.push(result);
      if (result.status === 'rate_limited' || result.abort) break;
    }

    return results;
  }

  async function checkSlots() {

    if (!isApplicationDetailPage()) {
      console.log(
        '[VFS Extension] Not application-detail page. Skipping.'
      );

      scheduleNextCheck();

      return;
    }

    if (checking) {
      console.log(
        '[VFS Extension] Check already running. Skipping.'
      );

      return;
    }

    checking = true;

    console.log(
      '[VFS Extension] ============================='
    );

    console.log(
      '[VFS Extension] Checking slots at:',
      new Date().toLocaleString()
    );

    try {

      if (!getAuthToken()) {
        console.log(
          '[VFS Extension] No JWT. Will retry later.'
        );

        return;
      }

      const creds = await getStoredAutofillCredentials();

      const {
        countryCode,
        missionCode
      } = getUrlParams();

      const legacyVacCode =
        `${missionCode}${countryCode}`.toUpperCase();

      const routeHeader =
        `${countryCode}/en/${missionCode}`;

      const clientSource = { origin: 'hardcoded', value: 'sA0tYVdQTOvTbuf4WtZ2+4RP93P2UfkkQcrsID92/mq0fjQJfmNMwvJFH3wNUYuf+GXSN0DV0O34YxwygRQ2Z5YLOJnroLeqey8HGrhLMSeBUUMte3/aHM9+Yqhxb/wUXXa3nk4zkSG7P3Z2zZ/dqUItxz51t1iVijTdjJcZaQqJczA3NuSZHK3l5hlLJu2IvHoND+UcXVuJD5P+ZxaeTBVsRs56ryKQMgpegd1Pjb1tZRtmcPis7f/jCBn3T/8XsdZJPx9kNWNXysyydYjslQLvs8ahKtxPM2Ayo/Dbh/KT6+qG1zb7LjkteLi1+iC3oNeJ7Y2a+uHRtQsDGZ9NYQ==' }; // was getClientSource()

      const targets = await getSlotTargets(legacyVacCode);

      console.log(
        '[VFS Extension] Country:',
        countryCode,
        'Mission:',
        missionCode
      );

      console.log(
        '[VFS Extension] Targets:',
        targets.map((t) => `${t.vacCode}/${t.visaCategoryCode}`).join(', ')
      );

      console.log(
        `[VFS Extension] ClientSource: ${clientSource.origin} (${clientSource.value.slice(0, 12)}...)`
      );

      const sessionAgeMs = getSessionAgeMs();

      if (sessionAgeMs >= SESSION_MAX_AGE_MS) {
        console.warn(
          `[VFS Extension] Session age ${Math.round(sessionAgeMs / 60000)}m >= 29m limit. Forcing re-login.`
        );

        setBackoffState(1, SESSION_TIMEOUT_COOLDOWN_MIN, 'session_timeout');

        sendCheckLogEntry({
          countryCode,
          missionCode,
          vacCode: targets.map((t) => t.vacCode).join(','),
          visaCategoryCode: targets.map((t) => t.visaCategoryCode).join(','),
          clientSourceOrigin: clientSource.origin,
          result: 'session_timeout',
          errorMessage: 'Session exceeded 29 minute limit'
        });

        await sendPushAlert(
          '🔄 VFS Session Refresh',
          `Session active for 29+ minutes. Logging out and waiting ${SESSION_TIMEOUT_COOLDOWN_MIN}m before re-login.`
        );

        stopChecker();
        await triggerUiLogout();
        return;
      }

      const ctx = {
        countryCode,
        missionCode,
        routeHeader,
        loginUser: creds.username,
        clientSource,
        uiCategory: UI_FLOW_COUNTRIES.includes(countryCode) ? await getStoredUiCategory() : ''
      };

      // UAE: drive the page's dropdowns and read the page's own API response
      // (our own call gets 401 there). Everything else: call the API directly.
      const results = UI_FLOW_COUNTRIES.includes(countryCode)
        ? await runUiFlowCycle(await getStoredSlotTargets(), ctx)
        : await runApiCycle(targets, ctx);

      const found = [];
      const errors = [];
      let noSlotCount = 0;
      let rateLimited = false;

      results.forEach((result) => {
        // The "(switch)" centre exists only to make the page re-check; its
        // result goes to the Sheet but never alerts or counts. A 429 still counts.
        if (result.extra && result.status !== 'rate_limited') return;

        if (result.status === 'rate_limited') {
          // Remaining targets were skipped, but still alert on any slot found
          // earlier in this cycle before logging out (handled below).
          rateLimited = true;
        } else if (result.status === 'slot') {
          found.push(`${result.label}: ${result.earliestDate}`);
        } else if (result.status === 'none') {
          noSlotCount += 1;
        } else {
          errors.push(`${result.label}: ${result.errorMessage}`);
        }
      });

      // One combined alert per cycle. alert() blocks, so it runs only after
      // every target has been checked.
      if (found.length) {
        const summary = found.join('\n');
        showToast(`🚨 VFS SLOT AVAILABLE\n${summary}`);
        await sendPushAlert(
          '🚨 VFS SLOT AVAILABLE',
          summary
        );
        alert(`🚨 VFS SLOT AVAILABLE\n${summary}`);
        // Important:
        // Do NOT stop checking.
        // It will continue on the next cycle.
      } else if (noSlotCount && !rateLimited) {
        showToast(`No slot available (checked ${noSlotCount} center(s))`, 'error');
        await sendPushAlert(
          'No slot available',
          `Appointment check completed for ${noSlotCount} center(s).`
        );
      }

      if (rateLimited) {
        const nextAttempt = (getBackoffState().attempt || 0) + 1;
        const backoffMinutes = nextAttempt * 10;
        setBackoffState(nextAttempt, backoffMinutes, 'rate_limit');

        await sendPushAlert(
          '⚠️ VFS 429 Rate Limited',
          `Too many requests. Logging out and waiting ${backoffMinutes}m before re-login.`
        );

        stopChecker();
        await triggerUiLogout();
        return;
      }

      // A full cycle with at least one 2xx and no 429 -> reset any previous backoff.
      if (found.length || noSlotCount) {
        clearBackoffState();
      }

      if (errors.length) {
        await sendPushAlert(
          '⚠️ VFS check failed',
          `${errors.join('; ')}. Will retry automatically.`
        );
      }

    } catch (error) {

      console.log(
        '[VFS Extension] Check cycle error:',
        error
      );

      await sendPushAlert(
        '⚠️ VFS check failed',
        `${error?.message}. Will retry automatically.`
      );

    } finally {

      checking = false;

      const backoff = getBackoffState();
      if (!backoff.inBackoff) {
        scheduleNextCheck();
      } else {
        console.log('[VFS Extension] In 429 backoff cooldown. Check scheduler paused.');
      }
    }
  }

  // -------------------------------------------------------
  // TIMER
  // -------------------------------------------------------

  function scheduleNextCheck() {

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (!isApplicationDetailPage()) {
      console.log(
        '[VFS Extension] Timer stopped - not application-detail'
      );

      return;
    }

    console.log(
      '[VFS Extension] Next check in 3 minutes'
    );

    timer = setTimeout(() => {
      checkSlots();
    }, CHECK_INTERVAL_MS);
  }

  // -------------------------------------------------------
  // START / STOP
  // -------------------------------------------------------

  function startChecker() {

    console.log(
      '[VFS Extension] Starting checker'
    );

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    checkSlots();
  }

  function stopChecker() {

    console.log(
      '[VFS Extension] Stopping checker'
    );

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // -------------------------------------------------------
  // SPA NAVIGATION DETECTION
  // -------------------------------------------------------

  function detectUrlChange() {
    const currentUrl = location.href;
    console.log(
      '[VFS Extension] detectUrlChange:',
      currentUrl,lastUrl
    );

    if (currentUrl === lastUrl) {
      return;
    }

    console.log(
      '[VFS Extension] URL changed:',
      currentUrl
    );

    lastUrl = currentUrl;

    if (isApplicationDetailPage()) {

      console.log(
        '[VFS Extension] Entered application-detail'
      );

      startChecker();

    } else {

      stopChecker();
    }
  }

  // Hook pushState
  const originalPushState =
    history.pushState;

  history.pushState = function () {

    const result =
      originalPushState.apply(
        this,
        arguments
      );

    setTimeout(
      detectUrlChange,
      100
    );

    return result;
  };

  // Hook replaceState
  const originalReplaceState =
    history.replaceState;

  history.replaceState = function () {

    const result =
      originalReplaceState.apply(
        this,
        arguments
      );

    setTimeout(
      detectUrlChange,
      100
    );

    return result;
  };

  window.addEventListener(
    'popstate',
    () => {
      setTimeout(
        detectUrlChange,
        100
      );
    }
  );

  // Backup URL checker
  setInterval(() => {

    detectUrlChange();

  }, 5000);

  // -------------------------------------------------------
  // INITIAL START
  // -------------------------------------------------------

  if (isApplicationDetailPage()) {

    console.log(
      '[VFS Extension] Application detail detected'
    );

    startChecker();

  } else {

    console.log(
      '[VFS Extension] Waiting for application-detail page'
    );
  }




  // 7. Auto-detect Login Page and Paste Dummy Credentials
  function isLoginPage() {
    const url = window.location.href.toLowerCase();
    return (
      url.includes("visa.vfsglobal.com/ind/en/lva/login") ||
      (url.includes("visa.vfsglobal.com") && url.includes("/login"))
    );
  }

  let loginFormFilled = false;
  let loginSubmitAttempted = false;
  let countdownTimerId = null;

  function updateCooldownBanner(remainingMs, attempt, reason) {
    let banner = document.getElementById('vfs-cooldown-banner');
    if (remainingMs <= 0) {
      if (banner) banner.remove();
      return;
    }

    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'vfs-cooldown-banner';
      Object.assign(banner.style, {
        position: 'fixed',
        top: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '9999999',
        padding: '12px 24px',
        borderRadius: '8px',
        color: '#ffffff',
        background: 'linear-gradient(135deg, #b91c1c, #dc2626)',
        fontSize: '15px',
        fontFamily: 'Arial, sans-serif',
        fontWeight: 'bold',
        textAlign: 'center',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        border: '1px solid rgba(255,255,255,0.2)',
        pointerEvents: 'none'
      });
      document.body.appendChild(banner);
    }

    const totalSec = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const headline =
      reason === 'session_timeout'
        ? '🔄 Session Timeout (29m limit)'
        : '⏳ Rate Limited (HTTP 429)';

    banner.innerHTML = `${headline} &bull; Attempt #${attempt}<br><span style="font-size: 13px; font-weight: normal; opacity: 0.95;">Waiting cooldown before auto re-login: <strong>${formatted}</strong></span>`;
  }

  function removeCooldownBanner() {
    const banner = document.getElementById('vfs-cooldown-banner');
    if (banner) banner.remove();
    if (countdownTimerId) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
  }

  function handleLoginCooldown(onCooldownComplete) {
    const backoff = getBackoffState();
    if (!backoff.inBackoff || backoff.remainingMs <= 0) {
      removeCooldownBanner();
      if (backoff.inBackoff && backoff.remainingMs <= 0) {
        localStorage.removeItem(BACKOFF_STORAGE_KEY_ACTIVE);
      }
      return false;
    }

    console.log(
      `[VFS Extension] Login paused for 429 cooldown. Remaining: ${Math.round(backoff.remainingMs / 1000)}s`
    );

    updateCooldownBanner(backoff.remainingMs, backoff.attempt, backoff.reason);

    if (countdownTimerId) {
      clearInterval(countdownTimerId);
    }

    countdownTimerId = setInterval(() => {
      const current = getBackoffState();
      if (!current.inBackoff || current.remainingMs <= 0) {
        removeCooldownBanner();
        localStorage.removeItem(BACKOFF_STORAGE_KEY_ACTIVE);
        console.log('[VFS Extension] 429 Cooldown complete. Proceeding with auto-login.');
        if (typeof onCooldownComplete === 'function') {
          onCooldownComplete();
        }
      } else {
        updateCooldownBanner(current.remainingMs, current.attempt, current.reason);
      }
    }, 1000);

    return true;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function getSignInButton() {
    const buttonSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button[form="loginForm"]',
      'button[id*="login" i]',
      'button[class*="login" i]',
      'button'
    ];

    for (const selector of buttonSelectors) {
      const buttonList = document.querySelectorAll(selector);
      for (const button of buttonList) {
        if (!isElementVisible(button)) continue;

        const text = (button.textContent || button.value || "")
          .trim()
          .toLowerCase();

        const aria = (button.getAttribute("aria-label") || "")
          .trim()
          .toLowerCase();

        if (text.includes("sign in") || text.includes("login") || aria.includes("sign in") || aria.includes("login")) {
          return button;
        }
      }
    }

    return null;
  }

  function isButtonEnabled(button) {
    if (!button) return false;
    if (button.disabled) return false;
    if (button.getAttribute("aria-disabled") === "true") return false;
    if (button.classList.contains("disabled")) return false;
    return true;
  }

  async function clickSignInWhenEnabled(maxWaitMs = 20000) {
    const start = Date.now();

    while (Date.now() - start < maxWaitMs && isLoginPage()) {
      const signInButton = getSignInButton();

      if (signInButton && isButtonEnabled(signInButton)) {
        signInButton.scrollIntoView({ behavior: "smooth", block: "center" });
        signInButton.focus();
        signInButton.click();
        loginSubmitAttempted = true;
        console.log("[VFS Agent] Sign In button enabled and clicked");
        return true;
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    console.log("[VFS Agent] Sign In button not enabled within wait window");
    return false;
  }

  async function tryAutoFillLogin(force = false) {
    try {
      if (!isLoginPage()) return false;

      const backoff = getBackoffState();
      if (backoff.inBackoff && backoff.remainingMs > 0 && !force) {
        console.log('[VFS Agent] In 429 backoff cooldown. Autofill delayed.');
        handleLoginCooldown(() => {
          loginFormFilled = false;
          loginSubmitAttempted = false;
          tryAutoFillLogin(true);
        });
        return false;
      }

      if (loginFormFilled && !force) return false;

    // Selectors for email/username field in VFS Global login page
    const emailSelectors = [
      'input[formcontrolname="username"]',
      'input[type="email"]',
      'input[name="username"]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="e-mail" i]',
      'input[formcontrolname*="email" i]',
      'input[id*="mat-input-0"]',
      'input[type="text"]'
    ];

    // Selectors for password field in VFS Global login page
    const passwordSelectors = [
      'input[formcontrolname="password"]',
      'input[type="password"]',
      'input[name="password"]',
      'input[id*="password" i]',
      'input[placeholder*="password" i]',
      'input[formcontrolname*="password" i]',
      'input[id*="mat-input-1"]'
    ];

      let emailInput = null;
      for (const selector of emailSelectors) {
        const el = document.querySelector(selector);
        if (el && isElementVisible(el)) {
          emailInput = el;
          break;
        }
      }

      let passwordInput = null;
      for (const selector of passwordSelectors) {
        const el = document.querySelector(selector);
        if (el && isElementVisible(el)) {
          passwordInput = el;
          break;
        }
      }

      if (emailInput && passwordInput) {
        loginFormFilled = true;
        console.log("[VFS Agent] Detected login page at:", window.location.href);

        const creds = await getStoredAutofillCredentials();

        if (creds.username) {
          await fillInputField(emailInput, creds.username);
          console.log("[VFS Agent] Filled email field from stored autofill credentials");
        }

        await new Promise((r) => setTimeout(r, 300));

        if (creds.password) {
          await fillInputField(passwordInput, creds.password);
          console.log("[VFS Agent] Filled password field from stored autofill credentials");
        }

        //clearStoredAutofillCredentials();

        if (emailInput.value && passwordInput.value && !loginSubmitAttempted) {
          await clickSignInWhenEnabled();
        }

        return true;
      }

      return false;
    } catch (error) {
      console.error("[VFS Agent] tryAutoFillLogin failed:", error);
      return false;
    }
  }

  async function fillInputField(inputEl, value) {
    if (!inputEl) return;

    // 1. Scroll & focus element to simulate cursor placement
    inputEl.scrollIntoView({ behavior: "smooth", block: "center" });
    inputEl.focus();
    inputEl.click();

    // 2. Use native prototype setter to support Angular Reactive Forms & React state
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(inputEl, value);
    } else {
      inputEl.value = value;
    }

    // 3. Set text selection / cursor to end of the input field
    if (typeof inputEl.setSelectionRange === "function") {
      inputEl.setSelectionRange(value.length, value.length);
    }

    // 4. Dispatch standard DOM events so Angular updates validation & model
    inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
  }

  function getStartNewBookingButton() {
    const exactSelectors = [
      'button.btn-brand-orange',
      'button.mat-mdc-raised-button',
      'button.mdc-button--raised',
      'button[class*="btn-brand-orange" i]',
      'button[class*="brand-orange" i]'
    ];

    for (const selector of exactSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (!isElementVisible(el)) continue;

        const text = (el.textContent || el.value || el.getAttribute('aria-label') || '')
          .trim()
          .toLowerCase();

        if (text.includes('start new booking')) {
          return el;
        }
      }
    }

    const genericSelectors = [
      'button',
      'a',
      'input[type="button"]',
      'input[type="submit"]'
    ];

    for (const selector of genericSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (!isElementVisible(el)) continue;

        const text = (el.textContent || el.value || el.getAttribute('aria-label') || '')
          .trim()
          .toLowerCase();

        if (text.includes('start new booking')) {
          return el;
        }
      }
    }

    return null;
  }

  async function clickStartNewBookingWhenAvailable(maxWaitMs = 20000) {
    const start = Date.now();

    while (Date.now() - start < maxWaitMs && isDashboardPage()) {
      const button = getStartNewBookingButton();

      if (button) {
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        button.focus();
        button.click();
        console.log('[VFS Agent] Start New Booking button clicked on dashboard');
        return true;
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    console.log('[VFS Agent] Start New Booking button not found on dashboard');
    return false;
  }

  function initDashboardWatcher() {
    if (!isDashboardPage()) return;
    console.log('[VFS Agent] Initializing dashboard watcher for:', window.location.href);
    recordLoginTime();
    clickStartNewBookingWhenAvailable();

    const observer = new MutationObserver(() => {
      if (isDashboardPage()) {
        clickStartNewBookingWhenAvailable();
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  function initLoginWatcher() {
    if (!isLoginPage()) return;
    console.log("[VFS Agent] Initializing login page watcher for:", window.location.href);

    const isCoolingDown = handleLoginCooldown(() => {
      loginFormFilled = false;
      loginSubmitAttempted = false;
      tryAutoFillLogin(true);
    });

    if (isCoolingDown) {
      console.log('[VFS Agent] Waiting for 429 cooldown before filling login form.');
      return;
    }

    // Attempt immediately
    tryAutoFillLogin();

    // Watch for dynamic DOM changes (Angular SPA rendering)
    const observer = new MutationObserver(() => {
      const backoff = getBackoffState();
      if (backoff.inBackoff && backoff.remainingMs > 0) return;
      if (!loginFormFilled && isLoginPage()) {
        tryAutoFillLogin();
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }

    // Polling retry for up to 15 seconds to ensure SPA inputs are mounted
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const backoff = getBackoffState();
      if (backoff.inBackoff && backoff.remainingMs > 0) {
        clearInterval(interval);
        return;
      }
      if (loginFormFilled || attempts > 30 || !isLoginPage()) {
        clearInterval(interval);
      } else {
        tryAutoFillLogin();
      }
    }, 500);
  }

  // Watch for client-side SPA navigation
  let lastObservedUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastObservedUrl) {
      lastObservedUrl = window.location.href;
      loginFormFilled = false;
      loginSubmitAttempted = false;
      if (isLoginPage()) {
        initLoginWatcher();
      } else if (isDashboardPage()) {
        initDashboardWatcher();
      }
    }
  }).observe(document, { subtree: true, childList: true });

  // Initial execution check on page load
  if (isLoginPage()) {
    initLoginWatcher();
  } else if (isDashboardPage()) {
    initDashboardWatcher();
  }
  


  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[VFS Extension] Received message:', message, sender);
      if (!message || message.type !== 'AUTOFILL') {
        return false;
      }

      const row = message.row || {};
      const usernameValue = message.usernameValue || pickValue(row, ['username', 'user', 'email']);
      const passwordValue = message.passwordValue || pickValue(row, ['password', 'pass']);
      const sourceValue = pickValue(row, ['source', 'sourcecountry', 'source_country']);
      const destinationValue = pickValue(row, ['destination', 'destinationcountry', 'destination_country', 'country', 'mission']);

      console.log('[VFS Extension] Received autofill request:', {
        usernameValue,
        passwordValue,
        sourceValue,
        destinationValue
      });

      let filled = 0;
      let foundUsernameField = false;
      let foundPasswordField = false;

      const usernameSelectors = [
        'input[formcontrolname="username"]',
        'input[type="email"]',
        'input[name="username"]',
        'input[id*="email" i]',
        'input[placeholder*="email" i]',
        'input[formcontrolname*="email" i]',
        'input[type="text"]'
      ];

      const passwordSelectors = [
        'input[formcontrolname="password"]',
        'input[type="password"]',
        'input[name="password"]',
        'input[id*="password" i]',
        'input[placeholder*="password" i]',
        'input[formcontrolname*="password" i]'
      ];

      const usernameField = usernameSelectors
        .map((selector) => document.querySelector(selector))
        .find((el) => el && isElementVisible(el));

      if (usernameField && usernameValue) {
        foundUsernameField = true;
        fillInputField(usernameField, String(usernameValue));
        filled += 1;
      }

      const passwordField = passwordSelectors
        .map((selector) => document.querySelector(selector))
        .find((el) => el && isElementVisible(el));

      if (passwordField && passwordValue) {
        foundPasswordField = true;
        fillInputField(passwordField, String(passwordValue));
        filled += 1;
      }

      if (sourceValue && destinationValue) {
        const newUrl = `https://visa.vfsglobal.com/${sourceValue}/en/${destinationValue}`;
        console.log('[VFS Extension] Redirecting to:', newUrl);
        window.location.href = newUrl;
      }

      sendResponse({
        success: filled > 0 || Boolean(sourceValue && destinationValue),
        filled,
        foundUsernameField,
        foundPasswordField,
        sourceValue,
        destinationValue
      });

      return true;
    });
  } else {
    console.log('[VFS Extension] chrome.runtime is unavailable in this page context.');
  }

  // Looks for a CSV column matching any of `candidates` (case-insensitive).
  function pickValue(row, candidates) {
    const keys = Object.keys(row);
    for (const candidate of candidates) {
      const match = keys.find((k) => k.toLowerCase().includes(candidate.toLowerCase()));
      if (match) return row[match];
    }
    return null;
  }

  function showToast(message, type = "success") {
  const toast = document.createElement("div");

  toast.textContent = message;

  Object.assign(toast.style, {
    position: "fixed",
    top: "24px",
    left: "40px",
    zIndex: "999999",
    padding: "12px 18px",
    borderRadius: "8px",
    color: "#fff",
    background: type === "success" ? "#22c55e" : "#ef4444",
    fontSize: "14px",
    fontFamily: "Arial, sans-serif",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  });

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 5000);
}

})();

