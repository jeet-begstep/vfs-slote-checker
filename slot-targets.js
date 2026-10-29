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

if (typeof module !== 'undefined') {
  module.exports = { parseSlotTargets, findSlotTargetColumn };
}
