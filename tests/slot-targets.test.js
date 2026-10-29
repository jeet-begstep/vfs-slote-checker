// Run: node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSlotTargets,
  findSlotTargetColumn,
  matchCentreOption,
  vacCodeForCentreText,
  otherVacCode,
  planUiTargets,
  pickCategoryOption,
  findCategoryColumn
} = require('../slot-targets.js');

const codes = (targets) => targets.map((t) => `${t.vacCode}${t.extra ? '*' : ''}`);

test('planUiTargets: single selected target checks the other centre first (extra)', () => {
  assert.deepEqual(codes(planUiTargets([{ vacCode: 'AUH' }], 'AUH')), ['DXB*', 'AUH']);
});

test('planUiTargets: rotates so an unselected centre goes first', () => {
  assert.deepEqual(codes(planUiTargets([{ vacCode: 'AUH' }, { vacCode: 'DXB' }], 'AUH')), ['DXB', 'AUH']);
  assert.deepEqual(codes(planUiTargets([{ vacCode: 'AUH' }, { vacCode: 'DXB' }], 'DXB')), ['AUH', 'DXB']);
});

test('planUiTargets: keeps order when the first target is not selected', () => {
  assert.deepEqual(codes(planUiTargets([{ vacCode: 'DXB' }, { vacCode: 'AUH' }], 'AUH')), ['DXB', 'AUH']);
});

test('planUiTargets: dedupes (AUH|LL and AUH|LLN collapse) and uppercases', () => {
  assert.deepEqual(codes(planUiTargets([{ vacCode: 'auh' }, { vacCode: 'AUH' }, { vacCode: 'dxb' }], null)), ['AUH', 'DXB']);
});

test('planUiTargets: legacy null target uses the selected centre', () => {
  assert.deepEqual(codes(planUiTargets([], 'DXB')), ['AUH*', 'DXB']);
  assert.deepEqual(codes(planUiTargets([{ vacCode: null }], null)), ['null']);
});

test('planUiTargets: unknown current centre keeps all targets in order', () => {
  assert.deepEqual(codes(planUiTargets([{ vacCode: 'AUH' }, { vacCode: 'DXB' }], null)), ['AUH', 'DXB']);
});

test('otherVacCode returns a different known centre', () => {
  assert.equal(otherVacCode('AUH'), 'DXB');
  assert.equal(otherVacCode('DXB'), 'AUH');
  assert.equal(otherVacCode(null), 'AUH');
});

const CENTRES = [
  'Latvia Visa application center- Abu Dhabi',
  'Latvia Visa application center- Dubai'
];

test('matchCentreOption picks the centre for each vacCode', () => {
  assert.equal(matchCentreOption(CENTRES, 'AUH'), 0);
  assert.equal(matchCentreOption(CENTRES, 'DXB'), 1);
  assert.equal(matchCentreOption(CENTRES, 'dxb'), 1);
});

test('matchCentreOption: unknown code -1, null code first option', () => {
  assert.equal(matchCentreOption(CENTRES, 'SHJ'), -1);
  assert.equal(matchCentreOption(CENTRES, null), 0);
  assert.equal(matchCentreOption([], null), -1);
});

test('matchCentreOption tolerates case and extra whitespace', () => {
  assert.equal(matchCentreOption(['  LATVIA Visa centre -  ABU   DHABI '], 'AUH'), 0);
});

test('vacCodeForCentreText maps option text back to a code', () => {
  assert.equal(vacCodeForCentreText(CENTRES[0]), 'AUH');
  assert.equal(vacCodeForCentreText(CENTRES[1]), 'DXB');
  assert.equal(vacCodeForCentreText('Something else'), null);
  assert.equal(vacCodeForCentreText(''), null);
});

test('pickCategoryOption prefers "Do not test category"', () => {
  assert.equal(pickCategoryOption(['Long Stay', 'Do not test category', 'Short Stay']), 1);
});

test('pickCategoryOption falls back to Long Stay, else -1', () => {
  assert.equal(pickCategoryOption(['Short Stay', ' long  stay ']), 1);
  assert.equal(pickCategoryOption(['Short Stay']), -1);
  assert.equal(pickCategoryOption([]), -1);
});

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

test('pickCategoryOption uses the CSV category: exact, then contains, else -1', () => {
  const opts = ['Do not test category', 'Long Stay', 'Long Stay Plus'];
  assert.equal(pickCategoryOption(opts, 'long  stay'), 1);
  assert.equal(pickCategoryOption(opts, 'plus'), 2);
  assert.equal(pickCategoryOption(opts, 'Short Stay'), -1);
  assert.equal(pickCategoryOption(opts, ''), 0);
});

test('findCategoryColumn reads the category column, blank when missing', () => {
  assert.equal(findCategoryColumn({ email: 'a', category: ' Long Stay ' }), 'Long Stay');
  assert.equal(findCategoryColumn({ 'Appointment Category': 'X' }), 'X');
  assert.equal(findCategoryColumn({ 'vacCode|visaCategoryCode': 'AUH|LL' }), '');
  assert.equal(findCategoryColumn(null), '');
});
