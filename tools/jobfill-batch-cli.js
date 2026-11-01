/*
 * Jobfill's task-level execution boundary.  The Agent supplies one planned
 * field list; this module owns profile validation, tab identity, snapshot
 * rebinding, batch execution, readback reporting, and the no-submit guard.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { convertMdToJson } = require('./profile-converter.js');
const { WidgetExecutor, BridgeDisconnectedError, matchesValue, inferKind, isBlank } = require('./widget-executor.js');
const { resolveTargetTab, assertUrl } = require('./tab-resolver.js');
const { createHuashuBridge, connectHuashuBridge, loadTransport, bridgeError, HuashuBridgeError } = require('./huashu-bridge.js');

const REPORT_VERSION = 1;
const FORBIDDEN_LABEL = /保存|提交|投递|下一步|预览并提交|确认申请|协议|验证码|otp|支付/i;
const ALLOWED_COMPLEX = new Set(['moka-sd-select', 'moka-month-pair', 'owned-popup-select', 'feishu-date-range', 'phoenix-select', 'phoenix-date', 'phoenix-constant', 'phoenix-area', 'phoenix-radio', 'aria-radio', 'feishu-radio', 'jd-profession', 'primeng-select', 'primeng-radio', 'primeng-date']);
const ALLOWED_NATIVE_CONTROLS = new Set(['native-input', 'native-textarea', 'native-select', 'native-radio', 'text', 'textarea', 'select', 'radio']);
const ALLOWED_NATIVE_TAGS = new Set(['input', 'textarea', 'select']);
const ALLOWED_ROLES = new Set(['textbox', 'combobox', 'radio']);

function isForbiddenField(field) {
  const label = String(field?.label || '');
  const tag = String(field?.tagName || field?.elementTag || '').toLowerCase();
  return FORBIDDEN_LABEL.test(label) || tag === 'button' || tag === 'submit' || field?.type === 'submit';
}

function fieldPolicy(field) {
  const label = String(field?.label || '');
  const role = String(field?.role || '').toLowerCase();
  const tag = String(field?.tagName || field?.elementTag || '').toLowerCase();
  const type = String(field?.type || '').toLowerCase();
  const locator = `${field?.selector || ''} ${field?.css || ''} ${JSON.stringify(field?.find || '')}`;
  if (FORBIDDEN_LABEL.test(label) || /save|submit|apply|next|agreement|consent|保存|提交|投递|下一步|协议|确认/i.test(locator) || ['button', 'submit', 'a'].includes(tag) || ['button', 'link'].includes(role) || ['submit', 'file', 'password'].includes(type)) {
    return { status: 'blocked', reason: '命中禁止操作边界' };
  }
  if (field?.disabled || field?.readOnly || field?.editable === false) return { status: 'unsupported', reason: '控件不可编辑' };
  const kind = inferKind(field);
  if (field?.widgetKind && ALLOWED_COMPLEX.has(kind)) return { status: 'write' };
  if (field?.controlType && ALLOWED_COMPLEX.has(kind)) return { status: 'write' };
  if (ALLOWED_NATIVE_CONTROLS.has(String(field?.controlType || '').toLowerCase())) return { status: 'write' };
  if (ALLOWED_NATIVE_TAGS.has(tag) || ALLOWED_ROLES.has(role) || ['text', 'email', 'tel', 'number', 'date', 'radio'].includes(type)) return { status: 'write' };
  return { status: 'unsupported', reason: '未知控件类型，禁止自动执行' };
}

function unwrap(value) {
  if (value && typeof value === 'object') {
    if (value.error || value.ok === false) {
      const error = value.error || value;
      throw new HuashuBridgeError(error.message || 'Huashu bridge 返回错误', error.code || 'BRIDGE_DISCONNECTED');
    }
    if ('value' in value) return unwrap(value.value);
  }
  return value;
}

function tabsFrom(value) {
  const result = unwrap(value);
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.tabs)) return result.tabs;
  if (Array.isArray(result?.items)) return result.items;
  const text = typeof result?.text === 'string' ? result.text : typeof result === 'string' ? result : '';
  const tabs = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[(\d+)\].*?—\s+(https?:\/\/\S+)\s*$/);
    if (match) tabs.push({ id: Number(match[1]), tabId: Number(match[1]), url: match[2], title: line });
  }
  if (tabs.length) return tabs;
  return [];
}

function snapshotFrom(value) {
  const result = unwrap(value);
  const snapshot = result?.snapshot ?? result?.data ?? result ?? null;
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  if (snapshot.url || snapshot.pageUrl || snapshot.location?.href) return snapshot;
  const text = typeof snapshot.text === 'string' ? snapshot.text : '';
  const meta = typeof snapshot.meta === 'string' ? snapshot.meta : '';
  const url = (meta.match(/url="([^"]+)"/) || text.match(/^#.*?—\s+(https?:\/\/\S+)/m))?.[1] || null;
  const snapshotId = snapshot.snapshotId || (meta.match(/snapshot="([^"]+)"/) || text.match(/\[snapshot\s+([^\]]+)\]/))?.[1] || null;
  return { ...snapshot, ...(url ? { url } : {}), ...(snapshotId ? { snapshotId } : {}) };
}

function countGroups(profile) {
  return Object.fromEntries(['education', 'work', 'project', 'campus', 'award', 'language'].map((key) => [key, Array.isArray(profile[key]) ? profile[key].length : 0]));
}

function emptySummary() {
  return { attempted: 0, skippedExisting: 0, pending: 0, unsupported: 0, blocked: 0, writeUnverified: 0 };
}

function summarize(items) {
  const summary = emptySummary();
  for (const item of items) {
    if (item.status === 'attempted') summary.attempted += 1;
    else if (item.status === 'skipped_existing') summary.skippedExisting += 1;
    else if (item.status === 'pending') summary.pending += 1;
    else if (item.status === 'unsupported') summary.unsupported += 1;
    else if (item.status === 'blocked') summary.blocked += 1;
    else if (item.status === 'write_unverified') summary.writeUnverified += 1;
  }
  return summary;
}

function itemBase(field, status, reason) {
  return { pageLabel: field?.label, sourceKey: field?.sourceKey, recordIdentity: field?.recordIdentity,
    matchMode: field?.matchMode || 'exact', action: status === 'skipped_existing' ? 'skip' : 'write', status,
    readback: status === 'skipped_existing' ? 'matched' : 'failed', ...(field?.sourceText ? { sourceText: field.sourceText } : {}), ...(reason ? { reason } : {}) };
}

function profilePathValue(profile, sourceKey) {
  if (typeof sourceKey !== 'string' || !sourceKey.startsWith('profile.')) return undefined;
  const tokens = sourceKey.slice('profile.'.length).match(/[^.[\]]+|\[(\d+)\]/g)?.map((token) => token.startsWith('[') ? token.slice(1, -1) : token) || [];
  return tokens.reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, profile);
}

function ownProfilePathValue(profile, sourceKey) {
  if (typeof sourceKey !== 'string' || !sourceKey.startsWith('profile.')) return undefined;
  const tokens = sourceKey.slice('profile.'.length).match(/[^.[\]]+|\[(\d+)\]/g)?.map((token) => token.startsWith('[') ? token.slice(1, -1) : token) || [];
  let value = profile;
  for (const key of tokens) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(Object(value), key)) return undefined;
    value = value[key];
  }
  return value;
}

function sourceValidation(profile, field, duplicateSource) {
  // 会话中由用户确认的事实、以及由资料字段派生的复合值（如省份部分、电话区号）不属于
  // profile JSON 字段。它们仍必须留下可审计的 sourceText 说明，缺失即拒绝，绝不静默放行。
  if (typeof field?.sourceKey === 'string' && field.sourceKey.startsWith('user.')) {
    if (duplicateSource) return { invalidSource: true, reason: '同一 sourceKey 被多个字段计划复用，拒绝覆盖' };
    if (typeof field?.sourceText !== 'string' || !field.sourceText.trim()) return { invalidSource: true, reason: 'user.* 来源缺少 sourceText 说明' };
    if (field?.value === undefined || !String(field.value).trim()) return { invalidSource: true, reason: 'user.* 来源缺少写入值' };
    return { invalidSource: false, sourceValue: field.value, sourceType: 'user' };
  }
  const sourceValue = ownProfilePathValue(profile, field?.sourceKey);
  if (sourceValue === undefined) return { invalidSource: true, reason: '资料 sourceKey 不存在或不是自有字段' };
  if (duplicateSource) return { invalidSource: true, reason: '同一 sourceKey 被多个字段计划复用，拒绝覆盖' };
  if (field?.recordIdentity) {
    const path = String(field.sourceKey).slice('profile.'.length);
    const rowMatch = path.match(/^(education|work|project|campus|award|language|family)\[(\d+)\]/);
    const row = rowMatch ? profile[rowMatch[1]]?.[Number(rowMatch[2])] : null;
    if (!row || row.identity !== field.recordIdentity) return { invalidSource: true, reason: 'recordIdentity 与资料记录不一致' };
  }
  if (field?.value === undefined || !matchesValue(sourceValue, field.value, field)) return { invalidSource: true, reason: 'planned value 与 profile source 不一致' };
  return { invalidSource: false, sourceValue };
}

function withTabId(items, tabId) {
  return items.map((item) => ({ ...item, tabId }));
}

function siteRules(url, rootDir) {
  const hostname = new URL(url).hostname;
  const files = [path.join(rootDir, 'site-hints', 'generic.json'), path.join(rootDir, 'site-hints', `${hostname}.json`)].filter((file) => fs.existsSync(file));
  const merged = {};
  for (const file of files) {
    let hint;
    try { hint = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new HuashuBridgeError(`site-hints 配置无效: ${path.basename(file)}`, 'CONFIG_INVALID'); }
    if (hint.urlNormalization) merged.urlNormalization = { ...(merged.urlNormalization || {}), ...hint.urlNormalization };
  }
  return merged.urlNormalization || {};
}

function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('request 必须是 JSON 对象');
  const url = assertUrl(input.url, 'url').href;
  if (typeof input.profilePath !== 'string' || !input.profilePath.trim()) throw new TypeError('profilePath 必须是非空字符串');
  if (!Array.isArray(input.plannedFields) || input.plannedFields.length > 200) throw new TypeError('plannedFields 必须是最多 200 项的数组');
  return { ...input, url, profilePath: path.resolve(input.profilePath), snapshotHint: input.snapshotHint || null };
}

async function runBatch(input, { bridge, rootDir = path.resolve(__dirname, '..'), runIdFactory = () => crypto.randomUUID() } = {}) {
  const request = validateRequest(input);
  const runId = runIdFactory();
  const startedAt = new Date().toISOString();
  const base = { runId, reportVersion: REPORT_VERSION, tab: { tabId: null, url: request.url }, tabReused: false,
    tabCreated: false, tabSelectFallback: false, profileValidated: false, profile: { valid: false, profileValidated: false, sourceDigest: null, recordCounts: {} },
    snapshotCaptured: false, snapshotRebound: false, bridgeState: bridge?.state?.connected ? (bridge.state.kind || 'connected') : (bridge ? 'injected' : 'disconnected'), items: [], userCheck: [], stopReason: null, startedAt };
  if (!bridge) {
    const items = withTabId(request.plannedFields.map((field) => itemBase(field, 'blocked', 'Huashu bridge 未连接')), null);
    return { ...base, stopReason: 'BRIDGE_UNAVAILABLE', items, userCheck: items.map((item) => ({ pageLabel: item.pageLabel, status: item.status, reason: item.reason })), summary: summarize(items), finishedAt: new Date().toISOString() };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobfill-batch-'));
  try {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(request.profilePath)).digest('hex');
    let converted;
    try {
      converted = convertMdToJson(request.profilePath, path.join(tempDir, 'profile.json'));
    } catch (error) {
      base.stopReason = 'PROFILE_INVALID';
      base.profileError = '资料校验失败';
      base.profileErrorCode = 'PROFILE_INVALID';
      base.items = withTabId(request.plannedFields.map((field) => itemBase(field, 'blocked', '资料校验失败')), null);
      base.userCheck = base.items.map((item) => ({ pageLabel: item.pageLabel, status: item.status, reason: item.reason }));
      base.summary = summarize(base.items);
      base.finishedAt = new Date().toISOString();
      return base;
    }
    base.profileValidated = true;
    base.profile = { valid: true, profileValidated: true, sourceDigest: digest, recordCounts: countGroups(converted.profile) };

    const listed = tabsFrom(await bridge.tabs({ action: 'list' }));
    // 已观察并指定的标签必须固定；URL 改写或关闭时停止，不能创建相同简历的竞争草稿。
    const pinnedId = request.snapshotHint?.tabId;
    const candidates = pinnedId === undefined ? listed : listed.filter(t=>Number(t.tabId??t.id)===Number(pinnedId));
    const resolution = resolveTargetTab({ requestedUrl: request.url, tabs: candidates, rules: siteRules(request.url, rootDir) });
    if (pinnedId !== undefined && resolution.action !== 'reuse') throw new HuashuBridgeError('指定标签已关闭或 URL 已变化，请重新观察', 'TARGET_CLOSED');
    if (resolution.action === 'blocked') {
      const items = withTabId(request.plannedFields.map((f) => itemBase(f, 'blocked', resolution.reason)), null);
      return { ...base, stopReason: 'MULTIPLE_TARGET_TABS', items, summary: summarize(items), finishedAt: new Date().toISOString() };
    }
    let tabId;
    let currentUrl = request.url;
    if (resolution.action === 'reuse') {
      tabId = resolution.tabId;
      if (tabId === null || tabId === undefined) throw new HuashuBridgeError('命中标签缺少 tabId', 'TARGET_CLOSED');
      try {
        await bridge.tabs({ action: 'select', tabId });
      } catch (error) {
        // Huashu 允许多个 agent 会话读取同一标签，但 select 可能因另一个
        // 会话持有控制槽返回 NO_TAB；URL 后续仍会用同一显式 tabId 核验，
        // 只有该核验成功才允许继续，避免因为控制槽竞争而误建重复标签。
        if (String(error?.code || '').toUpperCase() !== 'NO_TAB') throw error;
        base.tabSelectFallback = true;
      }
      base.tabReused = true;
      currentUrl = resolution.matchedUrl || request.url;
    } else {
      const created = unwrap(await bridge.tabs({ action: 'new', url: request.url, label: 'Jobfill 网申填写' }));
      tabId = created?.tabId ?? created?.id ?? created;
      if (tabId === null || tabId === undefined) throw new HuashuBridgeError('新建标签未返回 tabId', 'TARGET_CLOSED');
      base.tabCreated = true;
    }
    base.tab = { tabId, url: currentUrl };
    const snapshot = snapshotFrom(await bridge.snapshot({ tabId }));
    if (!snapshot) throw new HuashuBridgeError('snapshot 为空', 'TARGET_CLOSED');
    base.snapshotCaptured = true;
    const snapshotUrl = snapshot.url || snapshot.pageUrl || snapshot.location?.href;
    if (!snapshotUrl) throw new HuashuBridgeError('snapshot 缺少当前 URL，无法证明未导航', 'TARGET_CLOSED');
    if (snapshotUrl && resolveTargetTab({ requestedUrl: request.url, tabs: [{ id: tabId, url: snapshotUrl }], rules: siteRules(request.url, rootDir) }).action !== 'reuse') {
      throw new HuashuBridgeError('页面 URL 已导航离开目标页', 'TARGET_CLOSED');
    }

    const executor = new WidgetExecutor({ bridge });
    const sourceCounts = new Map(request.plannedFields.map((field) => [field?.sourceKey, (request.plannedFields.filter((item) => item?.sourceKey === field?.sourceKey)).length]));
    const planned = request.plannedFields.map((field) => ({ field, policy: fieldPolicy(field) }));
    const sourceChecked = request.plannedFields.map((field) => {
      return { field, ...sourceValidation(converted.profile, field, sourceCounts.get(field?.sourceKey) > 1) };
    });
    const rebinding = executor.rebindFields(sourceChecked.map((entry, index) => entry.invalidSource || planned[index].policy.status !== 'write' ? { ...entry.field, blocked: true } : { ...entry.field, value: entry.sourceValue }), snapshot);
    const readyFields = [];
    for (let index = 0; index < rebinding.length; index += 1) {
      const policy = planned[index].policy;
      if (policy.status === 'blocked') base.items.push({ ...itemBase(request.plannedFields[index], 'blocked', policy.reason), tabId });
      else if (policy.status === 'unsupported') base.items.push({ ...itemBase(request.plannedFields[index], 'unsupported', policy.reason), tabId });
      else if (sourceChecked[index].invalidSource) base.items.push({ ...itemBase(request.plannedFields[index], 'pending', sourceChecked[index].reason), tabId });
      else if (rebinding[index].rebindFailed) base.items.push({ ...itemBase(request.plannedFields[index], 'pending', rebinding[index].reason), tabId });
      else { base.snapshotRebound = base.snapshotRebound || rebinding[index].snapshotRebound; readyFields.push(rebinding[index].field); }
    }
    const executed = await executor.executeFields(tabId, readyFields, {
      values: Object.fromEntries(readyFields.map((field) => [field.sourceKey, field.value])),
      beforeField: async (field) => {
        const currentSnapshot = snapshotFrom(await bridge.snapshot({ tabId }));
        const currentUrl = currentSnapshot?.url || currentSnapshot?.pageUrl || currentSnapshot?.location?.href;
        if (!currentUrl || resolveTargetTab({ requestedUrl: request.url, tabs: [{ id: tabId, url: currentUrl }], rules: siteRules(request.url, rootDir) }).action !== 'reuse') {
          throw new HuashuBridgeError('页面 URL 已导航或不可核验', 'TARGET_CLOSED');
        }
        const rebound = executor.rebindFields([field], currentSnapshot)[0];
        if (rebound.rebindFailed) return { ...field, pendingReason: rebound.reason };
        const currentField = rebound.field;
        const policy = fieldPolicy(currentField);
        if (policy.status !== 'write') return { ...currentField, unsupported: policy.status === 'unsupported', unsupportedReason: policy.reason, blocked: policy.status === 'blocked', blockedReason: policy.reason };
        if (currentField.selector || currentField.css) {
          const freshValue = await executor.readBack(tabId, currentField);
          if (freshValue === undefined) return { ...currentField, pendingReason: '没有实时当前值证据' };
          currentField.currentValue = freshValue;
          currentField.currentValueKnown = true;
          if (currentField.authorizedReplacement) {
            const consent = currentField.authorizedReplacement;
            if (typeof consent.sourceText !== 'string' || !consent.sourceText.trim() || !matchesValue(consent.expectedCurrentValue, freshValue, currentField)) return { ...currentField, pendingReason: '授权更正缺少来源或页面现值已变化' };
            currentField.authorizedCurrentValue = freshValue;
            currentField.currentValue = '';
          }
          // 搜索框的临时输入可能已同步到主字段，但还需选中同值结果关闭弹层。
          // 仅允许当前值与来源一致且指定弹层确实可见时完成同值选择，不能覆盖其他已有值。
          if (currentField.finalizeMatchingPopup === true && currentField.popupAlreadyOpenSelector && matchesValue(currentField.value, freshValue, currentField)) {
            const open = unwrap(await bridge.eval({ tabId, expr: `(()=>{const n=document.querySelector(${JSON.stringify(currentField.popupAlreadyOpenSelector)});return !!n&&n.getBoundingClientRect().height>0})()` }));
            const visible = open === true || open?.text === 'true';
            if (visible) currentField.currentValue = '';
          }
        } else if (!currentField.currentValueKnown) {
          return { ...currentField, pendingReason: '没有实时当前值证据' };
        }
        return currentField;
      }
    });
    // 用户/派生来源的说明必须回填到报告，避免与 profile 字段来源混淆。
    const provenance = new Map(request.plannedFields.filter((field) => field?.sourceText).map((field) => [field.sourceKey, field.sourceText]));
    base.items.push(...withTabId(executed, tabId).map((item) => provenance.has(item.sourceKey) ? { ...item, sourceText: provenance.get(item.sourceKey) } : item));
    const bridgeBlocked = executed.find((item) => item.status === 'blocked' && item.errorCode);
    if (bridgeBlocked) base.stopReason = bridgeBlocked.errorCode;
    base.userCheck = base.items.filter((item) => ['pending', 'unsupported', 'blocked', 'write_unverified'].includes(item.status) || item.requiresUserCheck).map((item) => ({ pageLabel: item.pageLabel, sourceKey: item.sourceKey, tabId: item.tabId, status: item.status, reason: item.reason || '需要用户检查',
      ...(Object.prototype.hasOwnProperty.call(item, 'expectedValue') ? { currentValue: item.value, expectedValue: item.expectedValue } : {}) }));
    base.summary = summarize(base.items);
    base.finishedAt = new Date().toISOString();
    return base;
  } catch (error) {
    const normalized = error instanceof HuashuBridgeError || error instanceof BridgeDisconnectedError || error?.code ? bridgeError(error) : null;
    const reason = normalized ? normalized.code : `RUNTIME_ERROR:${error?.message || String(error)}`;
    base.stopReason = reason;
    base.items.push(...withTabId(request.plannedFields.map((field) => itemBase(field, 'blocked', reason)), base.tab.tabId));
    base.summary = summarize(base.items);
    base.finishedAt = new Date().toISOString();
    return base;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--request-file');
  if (index < 0 || !args[index + 1]) { console.error('用法: node tools/jobfill-batch-cli.js --request-file <request.json>'); process.exitCode = 2; return; }
  const request = JSON.parse(fs.readFileSync(path.resolve(args[index + 1]), 'utf8'));
  let bridge;
  const runId = crypto.randomUUID();
  try {
    bridge = process.env.JOBFILL_BRIDGE_MODULE
      ? createHuashuBridge(loadTransport(process.env.JOBFILL_BRIDGE_MODULE))
      : await connectHuashuBridge({ runId, configPath: process.env.JOBFILL_BRIDGE_CONFIG });
  } catch (error) {
    const reason = bridgeError(error);
    const report = await runBatch(request, { bridge: null, runIdFactory: () => runId });
    report.stopReason = reason.code;
    report.bridgeError = reason.code;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const report = await runBatch(request, { bridge, runIdFactory: () => runId });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.stopReason) process.exitCode = 1;
  } finally { await bridge.close?.(); }
}

if (require.main === module) main().catch((error) => { console.error(error?.message || error); process.exitCode = 1; });

module.exports = { runBatch, validateRequest, summarize, REPORT_VERSION, FORBIDDEN_LABEL, isForbiddenField, tabsFrom, snapshotFrom };
