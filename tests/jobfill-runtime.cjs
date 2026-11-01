const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBatch } = require('../tools/jobfill-batch-cli.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobfill-runtime-test-'));
const md = path.join(temp, 'profile.md');
fs.writeFileSync(md, ['# profile', '', '```json', JSON.stringify({ jobfill: 1, basic: { name: '匿名' }, education: [], work: [], project: [], campus: [], award: [], language: [] }, null, 2), '```'].join('\n'));

async function reusedBridge(initialValue = '匿名') {
  const calls = [];
  let currentValue = initialValue;
  return {
    calls,
    async tabs(args) {
      calls.push(['tabs', args]);
      if (args.action === 'list') return [{ id: 7, url: 'https://example.test/app' }];
      return { tabId: args.tabId ?? 7 };
    },
    async snapshot() { calls.push(['snapshot']); return { snapshotId: 'new', revision: 2, url: 'https://example.test/app', fields: [{ ref: 'fresh', label: '姓名', selector: '#name', tagName: 'INPUT', currentValue: '' }] }; },
    async fill(args) { calls.push(['fill', args]); currentValue = args.fields[0].text; },
    async eval(args) { calls.push(['eval', args]); return { value: currentValue }; }
  };
}

(async () => {
  const bridge = await reusedBridge();
  const report = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT', snapshotId: 'old' }] }, { bridge, runIdFactory: () => 'run-reuse' });
  assert.equal(report.tabReused, true);
  assert.equal(report.tabCreated, false);
  assert.equal(report.profileValidated, true);
  assert.equal(report.profile.profileValidated, true);
  assert.equal(report.snapshotCaptured, true);
  assert.equal(report.items[0].status, 'skipped_existing', '写入前 fresh readback 发现页面已有值时必须保护已有值');
  assert.equal(report.items[0].tabId, 7);
  assert.equal(bridge.calls.filter(([name]) => name === 'fill').length, 0);
  assert.equal(bridge.calls.filter(([name, args]) => name === 'tabs' && args?.action === 'new').length, 0);

  const conflictingBridge = await reusedBridge('解析错误的姓名');
  const conflicting = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT' }] }, { bridge: conflictingBridge });
  assert.equal(conflicting.items[0].status, 'pending', '实时现值与资料冲突时，不能因 snapshot 曾为空而误报匹配');
  assert.equal(conflicting.items[0].readback, 'failed');
  assert.equal(conflicting.items[0].value, '解析错误的姓名');
  assert.equal(conflicting.items[0].expectedValue, '匿名');
  assert.equal(conflicting.summary.pending, 1);
  assert.equal(conflicting.summary.skippedExisting, 0);
  assert.equal(conflicting.userCheck[0].currentValue, '解析错误的姓名');
  assert.equal(conflicting.userCheck[0].expectedValue, '匿名');
  assert.equal(conflictingBridge.calls.filter(([name]) => name === 'fill').length, 0);

  const correctionBridge = await reusedBridge('解析错误的姓名');
  const corrected = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT', authorizedReplacement: { expectedCurrentValue: '解析错误的姓名', sourceText: '用户已授权按资料更正解析错误的姓名' } }] }, { bridge: correctionBridge });
  assert.equal(corrected.items[0].status, 'attempted', '显式授权的更正仍应写入并读回成功');
  assert.equal(corrected.items[0].readback, 'matched');
  assert.equal(corrected.items[0].value, '匿名');
  assert.equal(corrected.userCheck.length, 0);
  assert.equal(correctionBridge.calls.filter(([name]) => name === 'fill').length, 1);

  const changedBridge = await reusedBridge('用户刚修改的姓名');
  const changed = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT', authorizedReplacement: { expectedCurrentValue: '解析错误的姓名', sourceText: '用户已授权按资料更正解析错误的姓名' } }] }, { bridge: changedBridge });
  assert.equal(changed.items[0].status, 'pending', '更正授权不能覆盖授权后用户新改的内容');
  assert.match(changed.items[0].reason, /现值已变化/);
  assert.equal(changedBridge.calls.filter(([name]) => name === 'fill').length, 0);

  const mixedValues = { name: '解析错误的姓名', city: '' };
  const mixedWrites = [];
  const mixedBridge = {
    async tabs(args) { return args.action === 'list' ? [{ id: 7, url: 'https://example.test/app' }] : { tabId: 7 }; },
    async snapshot() { return { snapshotId: 'mixed', url: 'https://example.test/app', fields: Object.entries(mixedValues).map(([key, currentValue]) => ({ ref: key, selector: `#${key}`, tagName: 'INPUT', currentValue })) }; },
    async eval(args) { const key = args.expr.includes('#name') ? 'name' : 'city'; return { value: mixedValues[key] }; },
    async fill(args) { const item = args.fields[0]; mixedWrites.push(item.ref); mixedValues[item.ref] = item.text; }
  };
  const mixed = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [
    { label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT' },
    { label: '所在地', sourceKey: 'user.city', sourceText: '用户已确认所在地为示例城市', value: '示例城市', selector: '#city', tagName: 'INPUT' }
  ] }, { bridge: mixedBridge });
  assert.deepEqual(mixed.items.map(item => item.status), ['pending', 'attempted'], '单项冲突不能阻塞后续可确定的空字段');
  assert.equal(mixedValues.name, '解析错误的姓名');
  assert.equal(mixedValues.city, '示例城市');
  assert.deepEqual(mixedWrites, ['city']);
  assert.equal(mixed.summary.pending, 1);
  assert.equal(mixed.summary.attempted, 1);
  assert.equal(mixed.userCheck.length, 1);

  const sharedTabBridge = await reusedBridge();
  const originalSelect = sharedTabBridge.tabs;
  sharedTabBridge.tabs = async args => {
    if (args.action === 'select') { const error = new Error('no controlled tab'); error.code = 'NO_TAB'; throw error; }
    return originalSelect(args);
  };
  const sharedTab = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [] }, { bridge: sharedTabBridge, runIdFactory: () => 'run-shared-tab' });
  assert.equal(sharedTab.tabReused, true);
  assert.equal(sharedTab.tabSelectFallback, true);
  assert.equal(sharedTab.snapshotCaptured, true, '同一 URL 的共享控制槽竞争仍须用显式 tabId 读回核验');

  const blocked = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '保存并提交', sourceKey: 'profile.basic.name', value: '匿名', selector: '#save', tagName: 'BUTTON' }] }, { bridge, runIdFactory: () => 'run-blocked' });
  assert.equal(blocked.items[0].status, 'blocked');
  assert.equal(blocked.items[0].reason, '命中禁止操作边界');

  const unknown = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '未知控件', sourceKey: 'profile.basic.name', value: '匿名', selector: '#unknown' }] }, { bridge, runIdFactory: () => 'run-unknown' });
  assert.equal(unknown.items[0].status, 'unsupported');

  const pendingBridge = { ...bridge, async snapshot() { return { snapshotId: 'rerender', url: 'https://example.test/app', fields: [{ ref: 'other', label: '邮箱', selector: '#email', tagName: 'INPUT' }] }; } };
  const pending = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT', snapshotId: 'old' }] }, { bridge: pendingBridge, runIdFactory: () => 'run-pending' });
  assert.equal(pending.items[0].status, 'pending');
  assert.match(pending.items[0].reason, /无唯一/);

  const disconnectedBridge = { ...bridge, async eval() { const error = new Error('bridge disconnected'); error.code = 'BRIDGE_DISCONNECTED'; throw error; } };
  const disconnected = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT', snapshotId: 'old' }] }, { bridge: disconnectedBridge, runIdFactory: () => 'run-disconnected' });
  assert.equal(disconnected.stopReason, 'BRIDGE_DISCONNECTED');
  assert.equal(disconnected.items[0].status, 'blocked');

  const missingSource = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '未知', sourceKey: 'profile.basic.missing', value: 'x', selector: '#missing', tagName: 'INPUT', snapshotId: 'old' }] }, { bridge, runIdFactory: () => 'run-source' });
  assert.equal(missingSource.items[0].status, 'pending');
  assert.match(missingSource.items[0].reason, /sourceKey/);

  const navigatedBridge = { ...bridge, async snapshot() { return { snapshotId: 'nav', url: 'https://example.test/other', fields: [] }; } };
  const navigated = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [] }, { bridge: navigatedBridge, runIdFactory: () => 'run-nav' });
  assert.equal(navigated.stopReason, 'TARGET_CLOSED');

  const mismatch = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '伪造', selector: '#name', tagName: 'INPUT' }] }, { bridge, runIdFactory: () => 'run-mismatch' });
  assert.equal(mismatch.items[0].status, 'pending');
  assert.match(mismatch.items[0].reason, /planned value/);
  // user.* 来源：会话确认或资料派生的复合值必须带 sourceText 说明，缺失即拒绝。
  const userSourced = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '示例选项', sourceKey: 'user.confirmed.choice', sourceText: '用户确认示例选项甲', value: '示例选项甲', selector: '#name', tagName: 'INPUT', snapshotId: 'old' }] }, { bridge, runIdFactory: () => 'run-user-source' });
  assert.equal(userSourced.items[0].status, 'pending', 'user.* 来源也必须与实时现值核对');
  assert.equal(userSourced.items[0].readback, 'failed');
  assert.equal(userSourced.userCheck[0].currentValue, '匿名');
  assert.equal(userSourced.userCheck[0].expectedValue, '示例选项甲');
  assert.equal(userSourced.items[0].sourceText, '用户确认示例选项甲');

  const userSourcedNoNote = await runBatch({ url: 'https://example.test/app', profilePath: md, plannedFields: [{ label: '示例选项', sourceKey: 'user.confirmed.choice', value: '示例选项甲', selector: '#name', tagName: 'INPUT', snapshotId: 'old' }] }, { bridge, runIdFactory: () => 'run-user-source-no-note' });
  assert.equal(userSourcedNoNote.items[0].status, 'pending');
  assert.match(userSourcedNoNote.items[0].reason, /sourceText/);

  fs.rmSync(temp, { recursive: true, force: true });
  console.log('PASS jobfill batch runtime profile validation, tab reuse, rebinding, no-submit guard and readback');
})().catch((error) => { console.error(error); process.exitCode = 1; });
