const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tabsFrom, snapshotFrom } = require('../tools/jobfill-batch-cli.js');

const textTabs = tabsFrom({ text: '[11] × 申请页 — https://example.test/app\n[12] 其他 — https://example.test/other' });
assert.deepEqual(textTabs.map(tab => tab.id), [11, 12]);
const textSnapshot = snapshotFrom({ untrusted: true, meta: 'url="https://example.test/app" snapshot="s-text"' });
assert.deepEqual({ url: textSnapshot.url, snapshotId: textSnapshot.snapshotId }, { url: 'https://example.test/app', snapshotId: 's-text' });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobfill-cli-process-'));
const profilePath = path.join(temp, 'profile.md');
const bridgePath = path.join(temp, 'bridge.cjs');
const requestPath = path.join(temp, 'request.json');
fs.writeFileSync(profilePath, ['```json', JSON.stringify({ jobfill: 1, basic: { name: '匿名' }, education: [], work: [], project: [], campus: [], award: [], language: [] }), '```'].join('\n'));
fs.writeFileSync(bridgePath, `let currentValue=process.env.JOBFILL_TEST_VALUE ?? '匿名';
module.exports={
  async tabs(a){ return a.action==='list' ? [{id:11,url:'https://example.test/app'}] : {tabId:11}; },
  async snapshot(){ return {snapshotId:'cli',url:'https://example.test/app',fields:[{ref:'e1',selector:'#name',label:'姓名',tagName:'INPUT',currentValue:''}]}; },
  async fill(a){ if(currentValue) throw new Error('禁止覆盖已有内容'); currentValue=a.fields[0].text; },
  async eval(){ return {value:currentValue}; }
};\n`);
fs.writeFileSync(requestPath, JSON.stringify({ url: 'https://example.test/app', profilePath, plannedFields: [{ label: '姓名', sourceKey: 'profile.basic.name', value: '匿名', selector: '#name', tagName: 'INPUT' }] }));
const runCli = currentValue => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'jobfill-batch-cli.js'), '--request-file', requestPath], { encoding: 'utf8', env: { ...process.env, JOBFILL_BRIDGE_MODULE: bridgePath, JOBFILL_TEST_VALUE: currentValue } });
const result = runCli('匿名');
assert.equal(result.status, 0, result.stderr);
const report = JSON.parse(result.stdout);
assert.equal(report.runId.length > 10, true);
assert.equal(report.items[0].status, 'skipped_existing');
assert.equal(report.items[0].readback, 'matched');
assert.equal(report.items[0].expectedValue, '匿名');
assert.equal(report.items[0].tabId, 11);
assert.equal(report.bridgeState, 'injected');
const conflictingResult = runCli('解析错误的姓名');
assert.equal(conflictingResult.status, 0, conflictingResult.stderr);
const conflictingReport = JSON.parse(conflictingResult.stdout);
assert.equal(conflictingReport.items[0].status, 'pending');
assert.equal(conflictingReport.items[0].readback, 'failed');
assert.equal(conflictingReport.summary.pending, 1);
assert.equal(conflictingReport.summary.skippedExisting, 0);
assert.equal(conflictingReport.userCheck[0].currentValue, '解析错误的姓名');
assert.equal(conflictingReport.userCheck[0].expectedValue, '匿名');
const emptyResult = runCli('');
assert.equal(emptyResult.status, 0, emptyResult.stderr);
const emptyReport = JSON.parse(emptyResult.stdout);
assert.equal(emptyReport.items[0].status, 'attempted');
assert.equal(emptyReport.items[0].readback, 'matched');
assert.equal(emptyReport.items[0].value, '匿名');
assert.equal(emptyReport.items[0].attempts, 1);
fs.rmSync(temp, { recursive: true, force: true });
console.log('PASS CLI subprocess: matching existing value, conflicting existing value, empty-field write and report propagation');
