// Loads accounts from a CSV (same format the popup reads).
const fs = require('node:fs');
const {
  parseCSV,
  parseSlotTargets,
  findSlotTargetColumn,
  findCategoryColumn
} = require('../slot-targets.js');

function rowToAccount(row) {
  return {
    username: row.email || row.user || row.username || '',
    password: row.password || row.pass || '',
    source: (row.source || '').toLowerCase(),
    destination: (row.destination || '').toLowerCase(),
    targets: parseSlotTargets(findSlotTargetColumn(row)).targets,
    category: findCategoryColumn(row)
  };
}

// Rows without credentials or without source/destination are skipped.
function parseAccounts(csvText) {
  return parseCSV(csvText)
    .map(rowToAccount)
    .filter((a) => a.username && a.password && a.source && a.destination);
}

function loadAccounts(path) {
  return parseAccounts(fs.readFileSync(path, 'utf8'));
}

function loginUrl(account) {
  return `https://visa.vfsglobal.com/${account.source}/en/${account.destination}/login`;
}

module.exports = { parseAccounts, loadAccounts, loginUrl };
