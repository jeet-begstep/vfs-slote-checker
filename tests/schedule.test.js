const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../runner/schedule.js');

test('nextIndex wraps a -> b -> c -> a', () => {
  assert.equal(S.nextIndex(0, 3), 1);
  assert.equal(S.nextIndex(2, 3), 0);
});

test('nextIndex: single account stays, empty list is 0', () => {
  assert.equal(S.nextIndex(0, 1), 0);
  assert.equal(S.nextIndex(0, 0), 0);
});

test('cooldownMs: session timeout is 5 min regardless of the 429 count', () => {
  assert.equal(S.cooldownMs('session_timeout', 0), 5 * 60 * 1000);
  assert.equal(S.cooldownMs('session_timeout', 4), 5 * 60 * 1000);
});

test('cooldownMs: 429 escalates 10/20/30 min', () => {
  assert.equal(S.cooldownMs('rate_limit', 1), 10 * 60 * 1000);
  assert.equal(S.cooldownMs('rate_limit', 2), 20 * 60 * 1000);
  assert.equal(S.cooldownMs('rate_limit', 3), 30 * 60 * 1000);
  assert.equal(S.cooldownMs('rate_limit', 0), 10 * 60 * 1000);
});

test('next429Count: 429 raises, clean session resets, other reasons keep it', () => {
  assert.equal(S.next429Count(0, 'rate_limit'), 1);
  assert.equal(S.next429Count(2, 'rate_limit'), 3);
  assert.equal(S.next429Count(2, 'session_timeout'), 0);
  assert.equal(S.next429Count(2, 'cap'), 2);
});

test('session cap sits above the extension 23 min limit and below the VFS ~29 min limit', () => {
  assert.ok(S.SESSION_CAP_MS > 23 * 60 * 1000);
  assert.ok(S.SESSION_CAP_MS < 29 * 60 * 1000);
});
