// Launches real Google Chrome (persistent runner profile, extension loaded once
// by hand) and talks to chrome.storage.local
// through an empty extension page (the MV3 service worker idles, so it is not
// used as the bridge).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const EXT_DIR = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(__dirname, '.profile');

// Finds this folder's extension id in the profile's preferences (Chrome 137+
// ignores --load-extension, so the extension is loaded once by hand with
// `npm run runner -- --setup` and stays in the profile).
function findExtensionId(profileDir, extDir) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch (e) {
      return p;
    }
  };
  const want = real(extDir);
  for (const file of ['Secure Preferences', 'Preferences']) {
    let prefs;
    try {
      prefs = JSON.parse(fs.readFileSync(path.join(profileDir, 'Default', file), 'utf8'));
    } catch (e) {
      continue;
    }
    const settings = (prefs.extensions && prefs.extensions.settings) || {};
    for (const [id, ext] of Object.entries(settings)) {
      if (ext && ext.path && real(ext.path) === want && ext.state !== 0) return id;
    }
  }
  return null;
}

// Real Chrome: Playwright disables extensions by default, so undo that.
function chromeOptions(extra = {}) {
  return {
    channel: 'chrome',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--disable-extensions'],
    ...extra
  };
}

// One-time: open Chrome on the runner profile at chrome://extensions so the
// user can click "Load unpacked" and pick this folder.
async function setup() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, chromeOptions());
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('chrome://extensions');
  console.log(`
One-time setup in the Chrome window that just opened:
  1. Turn on "Developer mode" (top right).
  2. Click "Load unpacked" and choose this folder:
     ${EXT_DIR}
  3. Close the Chrome window. Then run: npm run runner
`);
  await new Promise((resolve) => context.on('close', resolve));
}

async function launch({ chromium: useBundled = false } = {}) {
  let context;
  let extensionId;

  if (useBundled) {
    // Playwright's own Chromium still honours --load-extension.
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`]
    });
    let worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', {
        predicate: (w) => w.url().startsWith('chrome-extension://'),
        timeout: 20000
      });
    }
    extensionId = new URL(worker.url()).host;
  } else {
    extensionId = findExtensionId(PROFILE_DIR, EXT_DIR);
    if (!extensionId) {
      throw new Error('Extension not found in the runner Chrome profile. Run once: npm run runner -- --setup');
    }
    context = await chromium.launchPersistentContext(PROFILE_DIR, chromeOptions());
  }

  // Stale backoff keys from the in-tab flow must not pause the login watcher;
  // the runner owns cooldowns.
  await context.addInitScript(() => {
    try {
      if (location.hostname === 'visa.vfsglobal.com') {
        ['VFS_429_IN_BACKOFF', 'VFS_429_ATTEMPT', 'VFS_429_NEXT_RETRY_TS', 'VFS_429_REASON'].forEach((k) =>
          localStorage.removeItem(k)
        );
      }
    } catch (e) {}
  });

  const bridge = await context.newPage();
  await bridge.goto(`chrome-extension://${extensionId}/runner-bridge.html`);

  return {
    context,
    extensionId,
    storageSet: (obj) => bridge.evaluate((o) => chrome.storage.local.set(o), obj),
    storageRemove: (keys) => bridge.evaluate((k) => chrome.storage.local.remove(k), keys),
    storageGet: (keys) => bridge.evaluate((k) => chrome.storage.local.get(k), keys),
    close: () => context.close()
  };
}

module.exports = { launch, setup, findExtensionId };
