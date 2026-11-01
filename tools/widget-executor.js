/*
 * Skill-side execution layer.
 *
 * The module deliberately knows nothing about a particular MCP client.  Pass a
 * bridge whose methods accept the Huashu argument objects (eval/fill/select/
 * click/type/read).  This keeps the decision layer testable without a browser while
 * still allowing the skill to call mcp__huashu_chrome_* directly.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RETRIES = 2;
const COMPLEX_KINDS = new Set([
  'moka-sd-select', 'moka-month-pair', 'owned-popup-select', 'feishu-date-range',
  'phoenix-select', 'phoenix-date', 'phoenix-constant', 'phoenix-area',
  'phoenix-radio', 'aria-radio', 'feishu-radio', 'jd-profession',
  'primeng-select', 'primeng-radio', 'primeng-date'
]);

class BridgeDisconnectedError extends Error {
  constructor(message = 'Huashu Chrome bridge 已断开，整单停止', code = 'BRIDGE_DISCONNECTED') {
    super(message);
    this.name = 'BridgeDisconnectedError';
    this.code = code;
  }
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[\s*＊：:()（）·、]/g, '');
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'object') return Object.values(value).every(isBlank);
  return !String(value).trim() || /^(请选择(?:.{0,12})?|未选择|选择|please select|select an option|--+)$/i.test(String(value).trim());
}

function matchesValue(expected, actual, field = {}) {
  if (actual === undefined || actual === null) return false;
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && typeof actual === 'string' && 'start' in expected && 'end' in expected) {
    const parts = actual.split(/\s*\/\s*/);
    return parts.length === 2 && normalize(parts[0]) === normalize(expected.start) && normalize(parts[1]) === normalize(expected.end);
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => matchesValue(value, actual[index], field));
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false;
    return Object.keys(expected).every(key => matchesValue(expected[key], actual[key], field));
  }
  if (typeof field.optionMatches === 'function') return field.optionMatches(expected, actual);
  return normalize(expected) === normalize(actual);
}

function inferKind(field = {}) {
  if (field.widgetKind && COMPLEX_KINDS.has(field.widgetKind)) return field.widgetKind;
  if (field.mokaMonthPair || field.controlType === 'moka-month-pair') return 'moka-month-pair';
  if (field.moka || field.selectDriver === 'moka' || /sd-Select|sd-Dropdown|moka/i.test(String(field.className || field.selector || ''))) return 'moka-sd-select';
  if (field.feishuDateRange || field.controlType === 'feishu-date-range') return 'feishu-date-range';
  if (field.feishu || /ud__select|throne-biz/i.test(String(field.className || field.selector || ''))) return field.controlType || 'owned-popup-select';
  // PrimeNG（Angular + ui-* 类）的下拉、单选、日期都用组件自身模型保存选中值：
  // 下拉面板只在打开后渲染选项，所以这三类必须走专用驱动，不能当原生 input 处理。
  {
    const tag = String(field.tagName || field.elementTag || '').toLowerCase();
    const structural = `${tag} ${field.className || ''} ${field.selector || ''} ${field.css || ''}`;
    if (tag === 'p-dropdown' || /p-dropdown|ui-dropdown/i.test(structural)) return 'primeng-select';
    if (tag === 'p-radiobutton' || /p-radiobutton/i.test(structural)) return 'primeng-radio';
    if (tag === 'p-calendar' || /p-calendar/i.test(structural)) return 'primeng-date';
  }
  // 同一租户的 Phoenix 下拉有标准列表、ConstantSelector、地区级联三种变体；结构类名
  // 比通用 phoenix-select 更具体，必须先判定，否则会被当成标准列表而找不到弹层。
  if (/constant-main-selector-container/i.test(String(field.className || field.selector || ''))) return 'phoenix-constant';
  if (/area-selector-container/i.test(String(field.className || field.selector || ''))) return 'phoenix-area';
  if (field.phoenix || /phoenix-select|phoenix-date|phoenix-radio/i.test(String(field.className || field.selector || ''))) return field.controlType || 'phoenix-select';
  if (field.controlType && COMPLEX_KINDS.has(field.controlType)) return field.controlType;
  return 'native';
}

function bridgeError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return ['NO_EXTENSION', 'TAB_CLOSED', 'TARGET_CLOSED', 'SESSION_LOST', 'BRIDGE_DISCONNECTED', 'BRIDGE_UNAVAILABLE', 'PERMISSION_DENIED'].includes(String(error?.code || '').toUpperCase())
    || /bridge|tab.*closed|target.*closed|not connected|disconnected|no controlled tab|session.*lost|no extension|permission denied/.test(text);
}

function callBridge(bridge, name, args) {
  if (!bridge || typeof bridge[name] !== 'function') throw new TypeError(`Huashu bridge 缺少 ${name}() 方法`);
  try {
    return Promise.resolve(bridge[name](args));
  } catch (error) {
    return Promise.reject(error);
  }
}

function extractBridgeValue(result) {
  if (result === null || result === undefined) return result;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  if (Object.prototype.hasOwnProperty.call(result, 'result')) return result.result;
  if (result.structuredContent && Object.prototype.hasOwnProperty.call(result.structuredContent, 'value')) return result.structuredContent.value;
  // Huashu 的真实 bridge 返回 `{untrusted, text}`，MCP 包装层则返回
  // `content[].text`；两种都要先解析，否则真实页面的 eval 读回会被
  // 当成未解析对象，复杂控件永远只能得到 write_unverified。
  const text = typeof result.text === 'string'
    ? result.text
    : result.content?.find?.(item => item.type === 'text')?.text;
  if (!text) return result;
  const page = text.match(/<page-content[^>]*>\s*([\s\S]*?)\s*<\/page-content>/i)?.[1]?.trim() || text.trim();
  try { return JSON.parse(page); } catch { return page; }
}

function asEvalExpression(source) {
  const text = String(source || '').trim();
  // Huashu eval accepts one JavaScript expression.  The retained browser
  // modules are IIFEs with a trailing statement semicolon, so remove only
  // that final delimiter before injecting them.
  return text.endsWith(';') ? text.slice(0, -1) : text;
}

function readBackScript(field) {
  const selector = JSON.stringify(field.selector || field.css || '');
  const kind = JSON.stringify(inferKind(field));
  return `(function(){
    const el=document.querySelector(${selector});
    if(!el) return undefined;
    const kind=${kind};
    const text=(node)=>String(node?.textContent||'').trim();
    if(kind==='moka-sd-select'||kind==='moka-month-pair') return Array.from(el.querySelectorAll('[class*=display-value]')).map(text).filter(Boolean).join(kind==='moka-month-pair'?'-':' / ');
    if(kind==='owned-popup-select'||kind==='feishu-date-range') {
      if(kind==='feishu-date-range') return Array.from(el.querySelectorAll('input')).map(input=>input.value).filter(Boolean).join(' / ');
      const content=el.querySelector('.ud__select__selector__content');
      if(content){ const clone=content.cloneNode(true); clone.querySelectorAll('input,.ud__select__selector__placeholder,.ud__select__selector__search__input_container').forEach(n=>n.remove()); return text(clone); }
    }
    if(kind==='phoenix-select'||kind==='phoenix-date'||kind==='phoenix-constant'||kind==='phoenix-area') {
      const tip=text(el.querySelector('.phoenix-select__tipWrapper--visible .phoenix-select__tipEle,.phoenix-select__tipEle'));
      // 多选（如期望工作城市）把已选项渲染成标签，没有单个 tipEle。
      return tip || Array.from(el.querySelectorAll('.phoenix-select__tag')).map(text).filter(Boolean).join(' / ');
    }
    if(kind==='phoenix-radio') return text(el.querySelector('.phoenix-radio--checked .phoenix-radio__radio-text'));
    if(kind==='aria-radio') return text(el.querySelector('[role=radio][aria-checked=true]'));
    if(kind==='feishu-radio') { const checked=el.querySelector('input[type=radio]:checked'); return text(checked?.labels?.[0]) || checked?.value || ''; }
    if(kind==='primeng-select'){ const t=String(el.querySelector('.ui-dropdown-label')?.textContent||'').trim(); return (!t||/请选择/.test(t)||/^选择/.test(t)||/^-+$/.test(t))?'':t; }
    if(kind==='primeng-radio') return el.querySelector('input[type=radio]:checked')?String(el.querySelector('.ui-radiobutton-label')?.textContent||'').trim():'';
    if(kind==='primeng-date') return String(el.querySelector('input')?.value ?? '');
    if(el.tagName==='SELECT') return el.selectedOptions[0]?.textContent?.trim() || el.value;
    if(el.type==='radio') return text(el.closest('label')) || el.value;
    return el.value ?? text(el);
  })()`;
}

function driverScript(field, value, driverName) {
  const selector = JSON.stringify(field.selector || field.css || '');
  const rowSelector = JSON.stringify(field.rowSelector || field.rowCss || '');
  const label = JSON.stringify(field.label || '');
  const semanticKey = JSON.stringify(field.semanticKey || field.sourceKey || '');
  const valueLiteral = JSON.stringify(value);
  const rangeValues = JSON.stringify(field.rangeValues || (value && typeof value === 'object' ? value : null));
  const driver = JSON.stringify(driverName);
  const kind = JSON.stringify(inferKind(field));
  return `(async()=>{
    const el=document.querySelector(${selector});
    if(!el) throw new Error('执行字段未找到: '+${selector});
    const row=document.querySelector(${rowSelector})||el.closest('[class*=fieldItem],.form-item,.info_box,.apply-field,.ud-formily-item')||el;
    const norm=s=>String(s??'').toLowerCase().replace(/[\\s*＊：:()（）·、]/g,'');
    const blank=v=>!String(v??'').trim()||/^(请选择|未选择|选择|please select|select an option|--+)$/i.test(String(v??'').trim());
    const visible=node=>!!node&&node.isConnected&&node.getBoundingClientRect().width>=0&&node.getBoundingClientRect().height>=0&&getComputedStyle(node).display!=='none';
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const read=field=>{ const root=field.el; const text=n=>String(n?.textContent||'').trim(); const k=${kind};
      if(k==='moka-sd-select'||k==='moka-month-pair') return Array.from(root.querySelectorAll('[class*=display-value]')).map(text).filter(Boolean).join(k==='moka-month-pair'?'-':' / ');
      if(k==='owned-popup-select'){ const c=root.querySelector('.ud__select__selector__content'); if(c){const x=c.cloneNode(true);x.querySelectorAll('input,.ud__select__selector__placeholder,.ud__select__selector__search__input_container').forEach(n=>n.remove());return text(x);} return root.querySelector('input[readonly],textarea')?.value||''; }
      if(k==='feishu-date-range') return Array.from(root.querySelectorAll('input')).map(x=>x.value).filter(Boolean).join(' / ');
      if(k==='phoenix-select'||k==='phoenix-date'||k==='phoenix-constant'||k==='phoenix-area'){ const tip=text(root.querySelector('.phoenix-select__tipWrapper--visible .phoenix-select__tipEle,.phoenix-select__tipEle')); return tip||Array.from(root.querySelectorAll('.phoenix-select__tag')).map(text).filter(Boolean).join(' / '); }
      if(k==='phoenix-radio') return text(root.querySelector('.phoenix-radio--checked .phoenix-radio__radio-text'));
      if(k==='aria-radio') return text(root.querySelector('[role=radio][aria-checked=true]'));
      if(k==='feishu-radio'){const checked=root.querySelector('input[type=radio]:checked');return text(checked?.labels?.[0])||checked?.value||'';}
      if(k==='primeng-select'){ const t=String(root.querySelector('.ui-dropdown-label')?.textContent||'').trim(); return (!t||/请选择/.test(t)||/^选择/.test(t)||/^-+$/.test(t))?'':t; }
      if(k==='primeng-radio') return root.querySelector('input[type=radio]:checked')?String(root.querySelector('.ui-radiobutton-label')?.textContent||'').trim():'';
      if(k==='primeng-date') return String(root.querySelector('input')?.value ?? '');
      if(root.tagName==='SELECT') return root.selectedOptions[0]?.textContent?.trim()||root.value;
      return root.value??text(root);
    };
    const writeNative=(node,value)=>{const proto=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(node,String(value));else node.value=String(value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));node.dispatchEvent(new Event('blur',{bubbles:true}));};
    const dateValue=(value)=>String(value??'');
    const editable=field=>!!field.el&&!field.el.disabled&&!field.el.readOnly;
    const radios=node=>Array.from((node.form||node.ownerDocument).querySelectorAll('input[type=radio]')).filter(x=>x.form===node.form&&(!node.name||x.name===node.name));
    const optionMatches=(field,expected,actual)=>globalThis.JobfillSemanticMapper.optionMatches(${semanticKey}||field.semanticKey||${label},expected,actual);
    const ctx={norm,blank,visible,pause,read,writeNative,dateValue,editable,radios,optionMatches,refreshMokaField:field=>field,mokaIdentity:()=>${label}};
    const drivers=globalThis.JobfillWidgetDrivers.create(ctx);
    const field={el,row,label:${label},semanticKey:${semanticKey},widgetKind:${kind},custom:${kind==='moka-sd-select'},mokaMonthPair:${kind==='moka-month-pair'},dateControl:${kind==='phoenix-date'},rangeValues:${rangeValues},parts:Array.from(row.querySelectorAll('input[type=radio]')),selectParts:Array.from(el.querySelectorAll('[class*=sd-Select-container-],[class*=sd-Dropdown-container-]'))};
    const result=await drivers[${driver}](field,${valueLiteral});
    return {result,readback:read(field)};
  })()`;
}

class WidgetExecutor {
  constructor({ bridge, extensionDir = path.join(__dirname, '..', 'extension'), maxRetries = DEFAULT_RETRIES, logger = () => {} } = {}) {
    if (!bridge) throw new TypeError('WidgetExecutor 需要 Huashu bridge');
    this.bridge = bridge;
    this.extensionDir = extensionDir;
    this.maxRetries = maxRetries;
    this.logger = logger;
    this.injectedTabs = new Set();
  }

  async ensureInjected(tabId) {
    if (this.injectedTabs.has(tabId)) {
      try {
        const probe = await callBridge(this.bridge, 'eval', { tabId, expr: '({semanticVersion:globalThis.JobfillSemanticMapper?.version||null,widgetVersion:globalThis.JobfillWidgetDrivers?.version||null})' });
        const value = extractBridgeValue(probe);
        if (value?.semanticVersion === 5 && value?.widgetVersion === 9) return;
      } catch (error) {
        if (bridgeError(error)) throw new BridgeDisconnectedError(error.message, error?.code || 'BRIDGE_DISCONNECTED');
      }
      this.injectedTabs.delete(tabId);
    }
    try {
      await callBridge(this.bridge, 'eval', { tabId, expr: asEvalExpression(fs.readFileSync(path.join(this.extensionDir, 'semantic-mapper.js'), 'utf8')) });
      await callBridge(this.bridge, 'eval', { tabId, expr: asEvalExpression(fs.readFileSync(path.join(this.extensionDir, 'widget-drivers.js'), 'utf8')) });
      this.injectedTabs.add(tabId);
    } catch (error) {
      if (bridgeError(error)) throw new BridgeDisconnectedError(error.message, error?.code || 'BRIDGE_DISCONNECTED');
      throw error;
    }
  }

  async readBack(tabId, field, fallback) {
    if (typeof this.bridge.readBack === 'function') return this.bridge.readBack({ tabId, field });
    if (typeof fallback !== 'undefined') return fallback;
    if (!field.selector && !field.css) return field.readback;
    const result = await callBridge(this.bridge, 'eval', { tabId, expr: readBackScript(field) });
    return extractBridgeValue(result);
  }

  async executeNative(tabId, field, value) {
    const kind = String(field.tagName || field.elementTag || '').toUpperCase();
    if (kind === 'SELECT' || field.controlType === 'native-select') {
      await callBridge(this.bridge, 'select', { tabId, snapshotId: field.snapshotId, ref: field.ref, value: String(value) });
    } else if (field.controlType === 'radio' || field.type === 'radio' || field.role === 'radio') {
      await callBridge(this.bridge, 'click', { tabId, snapshotId: field.snapshotId, ref: field.ref, find: field.find });
    } else if (!field.ref && (field.selector || field.css) && typeof this.bridge.type === 'function') {
      // 文本化 snapshot 没有可复用的 eN ref 时，交给 Huashu 的真实 type
      // 原语按 selector 输入；不退回 eval 直写 value，避免绕过 React 状态。
      await callBridge(this.bridge, 'type', { tabId, snapshotId: field.snapshotId, selector: field.selector || field.css, text: String(value), clear: true, real: true });
    } else {
      await callBridge(this.bridge, 'fill', { tabId, snapshotId: field.snapshotId, fields: [{ ref: field.ref, text: String(value) }], submit: false });
    }
    return this.readBack(tabId, field);
  }

  /*
   * 飞书的 portal 下拉必须经过真实浏览器事件才能让 React 内部状态提交。
   * 页面内 driverScript 只能派发 isTrusted=false 的合成事件，因此这里把
   * Huashu 的真实 click 保留在 Runtime 内部：打开控件后只用 eval 做只读的
   * 可见选项探测，再用坐标 click 完成真正选择，最后统一走页面读回。
   */
  async executeRealOwnedPopup(tabId, field, value) {
    if (typeof this.bridge.click !== 'function') throw new Error('Huashu bridge 不支持真实 click');
    // 移动日期滚轮没有输入框，通过组件公开触摸事件并核对选中值，不能仅改 DOM transform。
    if (field.mobileDate === true) return this.executeMobileDate(tabId, field, value);
    // 级联字段每一级按来源声明的路径唯一匹配，只有叶子 radio 可以提交。
    if (field.optionPath !== undefined) {
      if (!Array.isArray(field.optionPath) || field.optionPath.length < 1 || field.optionPath.length > 5 || field.optionPath.some(v=>typeof v!=='string'||!v.trim())) throw new Error('级联选项路径无效');
      for (let i=0;i<field.optionPath.length;i++) await this.executeRealOwnedPopup(tabId, { ...field, optionPath: undefined, mobileNavigate: i<field.optionPath.length-1 }, field.optionPath[i]);
      return this.readBack(tabId, field);
    }
    const selector = field.selector || field.css;
    if (!selector) throw new Error('复杂下拉缺少稳定 selector');
    // 华星移动端的单选弹层要独立确认；恢复未完成弹层时不要重复打开。
    const mobilePopup = () => callBridge(this.bridge, 'eval', { tabId, expr: `(()=>{const n=document.querySelector('.mc-select-popup');return !!n&&n.getBoundingClientRect().height>0})()` });
    const searchOpen = field.popupAlreadyOpenSelector ? extractBridgeValue(await callBridge(this.bridge, 'eval', { tabId, expr: `(()=>{const n=document.querySelector(${JSON.stringify(field.popupAlreadyOpenSelector)});return !!n&&n.getBoundingClientRect().height>0})()` })) === true : false;
    if (extractBridgeValue(await mobilePopup()) !== true && !searchOpen) await callBridge(this.bridge, 'click', { tabId, selector, real: true });
    if (field.searchInputSelector) {
      if (typeof field.searchValue !== 'string' || !field.searchValue.trim()) throw new Error('搜索选择缺少确认的搜索值');
      await callBridge(this.bridge,'type',{tabId,selector:field.searchInputSelector,text:field.searchValue,clear:true,real:true});
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    if (extractBridgeValue(await mobilePopup()) === true) await new Promise(resolve => setTimeout(resolve, 350));
    const expected = JSON.stringify(String(value));
    const rowSelector = JSON.stringify(field.rowSelector || field.rowCss || selector);
    const targetSelector = JSON.stringify(selector);
    const probe = `(()=>{
      const expected=${expected};
      const norm=s=>String(s??'').toLowerCase().replace(/[\\s*＊：:()（）·、]/g,'');
      const visible=node=>{if(!node||!node.isConnected)return false;const r=node.getBoundingClientRect();const c=getComputedStyle(node);return r.width>0&&r.height>0&&r.bottom>=0&&r.top<=Math.max(innerHeight,document.documentElement.clientHeight)&&c.display!=='none'&&c.visibility!=='hidden'&&Number(c.opacity)>=0.02;};
      const row=document.querySelector(${rowSelector})||document.querySelector(${targetSelector});
      const selectors='[role="option"],.ud__select__list__item,li,[data-value],button,[class*="option"],[class*="Option"],[class*="item"],[class*="Item"]';
      const mobile=document.querySelector('.mc-select-popup');
      // 隔离世界的 innerHeight 可能与实际标签视口不同；移动弹层由尺寸/样式证明展开。
      const mobileOpen=mobile&&mobile.getBoundingClientRect().height>0&&getComputedStyle(mobile).visibility!=='hidden'&&getComputedStyle(mobile).display!=='none';
      const candidates=mobileOpen?mobile.querySelectorAll('.mc-select-list .am-list-item'):document.querySelectorAll(selectors);
      const matches=Array.from(candidates).filter(node=>(mobileOpen?node.getBoundingClientRect().height>0:visible(node))&&(!row||!row.contains(node))&&norm(node.textContent)===norm(expected));
      if(matches.length===1){const r=matches[0].getBoundingClientRect();return {marker:'__JOBFILL_REAL_POPUP_PROBE__',status:'ready',text:String(matches[0].textContent||'').trim(),selected:!!matches[0].querySelector('input[type=radio]:checked'),mobileIndex:mobileOpen?Array.from(candidates).indexOf(matches[0])+1:null,x:r.left+r.width/2,y:r.top+r.height/2};}
      if(matches.length>1)return {marker:'__JOBFILL_REAL_POPUP_PROBE__',status:'ambiguous',count:matches.length};
      return {marker:'__JOBFILL_REAL_POPUP_PROBE__',status:'missing'};
    })()`;
    let result;
    const probeDeadline = Date.now() + 1600;
    while (Date.now() < probeDeadline) {
      result = extractBridgeValue(await callBridge(this.bridge, 'eval', { tabId, expr: probe }));
      if (result?.status === 'ready' || result?.status === 'ambiguous') break;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    if (!result || result.marker !== '__JOBFILL_REAL_POPUP_PROBE__' || result.status !== 'ready') {
      const reason = result?.status === 'ambiguous' ? `弹层存在 ${result.count} 个同名候选` : '未找到唯一可见选项';
      throw new Error(`真实下拉选择失败：${reason}`);
    }
    // 长列表必须按唯一节点点击，由浏览器滚动定位；弹层动画及裁剪会使行坐标落到别项。
    if (result.selected === true) {
      // 恢复已有暂选值，重复点击会被该控件反选。
    } else if (Number.isInteger(result.mobileIndex) && result.mobileIndex > 0) {
      await callBridge(this.bridge, 'click', { tabId, selector: `.mc-select-popup .mc-select-list .am-list-body > .am-list-item:nth-child(${result.mobileIndex})${field.mobileNavigate ? ' .am-list-content' : ' input[type=radio]'}`, real: true });
    } else await callBridge(this.bridge, 'click', { tabId, x: result.x, y: result.y, real: true });
    if (field.mobileNavigate) return undefined;
    // 仅在已选 radio 与目标一致的 mc-select 弹层内确认，禁止触及页面保存或协议。
    if (extractBridgeValue(await mobilePopup()) === true) {
      const commit = extractBridgeValue(await callBridge(this.bridge, 'eval', { tabId, expr: `(()=>{
        const popup=document.querySelector('.mc-select-popup');
        const rows=Array.from(popup.querySelectorAll('.mc-select-list .am-list-item'));
        const selected=rows.filter(n=>n.querySelector('input[type=radio]:checked'));
        const norm=s=>String(s??'').replace(/\\s/g,'');
        if(selected.length!==1||norm(selected[0].textContent)!==norm(${expected}))return {status:'selection-mismatch'};
        const buttons=Array.from(popup.querySelectorAll('.am-picker-popup-header-right')).filter(n=>n.textContent.trim()==='确定');
        if(buttons.length!==1)return {status:'missing-confirm'};
        const r=buttons[0].getBoundingClientRect();return {status:'ready',x:r.left+r.width/2,y:r.top+r.height/2};
      })()` }));
      if(commit?.status!=='ready')throw new Error('移动单选弹层未确认唯一目标选项');
      await callBridge(this.bridge, 'click', { tabId, x: commit.x, y: commit.y, real: true });
    }
    const deadline = Date.now() + 1600;
    let readback;
    while (Date.now() < deadline) {
      readback = await this.readBack(tabId, field);
      if (matchesValue(value, readback, field)) return readback;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    return readback;
  }

  /*
   * PrimeNG（Angular + ui-* 类）的下拉、单选、日期与飞书 portal 下拉同类：面板和选项只在
   * 打开后渲染。bridge.eval 不会等待页面返回的 Promise，页面侧异步驱动在这里只能拿到空
   * 对象，所以这些控件保留 Huashu 的真实 click/type 原语，只用同步 eval 做只读探测与读回。
   */
  async executeMobileDate(tabId, field, value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error('移动日期格式无效');
    const target = String(value).split('-').map(Number);
    const probe = async () => extractBridgeValue(await callBridge(this.bridge, 'eval', {tabId,expr:`(()=>{
      const popup=document.querySelector('.am-picker-popup');if(!popup||!popup.getBoundingClientRect().height)return null;
      return Array.from(popup.querySelectorAll('.am-picker-col')).map(col=>{
        const selected=col.querySelector('.am-picker-col-item-selected');const r=col.getBoundingClientRect();
        return {value:parseInt(selected?.textContent),height:selected?.getBoundingClientRect().height,x:r.left+r.width/2,y:r.top+r.height/2};
      });
    })()`}));
    if (!await probe()) await callBridge(this.bridge,'click',{tabId,selector:field.selector||field.css,real:true});
    await new Promise(resolve=>setTimeout(resolve,350));
    for(let column=0;column<3;column++) {
      for(let step=0;step<40;step++) {
        const state=await probe();if(!Array.isArray(state)||state.length!==3)throw new Error('日期滚轮结构不唯一');
        const cur=state[column];if(cur.value===target[column])break;
        const diff=target[column]-cur.value;
        if(!Number.isFinite(diff)||!cur.height)throw new Error('日期滚轮不可读');
        // 组件只在吸附动画完成时提交选中值；偏离格点少量像素触发吸附，避免只移动外观。
        const delta=Math.sign(diff)*(Math.min(Math.abs(diff),4)*cur.height+0.5);
        const touchExpr=(phase,y)=>`(()=>{const col=document.querySelectorAll('.am-picker-popup .am-picker-col')[${column}];const t=new Touch({identifier:1,target:col,clientX:${cur.x},clientY:${y},pageX:${cur.x},pageY:${y}});col.dispatchEvent(new TouchEvent(${JSON.stringify(phase)},{bubbles:true,cancelable:true,touches:${phase==='touchend'?'[]':'[t]'},targetTouches:${phase==='touchend'?'[]':'[t]'},changedTouches:[t]}));return true})()`;
        await callBridge(this.bridge,'eval',{tabId,expr:touchExpr('touchstart',cur.y)});
        await callBridge(this.bridge,'eval',{tabId,expr:touchExpr('touchmove',cur.y-delta)});
        // 手势持续超过惯性阈值，防止结束后惯性滚动越过所需日期。
        await new Promise(resolve=>setTimeout(resolve,350));
        await callBridge(this.bridge,'eval',{tabId,expr:touchExpr('touchend',cur.y-delta)});
        // 后台标签的组件动画定时器会被 Chrome 限流，轮询实际选中值而非按动画时长猜完成。
        const deadline=Date.now()+4000;let changed=false;
        do {const next=await probe();if(next?.[column]?.value!==cur.value){changed=true;break;}await new Promise(resolve=>setTimeout(resolve,200));}while(Date.now()<deadline);
        if(!changed)throw new Error('触摸手势未改变日期滚轮');
      }
    }
    const selected=await probe();if(!selected||selected.some((v,i)=>v.value!==target[i]))throw new Error('日期滚轮选中值与目标不一致');
    await callBridge(this.bridge,'click',{tabId,selector:'.am-picker-popup .am-picker-popup-header-right',real:true});
    await new Promise(resolve=>setTimeout(resolve,350));
    return this.readBack(tabId,field);
  }

  primengProbe(selector, inner) {
    return `(()=>{const root=document.querySelector(${JSON.stringify(selector)});if(!root)return {status:'missing-root'};${inner}})()`;
  }

  async primengReadState(tabId, selector, panelSelector) {
    const expr = this.primengProbe(selector, `const panel=root.querySelector(${JSON.stringify(panelSelector)});if(!panel)return {status:'missing-panel'};const rect=panel.getBoundingClientRect();return {status:(rect.width>0&&rect.height>0)?'open':'closed'};`);
    return extractBridgeValue(await callBridge(this.bridge, 'eval', { tabId, expr }));
  }

  async openPrimengPopup(tabId, field, { panelSelector, triggerSelector }) {
    const selector = field.selector || field.css;
    if (!selector) throw new Error('PrimeNG 控件缺少稳定 selector');
    if ((await this.primengReadState(tabId, selector, panelSelector))?.status === 'open') return;
    await callBridge(this.bridge, 'click', { tabId, selector: triggerSelector || selector, real: true });
    const deadline = Date.now() + 1500;
    do {
      if ((await this.primengReadState(tabId, selector, panelSelector))?.status === 'open') return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    } while (Date.now() < deadline);
    throw new Error('PrimeNG 选项面板未打开，请手动选择');
  }

  async closePrimengPopup(tabId, field, { panelSelector, triggerSelector }) {
    const selector = field.selector || field.css;
    if ((await this.primengReadState(tabId, selector, panelSelector))?.status !== 'open') return;
    await callBridge(this.bridge, 'click', { tabId, selector: triggerSelector, real: true });
    // 面板收起有动画；立刻操作下一个字段会被 Huashu 的遮挡检查拦下，因此先等它真的不可见。
    const deadline = Date.now() + 1200;
    do {
      if ((await this.primengReadState(tabId, selector, panelSelector))?.status !== 'open') return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    } while (Date.now() < deadline);
    // 面板未按时收起不推翻已核实的日期值，只记录警告并交回用户复核。
    this.logger({ field, error: new Error('PrimeNG 面板未在预期时间内关闭') });
  }

  async executePrimengSelect(tabId, field, value) {
    const selector = field.selector || field.css;
    await this.openPrimengPopup(tabId, field, { panelSelector: '.ui-dropdown-panel', triggerSelector: selector });
    // 候选项可能是单行（男/汉族），也可能是「号码 + 名称」两列（+86 中国）；
    // 逐段比较才能避免把 "+86" 误配到 "+618" 这类只在前缀相同的选项。
    const expr = this.primengProbe(selector, `
      const panel=root.querySelector('.ui-dropdown-panel');
      if(!panel)return {status:'missing-panel'};
      const norm=s=>String(s??'').toLowerCase().replace(/[\\s*＊：:()（）·、]/g,'');
      const visible=n=>{if(!n||!n.isConnected)return false;const r=n.getBoundingClientRect();const c=getComputedStyle(n);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden';};
      const items=Array.from(panel.querySelectorAll('li.ui-dropdown-item')).filter(n=>visible(n)&&!/ui-state-disabled/.test(String(n.className))&&!n.hasAttribute('aria-disabled'));
      const segments=n=>[n.textContent,...Array.from(n.children).map(c=>c.textContent)].map(t=>norm(t)).filter(Boolean);
      const target=norm(${JSON.stringify(String(value))});
      const matches=items.filter(n=>segments(n).some(s=>s===target));
      if(matches.length===1){const r=matches[0].getBoundingClientRect();return {status:'ready',text:String(matches[0].textContent||'').trim(),x:r.left+r.width/2,y:r.top+r.height/2};}
      return {status:matches.length?'ambiguous':'missing',count:matches.length,options:items.map(n=>String(n.textContent||'').trim()).slice(0,40)};
    `);
    const probe = extractBridgeValue(await callBridge(this.bridge, 'eval', { tabId, expr }));
    const status = probe?.status ?? 'unknown';
    if (status !== 'ready') throw new Error(status === 'ambiguous' ? `PrimeNG 候选不唯一（${probe.count} 项），请手动选择` : `PrimeNG 候选项中无「${value}」，请手动选择`);
    await callBridge(this.bridge, 'click', { tabId, x: probe.x, y: probe.y, real: true });
    return this.readBack(tabId, field);
  }

  async executePrimengRadio(tabId, field, value) {
    const selector = field.selector || field.css;
    const expr = this.primengProbe(selector, `
      const own=root.querySelector('input[type=radio]');
      const label=root.querySelector('.ui-radiobutton-label');
      if(!own||!label)return {status:'missing-structure'};
      const norm=s=>String(s??'').toLowerCase().replace(/[\\s*＊：:()（）·、]/g,'');
      if(norm(label.textContent)!==norm(${JSON.stringify(String(value))}))return {status:'label-mismatch',label:String(label.textContent||'').trim()};
      const group=Array.from((own.form||own.ownerDocument).querySelectorAll('p-radiobutton')).filter(n=>n.querySelector('input[type=radio][name="'+own.name+'"]'));
      if(group.length<2)return {status:'group-incomplete'};
      if(group.some(n=>n.querySelector('input[type=radio]').checked))return {status:'already-selected'};
      return {status:'ready'};
    `);
    const probe = extractBridgeValue(await callBridge(this.bridge, 'eval', { tabId, expr }));
    // 组内已有选择时绝不覆盖，交回用户复核（正常路径已由写入前的读回拦住）。
    if (probe?.status !== 'ready') throw new Error(`PrimeNG 单选未就绪（${probe?.status ?? 'unknown'}），请手动处理`);
    await callBridge(this.bridge, 'click', { tabId, selector: `${selector} .ui-radiobutton-box`, real: true });
    return this.readBack(tabId, field);
  }

  async executePrimengDate(tabId, field, value) {
    const selector = field.selector || field.css;
    const expected = String(value).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!expected) throw new Error('PrimeNG 日期值需为 YYYY-MM-DD，请手动处理');
    const triggerSelector = `${selector} .ui-datepicker-trigger`;
    const inputSelector = `${selector} input`;
    await this.openPrimengPopup(tabId, field, { panelSelector: '.ui-datepicker', triggerSelector });
    await callBridge(this.bridge, 'type', { tabId, selector: inputSelector, text: String(value), clear: true, real: true });
    // input.value 只能证明“框里有字”；面板的年月选择器与高亮日来自组件模型，
    // 两者都对上才说明这次写入真的提交给了 Angular。
    const expr = this.primengProbe(selector, `
      const panel=root.querySelector('.ui-datepicker');
      const input=root.querySelector('input');
      const year=panel&&panel.querySelector('select.ui-datepicker-year');
      const month=panel&&panel.querySelector('select.ui-datepicker-month');
      const active=panel&&panel.querySelector('.ui-datepicker-calendar .ui-state-active');
      return {status:(panel&&input&&year&&month&&active)?'readable':(panel?'incomplete':'missing-panel'),
        input:String((input&&input.value)||''),year:year?String(year.value):null,
        month:month?String(Number(month.value)+1).padStart(2,'0'):null,day:active?String(active.textContent||'').trim():null};
    `);
    const accepts = (state) => state?.status === 'readable' && state.year === expected[1] && state.month === expected[2]
      && (!expected[3] || state.day === String(Number(expected[3])));
    let state = null;
    const deadline = Date.now() + 1500;
    do {
      state = extractBridgeValue(await callBridge(this.bridge, 'eval', { tabId, expr }));
      if (accepts(state)) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    } while (Date.now() < deadline);
    if (accepts(state)) {
      await this.closePrimengPopup(tabId, field, { panelSelector: '.ui-datepicker', triggerSelector });
      return this.readBack(tabId, field);
    }
    // 模型没有接受这个值：清空刚写入的文字再交回手动处理，避免留下只有文字没有模型的半成品。
    try {
      await callBridge(this.bridge, 'type', { tabId, selector: inputSelector, text: '', clear: true, real: true });
    } catch (error) {
      // 只吞掉清空动作自身的失败：真正的失败原因已由下面的错误记录，最终读回会显示输入框现状。
      this.logger({ field, error });
    }
    await this.closePrimengPopup(tabId, field, { panelSelector: '.ui-datepicker', triggerSelector });
    throw new Error('日期未进入日期控件模型，已清空输入框，请手动选择');
  }
  async executeComplex(tabId, field, value) {
    const kind = inferKind(field);
    if (kind === 'primeng-select') return this.executePrimengSelect(tabId, field, value);
    if (kind === 'primeng-radio') return this.executePrimengRadio(tabId, field, value);
    if (kind === 'primeng-date') return this.executePrimengDate(tabId, field, value);
    if (kind === 'owned-popup-select' && typeof this.bridge.click === 'function') {
      return this.executeRealOwnedPopup(tabId, field, value);
    }
    await this.ensureInjected(tabId);
    const driver = ({
      'moka-sd-select': 'pickMoka', 'moka-month-pair': 'pickMokaMonthPair',
      'owned-popup-select': 'pickOwnedPopup', 'feishu-date-range': 'pickFeishuDateRange',
      'phoenix-select': 'pickPhoenix', 'phoenix-date': 'pickPhoenixDate',
      'phoenix-constant': 'pickPhoenixConstant', 'phoenix-area': 'pickPhoenixArea',
      'phoenix-radio': 'pickPhoenixRadio', 'aria-radio': 'pickAriaRadio',
      'feishu-radio': 'pickFeishuRadio', 'jd-profession': 'pickJdProfession',
    })[kind];
    if (!driver) throw new Error(`未支持的复杂控件类型: ${kind}`);
    const result = await callBridge(this.bridge, 'eval', { tabId, expr: driverScript(field, value, driver) });
    const payload = extractBridgeValue(result);
    return payload?.readback ?? payload;
  }

  async executeField(tabId, field, value, { readBack: readBackOverride } = {}) {
    if (!field || typeof field !== 'object') throw new TypeError('字段观察结果必须是对象');
    const base = { pageLabel: field.label, sourceKey: field.sourceKey, recordIdentity: field.recordIdentity, matchMode: field.matchMode || 'exact', action: 'write', requiresUserCheck: field.matchMode === 'fuzzy', currentValueBefore: field.currentValue ?? '' };
    if (field.blocked) return { ...base, status: 'blocked', readback: 'failed', reason: field.blockedReason || '字段已阻断' };
    if (field.pendingReason) return { ...base, status: 'pending', readback: 'failed', reason: field.pendingReason };
    if (field.unsupported) return { ...base, status: 'unsupported', readback: 'failed', reason: field.unsupportedReason || '控件暂不支持' };
    if (!isBlank(field.currentValue)) {
      // 非空只表示已有内容；只有与确认目标一致才能报告 matched，冲突保留原值供核对。
      const hasExpectedValue = !isBlank(value);
      const matched = hasExpectedValue && matchesValue(value, field.currentValue, field);
      return { ...base, action: 'skip', status: matched ? 'skipped_existing' : 'pending',
        readback: matched ? 'matched' : 'failed', requiresUserCheck: base.requiresUserCheck || !matched,
        value: field.currentValue, expectedValue: value,
        ...(!matched ? { reason: hasExpectedValue ? '页面已有值与确认目标不一致，已保留原值' : '页面已有值缺少可核对的确认目标，已保留原值' } : {}) };
    }
    if (isBlank(value)) return { ...base, status: 'pending', readback: 'failed', reason: '资料没有可写入的确认值' };
    if (!field.ref && !field.selector && !field.css) return { ...base, status: 'pending', readback: 'failed', reason: '缺少可执行字段引用' };
    if (inferKind(field) !== 'native' && !field.selector && !field.css) return { ...base, status: 'pending', readback: 'failed', reason: '复杂控件缺少可注入的 CSS selector' };

    const complex = inferKind(field) !== 'native';
    let lastError;
    // 真实下拉的第一次 click 会切换 portal 状态，重复整段动作可能把已打开的
    // 弹层再次关闭；失败后交给用户检查，不对真实控件做盲目重试。
    // 真实下拉/单选只允许一次动作：重复整段动作会把已打开的弹层再次关闭或造成重复点击。
    const maxAttempts = ['owned-popup-select', 'primeng-select', 'primeng-radio', 'primeng-date'].includes(inferKind(field)) ? 0 : this.maxRetries;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      try {
        const actual = complex ? await this.executeComplex(tabId, field, value) : await this.executeNative(tabId, field, value);
        const readback = typeof readBackOverride === 'function'
          ? await readBackOverride({ tabId, field, actual })
          : await this.readBack(tabId, field, actual);
        const matched = matchesValue(value, readback, field);
        return { ...base, status: matched ? 'attempted' : 'write_unverified', readback: matched ? 'matched' : 'failed', value: readback, attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        this.logger({ field, attempt: attempt + 1, error });
        if (/csp|content security policy|permission/i.test(String(error?.code || '') + ' ' + String(error?.message || error))) {
          return { ...base, status: 'unsupported', readback: 'failed', reason: '页面 CSP/权限阻断复杂控件注入', attempts: attempt + 1 };
        }
        if (bridgeError(error)) throw new BridgeDisconnectedError(error.message, error?.code || 'BRIDGE_DISCONNECTED');
      }
    }
    return { ...base, status: 'write_unverified', readback: 'failed', reason: lastError?.message || String(lastError), attempts: this.maxRetries + 1 };
  }

  async executeFields(tabId, fields, { values = {}, onResult, beforeField } = {}) {
    const report = [];
    for (let index = 0; index < fields.length; index += 1) {
      let field = fields[index];
      try {
        field = beforeField ? await beforeField(field, index) : field;
        const result = await this.executeField(tabId, field, values[field.sourceKey] ?? field.value, {});
        report.push(result);
        if (onResult) await onResult(result, field, index);
      } catch (error) {
        if (!(error instanceof BridgeDisconnectedError)) throw error;
        report.push({ pageLabel: field.label, sourceKey: field.sourceKey, status: 'blocked', readback: 'failed', reason: error.message, errorCode: error.code || 'BRIDGE_DISCONNECTED' });
        for (const rest of fields.slice(index + 1)) report.push({ pageLabel: rest.label, sourceKey: rest.sourceKey, status: 'blocked', readback: 'failed', reason: error.message, errorCode: error.code || 'BRIDGE_DISCONNECTED' });
        break;
      }
    }
    return report;
  }

  /*
   * Snapshot refs are ephemeral.  A React/SPA re-render can invalidate them
   * while leaving a stable selector or field label intact.  Rebind only when
   * exactly one current snapshot node matches; ambiguity is deliberately
   * returned to the caller as pending instead of guessing by array order.
   */
  rebindFields(fields, snapshot) {
    if (!Array.isArray(fields)) throw new TypeError('fields 必须是数组');
    const snapshotId = snapshot?.snapshotId ?? snapshot?.id ?? snapshot?.revision ?? null;
    const nodes = flattenSnapshot(snapshot);
    return fields.map((field) => {
      if (!field || typeof field !== 'object') return { field, rebindFailed: true, reason: '字段计划无效' };
      const sameSnapshot = field.snapshotId && snapshotId && String(field.snapshotId) === String(snapshotId);
      const direct = sameSnapshot && field.ref ? nodes.filter((node) => node.ref === field.ref) : [];
      const matches = direct.length ? direct : nodes.filter((node) => nodeMatches(node, field));
      if (matches.length !== 1) {
        // Huashu 真实 bridge 的 snapshot 在部分版本只返回文本和 snapshotId。
        // 只要 plannedField 自带稳定 selector，就允许 Runtime 继续到 beforeField
        // 通过页面读回确认当前值；没有 selector 仍必须 pending，不能按文字猜 ref。
        if (!matches.length && !nodes.length && typeof snapshot?.text === 'string' && (field.selector || field.css)) {
          return { field: { ...field, snapshotId, currentValueKnown: false,
            snapshotRevision: snapshot?.revision ?? snapshot?.snapshotRevision ?? snapshotId },
          rebindFailed: false, snapshotRebound: true, selectorFallback: true };
        }
        return { field: { ...field, snapshotId }, rebindFailed: true,
          reason: matches.length ? '当前 snapshot 存在多个候选，拒绝猜测' : '当前 snapshot 无唯一重绑定候选' };
      }
      const target = matches[0];
      const freshRef = target.ref ?? target.id ?? null;
      const freshSelector = target.selector ?? target.css ?? null;
      const requiresRef = inferKind(field) === 'native';
      if (requiresRef && !freshRef) return { field: { ...field, snapshotId }, rebindFailed: true, reason: '当前 snapshot 没有新的稳定 ref，拒绝沿用旧 ref' };
      if (!freshRef && !freshSelector) return { field: { ...field, snapshotId }, rebindFailed: true, reason: '当前 snapshot 没有新的稳定定位信息' };
      const hasCurrentValue = Object.prototype.hasOwnProperty.call(target, 'currentValue') || Object.prototype.hasOwnProperty.call(target, 'value');
      return { field: { ...field, ref: freshRef || undefined,
        selector: freshSelector || undefined,
        css: target.css ?? (freshSelector && freshSelector !== target.selector ? freshSelector : undefined), find: target.find,
        currentValue: hasCurrentValue ? (target.currentValue ?? target.value ?? '') : '',
        currentValueKnown: hasCurrentValue,
        snapshotId, snapshotRevision: snapshot?.revision ?? snapshot?.snapshotRevision ?? snapshotId },
      rebindFailed: false, snapshotRebound: true };
    });
  }
}

function flattenSnapshot(snapshot) {
  const result = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value.ref || value.selector || value.css || value.find || value.label || value.name) result.push(value);
    for (const [key, child] of Object.entries(value)) if (!['parent', 'ownerDocument'].includes(key)) visit(child);
  };
  visit(snapshot?.fields ?? snapshot?.elements ?? snapshot);
  return result;
}

function nodeMatches(node, field) {
  const stable = [field.selector, field.css].filter(Boolean);
  if (stable.length) return stable.some((value) => value === node.selector || value === node.css);
  if (field.find && typeof field.find === 'object') {
    const pairs = Object.entries(field.find).filter(([, value]) => value !== undefined && value !== null);
    if (pairs.length && pairs.every(([key, value]) => node[key] === value)) return true;
  }
  return false;
}

module.exports = { WidgetExecutor, BridgeDisconnectedError, inferKind, normalize, isBlank, matchesValue, flattenSnapshot, nodeMatches };
