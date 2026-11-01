'use strict';
const assert = require('node:assert/strict');
const { createHuashuBridge, bridgeError, unwrapReply, HuashuBridgeError } = require('../tools/huashu-bridge.js');

(async () => {
  const calls = [];
  const bridge = createHuashuBridge({
    request(method, args) { calls.push({ method, args }); return { ok: true, data: method === 'snapshot' ? '{"snapshotId":"s1","url":"https://example.test/app"}' : { method } }; },
    connectionMetadata: { client: 'test', sessionId: 'jobfill:test', token: 'must-not-appear' }
  });
  assert.deepEqual(await bridge.tabs({ action: 'list' }), { method: 'tabs' });
  assert.deepEqual(await bridge.snapshot({ tabId: 7 }), { snapshotId: 's1', url: 'https://example.test/app' });
  assert.deepEqual(await bridge.type({ tabId: 7, selector: '#name', text: '匿名', real: true }), { method: 'type' });
  assert.equal(calls[1].args.tabId, 7);
  await assert.rejects(() => bridge.eval({ expr: '1' }), (e) => e.code === 'NO_TAB');
  assert.throws(() => unwrapReply({ ok: false, error: { code: 'NO_EXTENSION', message: 'token=secret' } }), (e) => e.code === 'NO_EXTENSION' && !e.message.includes('secret'));
  const converted = bridgeError({ code: 'TAB_CLOSED', message: 'tab closed token=secret' });
  assert.equal(converted.code, 'TAB_CLOSED');
  assert.equal(converted.message.includes('secret'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(bridge.connectionMetadata, 'token'), false);
  bridge.close();
  await assert.rejects(() => bridge.tabs({ action: 'list' }), HuashuBridgeError);
  console.log('huashu-bridge tests: ok');
})();
