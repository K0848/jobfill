const assert = require('node:assert/strict');
const { audit } = require('../tools/jobfill-independent-checker.js');

const profile = { basic: { name: '匿名' }, education: [{ identity: '学校甲', school: '学校甲' }] };
const good = audit({ profile, plannedFields: [{ sourceKey: 'profile.basic.name', value: '匿名' }], report: { runId: 'r', reportVersion: 1, tab: { tabId: 7 }, summary: {}, items: [{ sourceKey: 'profile.basic.name', status: 'attempted', readback: 'matched', currentValueBefore: '', tabId: 7 }], userCheck: [] }, bridgeState: 'injected' });
assert.equal(good.status, 'passed');

const badSource = audit({ profile, plannedFields: [{ sourceKey: 'profile.basic.name', value: '伪造' }], report: { runId: 'r', reportVersion: 1, tab: { tabId: 7 }, summary: {}, items: [], userCheck: [] }, bridgeState: 'injected' });
assert.ok(badSource.findings.some((finding) => finding.code === 'VALUE_MISMATCH'));

const badExisting = audit({ profile, plannedFields: [{ sourceKey: 'profile.basic.name', value: '匿名' }], report: { runId: 'r', reportVersion: 1, tab: { tabId: 7 }, summary: {}, items: [{ sourceKey: 'profile.basic.name', status: 'attempted', readback: 'matched', currentValueBefore: '已有值', tabId: 7 }], userCheck: [] }, bridgeState: 'injected' });
assert.ok(badExisting.findings.some((finding) => finding.code === 'ATTEMPTED_WITHOUT_EMPTY_READBACK'));

const badBridge = audit({ profile, plannedFields: [], report: { runId: 'r', reportVersion: 1, tab: { tabId: 7 }, summary: {}, items: [], userCheck: [] }, bridgeState: 'disconnected' });
assert.ok(badBridge.findings.some((finding) => finding.code === 'BRIDGE_STATE'));
console.log('PASS independent checker source closure, empty-value protection, bridge state and report contract');
