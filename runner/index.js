#!/usr/bin/env node
// Drives the VFS Slot Checker extension through an account cycle:
// open login -> (user ticks captcha) -> extension checks slots ~23 min ->
// logout -> close tab -> cooldown -> next account (a -> b -> c -> a ...).
//
//   npm run runner -- --setup                (once: load the extension into the runner's Chrome profile)
//   npm run runner -- [--csv path] [--until HH:MM] [--clear-cookies] [--chromium]
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { launch, setup } = require('./browser');
const { loadAccounts, loginUrl } = require('./accounts');
const S = require('./schedule');

const LOG_FILE = path.join(__dirname, 'runner.log');
const POLL_MS = 2000;

function parseArgs(argv) {
  const opts = { csv: path.join(__dirname, 'accounts.csv'), until: null, clearCookies: false, setup: false, chromium: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--csv') opts.csv = path.resolve(argv[++i]);
    else if (argv[i] === '--until') opts.until = argv[++i];
    else if (argv[i] === '--clear-cookies') opts.clearCookies = true;
    else if (argv[i] === '--setup') opts.setup = true;
    else if (argv[i] === '--chromium') opts.chromium = true;
  }
  return opts;
}

function untilTimestamp(hhmm) {
  if (!hhmm) return Infinity;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`--until expects HH:MM, got "${hhmm}"`);
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// JSON lines. Never log passwords.
function log(event, fields = {}) {
  const entry = { ts: new Date().toISOString(), event, ...fields };
  console.log(`[runner] ${entry.ts} ${event}`, Object.keys(fields).length ? JSON.stringify(fields) : '');
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {}
}

function notify(message) {
  if (process.platform !== 'darwin') return;
  execFile('osascript', ['-e', `display notification "${message}" with title "VFS runner" sound name "Glass"`], () => {});
}

let stopping = false;
const sleep = async (ms) => {
  const end = Date.now() + ms;
  while (!stopping && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
};

async function currentEvent(browser) {
  const { vfsRunnerEvent } = await browser.storageGet(['vfsRunnerEvent']);
  return vfsRunnerEvent || null;
}

async function forceLogout(page, account) {
  try {
    await page.evaluate(() => {
      sessionStorage.removeItem('JWT');
      localStorage.removeItem('JWT');
    });
    await page.goto(loginUrl(account));
  } catch (e) {}
}

// Returns the reason the session ended:
// 'session_timeout' | 'rate_limit' | 'cap' | 'captcha_timeout' | 'page_closed' | 'stopped'
async function runSession(browser, account, opts) {
  await browser.storageSet({
    vfsRunnerMode: true,
    vfsAutofillUsername: account.username,
    vfsAutofillPassword: account.password,
    vfsSlotTargets: account.targets,
    vfsUiCategory: account.category
  });
  await browser.storageRemove(['vfsRunnerEvent']);

  const page = await browser.context.newPage();
  try {
    await page.goto(loginUrl(account), { waitUntil: 'domcontentloaded' });
    log('login_page_opened', { email: account.username });

    // 1. Wait for the user to tick the captcha and the extension to reach the dashboard.
    const waitStart = Date.now();
    let notified = false;
    let loggedAt = null;
    while (!stopping && Date.now() - waitStart < S.CAPTCHA_WAIT_MS) {
      if (page.isClosed()) return 'page_closed';
      const ev = await currentEvent(browser);
      if (ev && ev.type === 'logged_in') {
        loggedAt = ev.ts;
        break;
      }
      if (!notified && Date.now() - waitStart > 30000) {
        notified = true;
        notify('Tick the captcha to continue.');
        log('waiting_for_captcha', { email: account.username });
      }
      await sleep(POLL_MS);
    }
    if (stopping) return 'stopped';
    if (loggedAt === null) return 'captcha_timeout';
    log('logged_in', { email: account.username });

    // 2. Wait for the extension to end the session (23 min / 429), or the cap.
    let reason = null;
    while (!stopping) {
      if (page.isClosed()) return 'page_closed';
      const ev = await currentEvent(browser);
      if (ev && (ev.type === 'session_timeout' || ev.type === 'rate_limit')) {
        reason = ev.type;
        break;
      }
      if (Date.now() - loggedAt >= S.SESSION_CAP_MS) {
        reason = 'cap';
        log('session_cap_reached', { email: account.username });
        await forceLogout(page, account);
        break;
      }
      await sleep(POLL_MS);
    }
    if (stopping) {
      await forceLogout(page, account);
      return 'stopped';
    }

    // 3. Confirm the logout (URL back on /login) before closing the tab.
    try {
      await page.waitForURL(/\/login/, { timeout: S.LOGOUT_CONFIRM_MS });
    } catch (e) {
      log('logout_unconfirmed', { email: account.username, url: page.url() });
    }
    return reason;
  } finally {
    await browser.storageRemove(['vfsAutofillUsername', 'vfsAutofillPassword']).catch(() => {});
    if (!page.isClosed()) await page.close().catch(() => {});
    if (opts.clearCookies) await browser.context.clearCookies().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.setup) {
    await setup();
    return;
  }
  const until = untilTimestamp(opts.until);
  const accounts = loadAccounts(opts.csv);
  if (!accounts.length) {
    console.error(`No usable accounts in ${opts.csv} (need email, password, source, destination).`);
    process.exit(1);
  }
  log('start', { accounts: accounts.map((a) => a.username), until: opts.until });

  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\n[runner] stopping...');
  });

  let browser = await launch(opts);
  browser.context.on('close', () => (browser.closed = true));

  let idx = 0;
  let count429 = 0;
  let captchaTimeouts = 0;

  try {
    while (!stopping && Date.now() < until) {
      const account = accounts[idx];
      let reason;
      try {
        reason = await runSession(browser, account, opts);
      } catch (err) {
        log('session_error', { email: account.username, error: String(err && err.message) });
        if (browser.closed || /closed|disconnected/i.test(String(err && err.message))) {
          log('relaunching_browser');
          browser = await launch(opts);
          browser.context.on('close', () => (browser.closed = true));
          continue; // retry the same account
        }
        reason = 'error';
      }
      if (stopping) break;

      log('session_ended', { email: account.username, reason, count429 });

      if (reason === 'captcha_timeout') {
        captchaTimeouts += 1;
        if (captchaTimeouts >= S.MAX_CAPTCHA_TIMEOUTS) {
          log('too_many_captcha_timeouts', { captchaTimeouts });
          notify('Stopped: captcha not solved 3 times in a row.');
          break;
        }
        idx = S.nextIndex(idx, accounts.length);
        await sleep(30000);
        continue;
      }
      captchaTimeouts = 0;

      count429 = S.next429Count(count429, reason);
      if (reason === 'rate_limit') log('rate_limited', { email: account.username, count429 });

      const wait = S.cooldownMs(reason === 'rate_limit' ? 'rate_limit' : 'session_timeout', count429);
      idx = S.nextIndex(idx, accounts.length);
      log('cooldown', { minutes: wait / 60000, next: accounts[idx].username });
      await sleep(wait);
    }
  } finally {
    log('stop');
    try {
      await browser.storageSet({ vfsRunnerMode: false });
      await browser.storageRemove(['vfsRunnerEvent', 'vfsAutofillUsername', 'vfsAutofillPassword']);
    } catch (e) {}
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
