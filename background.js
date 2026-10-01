// Background service worker.
//
// Why this file exists: chrome.notifications is NOT exposed to content scripts.
// content.js was calling chrome.notifications.create() behind an
// `if (chrome.notifications)` guard, which was always false there, so the
// notification was silently skipped. The content script now messages this
// worker instead, and the worker owns notifications + sound.

const OFFSCREEN_PATH = 'offscreen.html';
const SOUND_VOLUME = 0.8;

// --- check-log (Google Sheet via Apps Script) -------------------------------
//
// Fill these in after deploying docs/vfs-log-apps-script.gs. Leaving
// SHEET_LOG_URL empty disables logging entirely (flushLogQueue() no-ops).
const SHEET_LOG_URL = 'https://script.google.com/macros/s/AKfycbxCWasiyKoPLfdxipG_NMxptnWbztfH_B9AXCSxs5kGlXdL0xx4tmaszqmIiIefe2cH/exec';
const SHEET_LOG_TOKEN = '748daf6a76e60719b907af3d745df54f49719bf0bc6e5b9c';
const MAX_QUEUE_SIZE = 500;
const LOG_QUEUE_KEY = 'vfsLogQueue';
const LOG_FLUSH_ALARM = 'vfs-log-flush';

chrome.alarms.create(LOG_FLUSH_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOG_FLUSH_ALARM) {
    flushLogQueue();
  }
});

async function enqueueLogEntry(entry) {
  const stored = await chrome.storage.local.get(LOG_QUEUE_KEY);
  const queue = stored[LOG_QUEUE_KEY] || [];

  queue.push(entry);

  const capped = queue.length > MAX_QUEUE_SIZE
    ? queue.slice(-MAX_QUEUE_SIZE)
    : queue;

  await chrome.storage.local.set({ [LOG_QUEUE_KEY]: capped });

  flushLogQueue();
}

async function flushLogQueue() {
  if (!SHEET_LOG_URL) return;

  const stored = await chrome.storage.local.get(LOG_QUEUE_KEY);
  const queue = stored[LOG_QUEUE_KEY] || [];

  if (queue.length === 0) return;

  try {
    const response = await fetch(SHEET_LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SHEET_LOG_TOKEN, entries: queue })
    });

    // Apps Script web apps always answer HTTP 200, even on a
    // rejected token or a thrown error, so the body's own `ok`
    // field is the real success signal, not response.ok.
    const result = await response.json();

    if (!result || !result.ok) {
      console.warn('[VFS Extension] Sheet log flush rejected:', result && result.error);
      return;
    }

    await chrome.storage.local.set({ [LOG_QUEUE_KEY]: [] });
  } catch (error) {
    console.warn('[VFS Extension] Sheet log flush failed, will retry:', error);
  }
}

// --- notification -----------------------------------------------------------

async function showAlert(title, message) {
  const id = `vfs-slot-${Date.now()}`;

  await chrome.notifications.create(id, {
    type: 'basic',
    // Must be an extension URL. A bare 'icon.png' resolves against the VFS
    // page origin from a content script and fails.
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: String(title).slice(0, 120),
    message: String(message).slice(0, 400),
    priority: 2,
    requireInteraction: true,  // stays on screen until dismissed
    silent: true               // we play ding.wav ourselves, avoid a double chime
  });

  await playSound();

  return id;
}

// Clicking the notification jumps to the VFS tab that raised it.
chrome.notifications.onClicked.addListener(async (id) => {
  const tabs = await chrome.tabs.query({ url: 'https://visa.vfsglobal.com/*' });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  }

  chrome.notifications.clear(id);
});

// --- sound ------------------------------------------------------------------
// Service workers have no Audio API, so playback goes through an offscreen doc.

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (contexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play an alert sound when a VFS appointment slot opens.'
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function playSound() {
  try {
    await ensureOffscreen();

    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'play-sound',
      source: chrome.runtime.getURL('sounds/ding.wav'),
      volume: SOUND_VOLUME
    });
  } catch (error) {
    console.warn('[VFS Extension] Sound playback failed:', error);
  }
}

// --- messages from content.js / popup.js ------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;  // handled by the offscreen doc

  if (msg?.type === 'vfs-notify') {
    showAlert(msg.title, msg.message)
      .then((id) => sendResponse({ ok: true, id }))
      .catch((error) => {
        console.error('[VFS Extension] Notification failed:', error);
        sendResponse({ ok: false, error: String(error.message || error) });
      });

    return true;  // keep the message channel open for the async reply
  }

  if (msg?.type === 'vfs-test-notify') {
    showAlert('VFS Slot Checker', 'Test alert - notifications and sound are working.')
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));

    return true;
  }

  if (msg?.type === 'vfs-log') {
    enqueueLogEntry(msg.entry).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
