 (() => {
  'use strict';

  // Prevent duplicate initialization
  if (window.__VFS_SLOT_CHECKER_RUNNING__) {
    console.log('[VFS Extension] Already running');
    return;
  }

  window.__VFS_SLOT_CHECKER_RUNNING__ = true;

  const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  const API_URL =
    'https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable';

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

      // Get latest JWT every time
      const token = getAuthToken();

      if (!token) {
        console.log(
          '[VFS Extension] No JWT. Will retry later.'
        );

        return;
      }

      const {
        countryCode,
        missionCode
      } = getUrlParams();

      const vacCode =
        `${missionCode}${countryCode}`.toUpperCase();

      const routeHeader =
        `${countryCode}/en/${missionCode}`;

      console.log(
        '[VFS Extension] Country:',
        countryCode
      );

      console.log(
        '[VFS Extension] Mission:',
        missionCode
      );

      console.log(
        '[VFS Extension] VAC:',
        vacCode
      );

      const payload = {
        countryCode: countryCode,
        missionCode: missionCode,
        vacCode: vacCode,
        visaCategoryCode: 'StudenL',
        roleName: 'Individual',
        loginUser: 'dinz51062@gmail.com',
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

          'ClientSource':
            'imMG/l4MmYDsEvVPyHan3Tsc8dbxyD66qU4ZBAHKdDpkczriHRLjkHzXgYB97EXeat02vIldwprT+J+KOiXkH6btSCRq92U2f91aTt/B5XSq2XBUxYbA5OuL8CG3bnyxGChchENtdnUGvQz8eF4mZJjBy84dgS78ETWrQZnCFY+TLVbCzZ635iwf2JGwZjE5gC2p6ejNFdTrRQZmfmVbms7mH5Z4cALUUuFS3XjYxzYJmFmz/i+3Bg+V8Jg0o7OGs0xcfpbQs/Cij2PtjSqrgE0JJxiEmNLJFwZvDYplnZSK0PcttKJMJX9NkCwyIcXHePVVcfMzF26y5bJTtyGtlQ==',

          'Content-Type':
            'application/json;charset=UTF-8',

          'Route': routeHeader
        },

        body: JSON.stringify(payload)
      });

      console.log(
        '[VFS Extension] API status:',
        response.status
      );

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      const data = await response.json();

      console.log(
        '[VFS Extension] API response:',
        data
      );

      if (data && data.earliestDate) {

        console.log(
          '[VFS Extension] 🚨 SLOT AVAILABLE:',
          data.earliestDate
        );
        showToast(`🚨 VFS SLOT AVAILABLE\nEarliest Available Date: ${data.earliestDate}`);
        await sendPushAlert(
          '🚨 VFS SLOT AVAILABLE',
          `Earliest Available Date: ${data.earliestDate}`
        );
        alert(`🚨 VFS SLOT AVAILABLE\nEarliest Available Date: ${data.earliestDate}`);
        // Important:
        // Do NOT stop checking.
        // It will continue every 3 minutes.

        sendCheckLogEntry({
          countryCode,
          missionCode,
          vacCode,
          visaCategoryCode: payload.visaCategoryCode,
          result: 'slot_available',
          earliestDate: data.earliestDate,
          httpStatus: response.status
        });
      } else {
       // alert('No slot available');
        showToast('No slot available', 'error');
        await sendPushAlert(
          'No slot available',
          "Appointment check completed successfully."
        );
        console.log(
          '[VFS Extension] No slot available'
        );

        sendCheckLogEntry({
          countryCode,
          missionCode,
          vacCode,
          visaCategoryCode: payload.visaCategoryCode,
          result: 'no_slot',
          httpStatus: response.status
        });
      }

    } catch (error) {

      console.log(
        '[VFS Extension] API error:',
        error
      );

      // showToast(
      //   `⚠️ VFS check failed: ${error?.message}. Retrying in 1 min.`,
      //   'error'
      // );

      await sendPushAlert(
        '⚠️ VFS check failed',
        `${error?.message}. Will retry automatically.`
      );

      {
        const fallback = getUrlParams();
        const fallbackMission = fallback.missionCode;
        const fallbackCountry = fallback.countryCode;

        sendCheckLogEntry({
          countryCode: fallbackCountry,
          missionCode: fallbackMission,
          vacCode: `${fallbackMission}${fallbackCountry}`.toUpperCase(),
          visaCategoryCode: 'StudenL',
          result: 'error',
          errorMessage: error?.message,
          httpStatus: error?.message?.startsWith('HTTP ')
            ? Number(error.message.slice(5))
            : null
        });
      }

    } finally {

      checking = false;

      scheduleNextCheck();
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

        // Move cursor to Email field and paste dummy email
        await fillInputField(emailInput, "dinz51062@gmail.com");
        console.log("[VFS Agent] Cursor moved to email field and filled: dinz51062@gmail.com");

        await new Promise((r) => setTimeout(r, 300));

        // Move cursor to Password field and paste dummy password
        await fillInputField(passwordInput, "Skillbee@1234");
        console.log("[VFS Agent] Cursor moved to password field and filled: Skillbee@1234");

        if (!loginSubmitAttempted) {
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
    // Attempt immediately
    tryAutoFillLogin();

    // Watch for dynamic DOM changes (Angular SPA rendering)
    const observer = new MutationObserver(() => {
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

