// Parses the CSV "vacCode|visaCategoryCode" cell into slot-check targets.
// Loaded by popup.html via <script>; also require()-able from node tests.

function parseSlotTargets(cell) {
  const targets = [];
  const invalid = [];
  const seen = new Set();

  String(cell ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const pieces = part.split('|').map((p) => p.trim());

      let target;
      if (pieces.length === 1) {
        // Legacy single category (e.g. "EmployL"): vacCode is derived from the URL later.
        target = { vacCode: null, visaCategoryCode: pieces[0] };
      } else if (pieces.length === 2 && pieces[0] && pieces[1]) {
        target = { vacCode: pieces[0].toUpperCase(), visaCategoryCode: pieces[1] };
      } else {
        invalid.push(part);
        return;
      }

      const key = `${target.vacCode}|${target.visaCategoryCode}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(target);
    });

  return { targets, invalid };
}

// Prefers the combined "vacCode|visaCategoryCode" header, then the old
// "visaCategoryCode" one. A bare "vacCode" column is never read as a category.
function findSlotTargetColumn(row) {
  const keys = Object.keys(row || {});
  const key =
    keys.find((k) => /^\s*vaccode\s*\|\s*visacategorycode\s*$/i.test(k)) ||
    keys.find((k) => /^\s*visacategorycode\s*$/i.test(k));
  return key ? row[key] : null;
}

// --- UAE dropdown flow (content.js) -----------------------------------------

// vacCode -> text that appears in the "Choose your Application Centre" option.
const VAC_CENTRE_LABELS = {
  AUH: 'abu dhabi',
  DXB: 'dubai'
};

function normalizeOptionText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Index of the centre option for vacCode; null vacCode (legacy CSV) -> 0; unknown -> -1.
function matchCentreOption(optionTexts, vacCode) {
  if (!vacCode) return optionTexts.length ? 0 : -1;
  const label = VAC_CENTRE_LABELS[String(vacCode).toUpperCase()];
  if (!label) return -1;
  return optionTexts.findIndex((t) => normalizeOptionText(t).includes(label));
}

// Reverse of VAC_CENTRE_LABELS: option text -> vacCode, or null if unknown.
function vacCodeForCentreText(text) {
  const normalized = normalizeOptionText(text);
  const code = Object.keys(VAC_CENTRE_LABELS).find((c) => normalized.includes(VAC_CENTRE_LABELS[c]));
  return code || null;
}

// A known centre other than currentCode (to force the page to re-check), or null.
function otherVacCode(currentCode) {
  return Object.keys(VAC_CENTRE_LABELS).find((code) => code !== currentCode) || null;
}

// Orders and dedupes the centres to check this cycle.
// - rawTargets: stored [{vacCode|null}]; null (legacy CSV) means the currently selected centre.
// - Re-selecting the already-selected centre doesn't make the page call the API,
//   so start with a centre that isn't selected. If the only target is the selected
//   one, check the other centre first (flagged `extra`: logged, never alerted).
function planUiTargets(rawTargets, currentCode) {
  const seen = new Set();
  let targets = (rawTargets && rawTargets.length ? rawTargets : [{ vacCode: null }])
    .map((t) => ({ vacCode: t && t.vacCode ? String(t.vacCode).toUpperCase() : currentCode || null }))
    .filter((t) => {
      const key = t.vacCode || '';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const startIdx = targets.findIndex((t) => !currentCode || t.vacCode !== currentCode);

  if (startIdx > 0) {
    targets = targets.slice(startIdx).concat(targets.slice(0, startIdx));
  } else if (startIdx < 0) {
    const other = otherVacCode(currentCode);
    if (other) targets = [{ vacCode: other, extra: true }].concat(targets);
  }

  return targets;
}

// Value of the optional "category" CSV column (the appointment category text
// to pick on the UAE dropdown flow), or '' when absent/blank.
function findCategoryColumn(row) {
  const key = Object.keys(row || {}).find((k) => /^\s*(appointment\s*)?category\s*$/i.test(k));
  return key ? String(row[key] ?? '').trim() : '';
}

// With `preferred` (from the CSV): exact text match first, then contains; -1 if
// absent (never a silent different category). Without it: "Do not test
// category" if offered, otherwise "Long Stay"; -1 if neither.
function pickCategoryOption(optionTexts, preferred) {
  const want = normalizeOptionText(preferred);
  if (want) {
    const exact = optionTexts.findIndex((t) => normalizeOptionText(t) === want);
    return exact >= 0 ? exact : optionTexts.findIndex((t) => normalizeOptionText(t).includes(want));
  }
  const testIdx = optionTexts.findIndex((t) => /do not test category/.test(normalizeOptionText(t)));
  if (testIdx >= 0) return testIdx;
  return optionTexts.findIndex((t) => /long stay/.test(normalizeOptionText(t)));
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseSlotTargets,
    findSlotTargetColumn,
    findCategoryColumn,
    VAC_CENTRE_LABELS,
    matchCentreOption,
    vacCodeForCentreText,
    otherVacCode,
    planUiTargets,
    pickCategoryOption
  };
}
