/*
 * Independent read-only checker for the Batch Runtime contract.  It does not
 * import the runtime or executor, so a test cannot pass merely because the
 * implementation reuses its own assertions.
 */
'use strict';

const ALLOWED_STATES = new Set(['attempted', 'write_unverified', 'skipped_existing', 'pending', 'unsupported', 'blocked']);

function ownPath(root, sourceKey) {
  if (typeof sourceKey !== 'string' || !sourceKey.startsWith('profile.')) return undefined;
  const tokens = sourceKey.slice(8).match(/[^.[\]]+|\[(\d+)\]/g)?.map((token) => token.startsWith('[') ? token.slice(1, -1) : token) || [];
  let value = root;
  for (const token of tokens) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(Object(value), token)) return undefined;
    value = value[token];
  }
  return value;
}

function equalValue(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left === 'string' || typeof right === 'string') return String(left ?? '').trim() === String(right ?? '').trim();
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equalValue(left[key], right[key]));
  }
  return false;
}

function checkSources(profile, fields) {
  const findings = [];
  const seen = new Set();
  for (const field of fields || []) {
    const sourceKey = field?.sourceKey;
    if (seen.has(sourceKey)) findings.push({ code: 'DUPLICATE_SOURCE', sourceKey });
    seen.add(sourceKey);
    const source = ownPath(profile, sourceKey);
    if (source === undefined) findings.push({ code: 'SOURCE_MISSING', sourceKey });
    else if (!equalValue(source, field.value)) findings.push({ code: 'VALUE_MISMATCH', sourceKey });
    if (field?.recordIdentity) {
      const match = String(sourceKey || '').match(/^profile\.(education|work|project|campus|award|language|family)\[(\d+)\]/);
      const row = match ? profile[match[1]]?.[Number(match[2])] : null;
      if (!row || row.identity !== field.recordIdentity) findings.push({ code: 'IDENTITY_MISMATCH', sourceKey, recordIdentity: field.recordIdentity });
    }
  }
  return findings;
}

function checkReport(report, { bridgeState } = {}) {
  const findings = [];
  if (!report?.runId || report.reportVersion !== 1) findings.push({ code: 'REPORT_METADATA' });
  if (!report?.tab || !Object.prototype.hasOwnProperty.call(report.tab, 'tabId')) findings.push({ code: 'TAB_METADATA' });
  if (!report?.summary || !Array.isArray(report.items) || !Array.isArray(report.userCheck)) findings.push({ code: 'REPORT_SHAPE' });
  if (bridgeState === 'disconnected' && !report?.stopReason) findings.push({ code: 'BRIDGE_STATE' });
  for (const item of report?.items || []) {
    if (!ALLOWED_STATES.has(item.status)) findings.push({ code: 'INVALID_STATE', status: item.status });
    if (report.tab?.tabId !== null && report.tab?.tabId !== undefined && item.tabId !== report.tab.tabId) findings.push({ code: 'ITEM_TAB_MISMATCH', sourceKey: item.sourceKey });
    if (item.status === 'attempted' && (item.readback !== 'matched' || String(item.currentValueBefore || '').trim())) findings.push({ code: 'ATTEMPTED_WITHOUT_EMPTY_READBACK', sourceKey: item.sourceKey });
  }
  return findings;
}

function audit({ profile, plannedFields, report, bridgeState } = {}) {
  const findings = [...checkSources(profile, plannedFields), ...checkReport(report, { bridgeState })];
  return { status: findings.length ? 'failed' : 'passed', findings };
}

module.exports = { audit, checkSources, checkReport, ownPath, equalValue };
