const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAccounts, loginUrl } = require('../runner/accounts.js');

const HEADER = 'email,password,source,destination,vacCode|visaCategoryCode,category';

test('parseAccounts: reads quoted multi-centre cell and category', () => {
  const rows = parseAccounts(`${HEADER}\na@x.com,pw1,are,lva,"AUH|LL,DXB|LL",Long Stay\r\nb@x.com,pw2,are,lva,"AUH|LL",Long Stay\n`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].targets, [
    { vacCode: 'AUH', visaCategoryCode: 'LL' },
    { vacCode: 'DXB', visaCategoryCode: 'LL' }
  ]);
  assert.equal(rows[0].category, 'Long Stay');
  assert.equal(rows[1].username, 'b@x.com');
});

test('parseAccounts: skips rows without password or destination', () => {
  const rows = parseAccounts(`${HEADER}\na@x.com,,are,lva,"AUH|LL",\nb@x.com,pw,are,,"AUH|LL",\nc@x.com,pw,are,lva,"AUH|LL",\n`);
  assert.deepEqual(rows.map((r) => r.username), ['c@x.com']);
});

test('parseAccounts: legacy single vacCode and empty file', () => {
  const rows = parseAccounts('email,password,source,destination,visaCategoryCode\na@x.com,pw,are,lva,EmployL\n');
  assert.deepEqual(rows[0].targets, [{ vacCode: null, visaCategoryCode: 'EmployL' }]);
  assert.deepEqual(parseAccounts(''), []);
});

test('loginUrl builds the market login page', () => {
  assert.equal(loginUrl({ source: 'are', destination: 'lva' }), 'https://visa.vfsglobal.com/are/en/lva/login');
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findExtensionId } = require('../runner/browser.js');

test('findExtensionId: finds the enabled extension loaded from a folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-prof-'));
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-ext-'));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(
    path.join(dir, 'Default', 'Secure Preferences'),
    JSON.stringify({ extensions: { settings: { other: { path: '/nope', state: 1 }, abcdef: { path: ext, state: 1 } } } })
  );
  assert.equal(findExtensionId(dir, ext), 'abcdef');
  assert.equal(findExtensionId(dir, '/somewhere/else'), null);
  assert.equal(findExtensionId(path.join(dir, 'missing'), ext), null);
});
