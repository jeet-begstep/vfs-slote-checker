// Pure scheduling helpers for the runner (unit-tested in tests/schedule.test.js).

const SESSION_CAP_MS = 27 * 60 * 1000; // force logout if the extension has not (VFS limit ~29 min)
const SESSION_COOLDOWN_MIN = 5;
const RATE_LIMIT_STEP_MIN = 10;
const CAPTCHA_WAIT_MS = 10 * 60 * 1000;
const LOGOUT_CONFIRM_MS = 30 * 1000;
const MAX_CAPTCHA_TIMEOUTS = 3;

function nextIndex(i, n) {
  if (!n || n < 1) return 0;
  return (i + 1) % n;
}

// consecutive429 includes the 429 that just happened (1, 2, 3 ...).
function cooldownMs(reason, consecutive429 = 1) {
  if (reason === 'rate_limit') return Math.max(1, consecutive429) * RATE_LIMIT_STEP_MIN * 60 * 1000;
  return SESSION_COOLDOWN_MIN * 60 * 1000;
}

// A clean 23-minute session resets the shared 429 counter; a 429 raises it.
function next429Count(current, reason) {
  if (reason === 'rate_limit') return current + 1;
  if (reason === 'session_timeout') return 0;
  return current;
}

module.exports = {
  SESSION_CAP_MS,
  SESSION_COOLDOWN_MIN,
  CAPTCHA_WAIT_MS,
  LOGOUT_CONFIRM_MS,
  MAX_CAPTCHA_TIMEOUTS,
  nextIndex,
  cooldownMs,
  next429Count
};
