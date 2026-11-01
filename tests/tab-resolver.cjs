const assert = require('node:assert/strict');
const { normalizeUrl, resolveTargetTab } = require('../tools/tab-resolver.js');

const rules = { ignoreQueryParams: ['utm_source'], ignoreTrailingSlash: true };
assert.equal(normalizeUrl('https://example.test/app/?draft_id=7&utm_source=x', rules), 'https://example.test/app?draft_id=7');
const reused = resolveTargetTab({ requestedUrl: 'https://example.test/app?draft_id=7&utm_source=mail', rules, tabs: [{ id: 9, url: 'https://example.test/app?draft_id=7' }] });
assert.equal(reused.action, 'reuse');
assert.equal(reused.tabId, 9);
const businessDifferent = resolveTargetTab({ requestedUrl: 'https://example.test/app?draft_id=8', rules, tabs: [{ id: 9, url: 'https://example.test/app?draft_id=7' }] });
assert.equal(businessDifferent.action, 'create');
const ambiguous = resolveTargetTab({ requestedUrl: 'https://example.test/app', rules, tabs: [{ id: 1, url: 'https://example.test/app/' }, { id: 2, url: 'https://example.test/app' }] });
assert.equal(ambiguous.action, 'blocked');
for (const key of ['draft_id', 'application_id', 'token']) assert.throws(() => normalizeUrl('https://example.test/app?'+key+'=1', { ignoreQueryParams: [key] }), /只能忽略追踪参数/);
console.log('PASS tab-resolver URL identity, tracking whitelist, ambiguity guard');
