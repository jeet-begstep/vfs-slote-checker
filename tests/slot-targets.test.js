// Run: node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSlotTargets, findSlotTargetColumn } = require('../slot-targets.js');

test('parses multiple vacCode|category pairs', () => {
  assert.deepEqual(parseSlotTargets('AUH|LL,DXB|LL'), {
    targets: [
      { vacCode: 'AUH', visaCategoryCode: 'LL' },
      { vacCode: 'DXB', visaCategoryCode: 'LL' }
    ],
    invalid: []
  });
});

test('trims spaces around separators and ignores trailing comma', () => {
  assert.deepEqual(parseSlotTargets(' AUH | LLN , DXB|LL ,').targets, [
    { vacCode: 'AUH', visaCategoryCode: 'LLN' },
    { vacCode: 'DXB', visaCategoryCode: 'LL' }
  ]);
});

test('legacy single category has null vacCode', () => {
  assert.deepEqual(parseSlotTargets('EmployL'), {
    targets: [{ vacCode: null, visaCategoryCode: 'EmployL' }],
    invalid: []
  });
});

test('reports invalid pairs and keeps valid ones', () => {
  assert.deepEqual(parseSlotTargets('|LL,DXB|,A|B|C,AUH|LL'), {
    targets: [{ vacCode: 'AUH', visaCategoryCode: 'LL' }],
    invalid: ['|LL', 'DXB|', 'A|B|C']
  });
});

test('empty or missing cell yields no targets', () => {
  assert.deepEqual(parseSlotTargets(''), { targets: [], invalid: [] });
  assert.deepEqual(parseSlotTargets(null), { targets: [], invalid: [] });
  assert.deepEqual(parseSlotTargets(undefined), { targets: [], invalid: [] });
});

test('uppercases vacCode and dedupes', () => {
  assert.deepEqual(parseSlotTargets('dxb|LL,DXB|LL').targets, [
    { vacCode: 'DXB', visaCategoryCode: 'LL' }
  ]);
});

test('keeps category case as-is', () => {
  assert.deepEqual(parseSlotTargets('DXB|ll').targets, [
    { vacCode: 'DXB', visaCategoryCode: 'll' }
  ]);
});

test('finds old and new column headers', () => {
  assert.equal(findSlotTargetColumn({ email: 'a', visaCategoryCode: 'EmployL' }), 'EmployL');
  assert.equal(findSlotTargetColumn({ email: 'a', 'vacCode|visaCategoryCode': 'AUH|LL' }), 'AUH|LL');
  assert.equal(findSlotTargetColumn({ email: 'a', source: 'are' }), null);
  assert.equal(findSlotTargetColumn(null), null);
});

test('a bare vacCode column is not read as a category', () => {
  assert.equal(findSlotTargetColumn({ vacCode: 'AUH', visaCategoryCode: 'LL' }), 'LL');
  assert.equal(findSlotTargetColumn({ vacCode: 'AUH' }), null);
});

test('combined header wins over a separate visaCategoryCode column', () => {
  assert.equal(
    findSlotTargetColumn({ visaCategoryCode: 'EmployL', 'vacCode|visaCategoryCode': 'AUH|LL' }),
    'AUH|LL'
  );
});

test('mixed legacy and pair cell, and a lone pipe', () => {
  assert.deepEqual(parseSlotTargets('EmployL,DXB|LL').targets, [
    { vacCode: null, visaCategoryCode: 'EmployL' },
    { vacCode: 'DXB', visaCategoryCode: 'LL' }
  ]);
  assert.deepEqual(parseSlotTargets('|'), { targets: [], invalid: ['|'] });
});
