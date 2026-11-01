const assert = require('node:assert/strict');
const vm = require('node:vm');
const { WidgetExecutor, inferKind } = require('../tools/widget-executor.js');

assert.equal(inferKind({ className: 'sd-Select-container-test', moka: true }), 'moka-sd-select');
assert.equal(inferKind({ widgetKind: 'owned-popup-select' }), 'owned-popup-select');
assert.equal(inferKind({ tagName: 'INPUT' }), 'native');
// 同一租户的 Phoenix 变体必须按更具体的结构类名分派，不能都落到标准列表。
assert.equal(inferKind({ className: 'phoenix-select' }), 'phoenix-select');
assert.equal(inferKind({ selector: '#民族 .constant-main-selector-container' }), 'phoenix-constant');
assert.equal(inferKind({ selector: '#籍贯 .area-selector-container' }), 'phoenix-area');
assert.equal(inferKind({ widgetKind: 'phoenix-constant' }), 'phoenix-constant');
assert.equal(inferKind({ controlType: 'phoenix-area' }), 'phoenix-area');
// PrimeNG 控件按标签/选择器自动识别，计划里不必重复声明 widgetKind。
assert.equal(inferKind({ tagName: 'p-dropdown', selector: '#性别 p-dropdown' }), 'primeng-select');
assert.equal(inferKind({ tagName: 'p-radiobutton' }), 'primeng-radio');
assert.equal(inferKind({ selector: '#出生年月 p-calendar' }), 'primeng-date');

const calls = [];
const bridge = {
  async fill(args) { calls.push(['fill', args]); },
  async eval(args) {
    calls.push(['eval', args]);
    new vm.Script(args.expr);
    if (args.expr.includes('const el=document.querySelector') && args.expr.includes('drivers[')) return { value: { result: true, readback: '硕士' } };
    return { value: '硕士' };
  }
};
const executor = new WidgetExecutor({ bridge });

(async () => {
  const native = await executor.executeField(1, { label: '姓名', sourceKey: 'name', ref: 'e1', tagName: 'INPUT', currentValue: '' }, '匿名');
  assert.equal(native.status, 'write_unverified', '没有页面读回证据时不能伪装成成功');

  const typeCalls = [];
  const selectorBridge = {
    async type(args) { typeCalls.push(args); },
    async eval() { return { untrusted: true, text: JSON.stringify('匿名') }; }
  };
  const selectorExecutor = new WidgetExecutor({ bridge: selectorBridge });
  const selectorNative = await selectorExecutor.executeField(1, {
    label: '姓名', sourceKey: 'name', selector: '#name', tagName: 'INPUT', currentValue: ''
  }, '匿名');
  assert.equal(selectorNative.status, 'attempted', '文本化 snapshot 应通过 Huashu type selector 写入并读回');
  assert.equal(typeCalls[0].selector, '#name');
  assert.equal(typeCalls[0].real, true);

  const complexField = {
    label: '学历', sourceKey: 'degree', selector: '#degree', rowSelector: '#degree-row',
    widgetKind: 'moka-sd-select', semanticKey: 'degree', currentValue: ''
  };
  const complex = await executor.executeField(1, complexField, '硕士');
  assert.equal(complex.status, 'attempted');
  assert.equal(calls.filter(([name]) => name === 'eval').length, 3, '两次注入和一次驱动调用；驱动自身返回最终读回值');

  const realCalls = [];
  let realSelected = false;
  const realPopupBridge = {
    async click(args) {
      realCalls.push(['click', args]);
      if (args.selector === '#gender') return;
      if (Number.isFinite(args.x) && Number.isFinite(args.y)) realSelected = true;
    },
    async eval(args) {
      realCalls.push(['eval', args]);
      if (args.expr.includes('__JOBFILL_REAL_POPUP_PROBE__')) {
        return { untrusted: true, text: JSON.stringify({ marker: '__JOBFILL_REAL_POPUP_PROBE__', status: 'ready', text: '是', x: 12, y: 18 }) };
      }
      return { untrusted: true, text: JSON.stringify(realSelected ? '是' : '') };
    }
  };
  const realExecutor = new WidgetExecutor({ bridge: realPopupBridge });
  const realPopup = await realExecutor.executeField(1, {
    label: '是否接受志愿调剂', sourceKey: 'acceptLocationTransfer',
    selector: '#gender', widgetKind: 'owned-popup-select', currentValue: ''
  }, '是');
  assert.equal(realPopup.status, 'attempted', '真实 click 下拉必须以页面读回为成功条件');
  const realClicks = realCalls.filter(([name]) => name === 'click');
  assert.equal(realClicks.length, 2, '真实下拉只需打开和点击唯一选项两次');
  assert.equal(realClicks[0][1].real, true);
  assert.equal(realClicks[1][1].real, true);
  assert.equal(realClicks[1][1].x, 12);

  const ambiguousBridge = {
    async click() {},
    async eval(args) {
      if (args.expr.includes('__JOBFILL_REAL_POPUP_PROBE__')) return { untrusted: true, text: JSON.stringify({ marker: '__JOBFILL_REAL_POPUP_PROBE__', status: 'ambiguous', count: 2 }) };
      return { untrusted: true, text: JSON.stringify('') };
    }
  };
  const ambiguousExecutor = new WidgetExecutor({ bridge: ambiguousBridge });
  const ambiguous = await ambiguousExecutor.executeField(1, {
    label: '是否接受志愿调剂', sourceKey: 'acceptLocationTransfer',
    selector: '#gender', widgetKind: 'owned-popup-select', currentValue: ''
  }, '是');
  assert.equal(ambiguous.status, 'write_unverified', '同名候选不能猜选');

  // PrimeNG（Angular + ui-*）：面板/选项只在打开后渲染，bridge.eval 不等待 Promise，
  // 因此必须用真实 click/type + 同步探测完成，成功只以页面读回为准。
  const primengCalls = [];
  let primengPanelOpen = false;
  let primengSelected = false;
  const primengBridge = {
    async click(args) {
      primengCalls.push(['click', args]);
      if (args.selector === '#gender-dd') { primengPanelOpen = !primengPanelOpen; return; }
      if (Number.isFinite(args.x) && Number.isFinite(args.y)) { primengSelected = true; primengPanelOpen = false; }
    },
    async eval(args) {
      primengCalls.push(['eval', args]);
      new vm.Script(args.expr);
      if (args.expr.includes('li.ui-dropdown-item')) return { untrusted: true, text: JSON.stringify({ status: 'ready', text: '男', x: 11, y: 22 }) };
      if (args.expr.includes('rect.width>0&&rect.height>0')) return { untrusted: true, text: JSON.stringify({ status: primengPanelOpen ? 'open' : 'closed' }) };
      return { untrusted: true, text: JSON.stringify(primengSelected ? '男' : '') };
    }
  };
  const primengExecutor = new WidgetExecutor({ bridge: primengBridge });
  const primengSelect = await primengExecutor.executeField(1, {
    label: '性别', sourceKey: 'gender', selector: '#gender-dd', widgetKind: 'primeng-select', currentValue: ''
  }, '男');
  assert.equal(primengSelect.status, 'attempted', 'PrimeNG 下拉必须以组件读回为成功条件');
  const primengClicks = primengCalls.filter(([name]) => name === 'click');
  assert.equal(primengClicks.length, 2, 'PrimeNG 下拉只需打开和点击唯一选项两次');
  assert.equal(primengClicks[0][1].real, true);
  assert.equal(primengClicks[1][1].x, 11);

  const ambiguousPrimeng = {
    async click() {},
    async eval(args) {
      if (args.expr.includes('li.ui-dropdown-item')) return { untrusted: true, text: JSON.stringify({ status: 'ambiguous', count: 2 }) };
      if (args.expr.includes('rect.width>0&&rect.height>0')) return { untrusted: true, text: JSON.stringify({ status: 'open' }) };
      return { untrusted: true, text: JSON.stringify('') };
    }
  };
  const ambiguousPrimengExecutor = new WidgetExecutor({ bridge: ambiguousPrimeng });
  const ambiguousPrimengField = await ambiguousPrimengExecutor.executeField(1, {
    label: '性别', sourceKey: 'gender', selector: '#gender-dd', widgetKind: 'primeng-select', currentValue: ''
  }, '男');
  assert.equal(ambiguousPrimengField.status, 'write_unverified', '同名候选不能猜选');
  assert.match(ambiguousPrimengField.reason, /候选不唯一/);

  const radioCalls = [];
  let radioChecked = false;
  const radioBridge = {
    async click(args) { radioCalls.push(args); if (args.selector === '#rb-no .ui-radiobutton-box') radioChecked = true; },
    async eval(args) {
      new vm.Script(args.expr);
      if (args.expr.includes('label-mismatch')) return { untrusted: true, text: JSON.stringify({ status: 'ready' }) };
      if (args.expr.includes('ui-radiobutton-label')) return { untrusted: true, text: JSON.stringify(radioChecked ? '否' : '') };
      return { untrusted: true, text: JSON.stringify('') };
    }
  };
  const radioExecutor = new WidgetExecutor({ bridge: radioBridge });
  const primengRadio = await radioExecutor.executeField(1, {
    label: '本科学历是否为专升本', sourceKey: 'user.confirmed.zhuanshengben', selector: '#rb-no', widgetKind: 'primeng-radio', currentValue: ''
  }, '否');
  assert.equal(primengRadio.status, 'attempted', 'PrimeNG 单选必须点选并读回选中项');
  assert.equal(radioCalls[0].selector, '#rb-no .ui-radiobutton-box');
  assert.equal(radioCalls[0].real, true);

  const dateCalls = { type: [], click: [] };
  let datePanelOpen = false;
  const dateBridge = {
    async click(args) { dateCalls.click.push(args); if (args.selector === '#birth-cal .ui-datepicker-trigger') datePanelOpen = !datePanelOpen; },
    async type(args) { dateCalls.type.push(args); },
    async eval(args) {
      new vm.Script(args.expr);
      if (args.expr.includes('ui-datepicker-year')) return { untrusted: true, text: JSON.stringify({ status: 'readable', input: '2001-02-03', year: '2001', month: '02', day: '3' }) };
      if (args.expr.includes('rect.width>0&&rect.height>0')) return { untrusted: true, text: JSON.stringify({ status: datePanelOpen ? 'open' : 'closed' }) };
      return { untrusted: true, text: JSON.stringify('2001-02-03') };
    }
  };
  const dateExecutor = new WidgetExecutor({ bridge: dateBridge });
  const primengDate = await dateExecutor.executeField(1, {
    label: '出生年月', sourceKey: 'birthday', selector: '#birth-cal', widgetKind: 'primeng-date', currentValue: ''
  }, '2001-02-03');
  assert.equal(primengDate.status, 'attempted', 'PrimeNG 日期必须由面板年月与高亮日证明已进入模型');
  assert.equal(dateCalls.type[0].text, '2001-02-03');
  assert.equal(dateCalls.type[0].real, true);
  assert.ok(dateCalls.click.some((args) => args.selector === '#birth-cal .ui-datepicker-trigger'), '必须用真实点击开关日期面板');

  const rejectedDate = {
    async click() {},
    async type() {},
    async eval(args) {
      if (args.expr.includes('ui-datepicker-year')) return { untrusted: true, text: JSON.stringify({ status: 'readable', input: '2001-02-03', year: '1999', month: '01', day: '01' }) };
      if (args.expr.includes('rect.width>0&&rect.height>0')) return { untrusted: true, text: JSON.stringify({ status: 'open' }) };
      return { untrusted: true, text: JSON.stringify('2001-02-03') };
    }
  };
  const rejectedDateExecutor = new WidgetExecutor({ bridge: rejectedDate });
  const rejectedPrimengDate = await rejectedDateExecutor.executeField(1, {
    label: '出生年月', sourceKey: 'birthday', selector: '#birth-cal', widgetKind: 'primeng-date', currentValue: ''
  }, '2001-02-03');
  assert.equal(rejectedPrimengDate.status, 'write_unverified', '模型未接受日期时不能算成功');
  assert.match(rejectedPrimengDate.reason, /日期未进入日期控件模型/);
  const skipped = await executor.executeField(1, { label: '手机号', sourceKey: 'phone', ref: 'e2', tagName: 'INPUT', currentValue: '示例号码甲' }, '示例号码甲');
  assert.equal(skipped.status, 'skipped_existing');
  assert.equal(skipped.readback, 'matched');
  const callsBeforeExistingChecks = calls.length;
  const conflicting = await executor.executeField(1, { label: '手机号', sourceKey: 'phone', ref: 'e2', tagName: 'INPUT', currentValue: '示例号码甲' }, '示例号码乙');
  assert.equal(conflicting.status, 'pending', '已有值与来源不一致时必须报告冲突，不能误报匹配');
  assert.equal(conflicting.readback, 'failed');
  assert.equal(conflicting.action, 'skip');
  assert.equal(conflicting.requiresUserCheck, true);
  assert.equal(conflicting.currentValueBefore, '示例号码甲');
  assert.equal(conflicting.value, '示例号码甲');
  assert.equal(conflicting.expectedValue, '示例号码乙');
  const uncheckable = await executor.executeField(1, { label: '手机号', sourceKey: 'phone', ref: 'e2', tagName: 'INPUT', currentValue: '示例号码甲' }, undefined);
  assert.equal(uncheckable.status, 'pending', '没有确认目标时，非空内容也不能认定正确');
  assert.equal(uncheckable.readback, 'failed');
  assert.equal(uncheckable.value, '示例号码甲');
  assert.equal(calls.length, callsBeforeExistingChecks, '核对已有值时不得写入或触发控件操作');
  console.log('PASS widget-executor 控件检测、注入复用、读回状态和已有值保护');
})().catch(error => { console.error(error); process.exitCode = 1; });
