/* 控件驱动器：通用动作与明确登记的特殊控件在此执行，写入后必须读回。 */
(() => {
  if (globalThis.JobfillWidgetDrivers?.version === 8) return;
  function create(ctx) {
    const { norm, blank, pause, visible, read, writeNative, dateValue, refreshMokaField, mokaIdentity } = ctx;
    const bestEffort = () => ctx.bestEffort === true;
    const selectedEvidence = new WeakMap();
    const rootValue = field => {
      const root = field?.el;
      if (!root) return '';
      const input = root.querySelector('input:not([type="search"]),textarea');
      // calcEle 只是尺寸测量文本，placeholder 也可能是搜索/默认提示；只有已显示的 tipEle 才是最终选中证据。
      const shown = root.querySelector('.phoenix-select__tipWrapper--visible .phoenix-select__tipEle,.phoenix-select__tipEle');
      const text = String(shown?.textContent ?? '').trim();
      if (text && !/^请选择$|^选择$/.test(text)) return text;
      // Phoenix 的可编辑 input 也承载搜索/未提交文本；没有展示节点或本轮证据时不能把它当成最终选中值。
      return '';
    };
    const phoenixRead = field => {
      const proof = selectedEvidence.get(field?.el);
      if (proof && proof.row === field.row && proof.label === field.label && field.el.isConnected && rootValue(field) === proof.display) return proof.display;
      if (field?.dateControl) return undefined;
      return rootValue(field);
    };
    function readSelected(field) {
      const proof=selectedEvidence.get(field.el);
      if (!proof || proof.row!==field.row || proof.label!==field.label || !proof.menu.isConnected || !proof.option.isConnected) return undefined;
      const input=field.el.querySelector('input');
      const selected=Array.from(proof.menu.querySelectorAll('.el-select-dropdown__item.selected,.el-select-dropdown__item.is-selected,[role="option"][aria-selected="true"]'));
      if (selected.length!==1 || selected[0]!==proof.option || proof.option.textContent.trim()!==proof.display || String(input?.value ?? '')!==proof.display) return undefined;
      return proof.display;
    }
    async function waitFor(fn, ms = 1000) {
      const until = Date.now() + ms;
      do { const result = fn(); if (result) return result; await pause(60); } while (Date.now() < until);
      return null;
    }
    async function pick(field, value) {
      const doc = field.el.ownerDocument;
      if (Array.from(doc.querySelectorAll('.am-picker-popup,[role="dialog"]')).some(visible)) throw new Error('请先关闭当前弹窗');
      if (!blank(read(field))) return false;
      field.el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const popupSelector = '.am-picker-popup,.ant-select-dropdown,.el-select-dropdown,[role="listbox"]';
      const opened = new Set(Array.from(doc.querySelectorAll(popupSelector)).filter(visible));
      if (opened.size) throw new Error('请先关闭当前下拉面板');
      const trigger = field.el.querySelector('.ant-select-selector,.ant-select-selection,.el-select__wrapper,.am-list-item') || field.el;
      const findPopup = () => {
        const panels = Array.from(doc.querySelectorAll(popupSelector)).filter(x => visible(x) && !opened.has(x));
        const roots = panels.filter(x => !panels.some(parent => parent !== x && parent.contains(x)));
        // Element 在展开后才把弹层 ID 写到 trigger；有归属证据时优先绑定当前字段。
        const owners = [field.el,...field.el.querySelectorAll('[aria-controls],[aria-owns],[aria-describedby]')]
          .flatMap(n=>['aria-controls','aria-owns','aria-describedby'].flatMap(a=>(n.getAttribute(a)||'').split(/\s+/)))
          .filter(Boolean).map(id=>doc.getElementById(id)).filter(Boolean);
        if (owners.length) {
          const owned = roots.filter(p=>owners.some(owner=>owner===p||owner.contains(p)||p.contains(owner)));
          return owned.length===1 ? owned[0] : null;
        }
        return roots.length === 1 ? roots[0] : null;
      };
      const keyboardTarget=field.el.querySelector('input');
      let popup;
      let committed = false;
      try {
        if (field.el.matches('.ant-select')) trigger.dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger.click();
        popup = await waitFor(findPopup, field.el.matches('.el-select') ? 350 : 1500);
        if (!popup && field.el.matches('.el-select') && keyboardTarget) {
          if (!field.el.isConnected || !ctx.editable(field) || !blank(read(field))) throw new Error('选择框状态已变化，未继续');
          // 使用组件公开的展开按键；不写查询词、不调用框架私有状态，也不按 Enter 猜选。
          keyboardTarget.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));
          popup = await waitFor(findPopup,1500);
        }
        if (!popup) throw new Error('未识别到当前字段的选项面板，请手动选择');
        if (!field.el.isConnected || !ctx.editable(field) || !blank(read(field))) throw new Error('选项展开期间字段已变化，未继续');
        const cols = Array.from(popup.querySelectorAll('.am-picker-col'));
        if (cols.length) {
          if (cols.length !== 1) throw new Error('多列日期/地区选择器需手动选择');
          const options = Array.from(cols[0].querySelectorAll('.am-picker-col-item'));
          const match = options.filter(x => norm(x.textContent) === norm(value));
          if (match.length !== 1) throw new Error('没有唯一的匹配选项');
          if (!match[0].classList.contains('am-picker-col-item-selected')) {
            const rect = match[0].getBoundingClientRect();
            match[0].dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
          }
          if (!await waitFor(() => match[0].classList.contains('am-picker-col-item-selected'), 500)) throw new Error('滚轮未响应，需手动选择');
          const confirm = popup.querySelector('.am-picker-popup-header-right');
          if (!confirm || !/^确定$/.test(confirm.textContent.trim())) throw new Error('未找到选择器确认按钮');
          confirm.click();
          committed = true;
        } else {
          const options = Array.from(popup.querySelectorAll('[role="option"],.ant-select-item-option,.ant-select-dropdown-menu-item,.el-select-dropdown__item')).filter(visible);
          const matches = options.filter(x => ctx.optionMatches(field,value,x.textContent) && x.getAttribute('aria-disabled') !== 'true' && !x.className.includes('disabled'));
          if (matches.length !== 1) throw new Error('没有唯一的匹配选项');
          matches[0].click(); committed = true;
          // 可编辑的展示输入不能仅凭文字算已选；保存本次归属明确的选项读回证据。
          if (field.el.matches('.el-select')) selectedEvidence.set(field.el,{row:field.row,label:field.label,menu:popup,option:matches[0],display:matches[0].textContent.trim()});
        }
        if (!await waitFor(() => field.el.isConnected && ctx.optionMatches(field,value,read(field)) && !field.row.classList.contains('is-error') && !Array.from(field.row.querySelectorAll('.el-form-item__error,[aria-invalid="true"]')).some(n=>visible(n)&&(n.getAttribute('aria-invalid')==='true'||Number(doc.defaultView.getComputedStyle(n).opacity)!==0)), 1200) && !bestEffort()) throw new Error('选项未生效，请检查');
        return committed;
      } finally {
        if (!committed) {
          const cancel = popup?.querySelector('.am-picker-popup-header-left');
          if (cancel && cancel.textContent.trim() === '取消') cancel.click();
          else (keyboardTarget || field.el).dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', code:'Escape', bubbles: true }));
        }
      }
    }

    async function pickOwnedPopup(field, value) {
      if (!blank(read(field))) return false;
      const doc = field.el.ownerDocument;
      const popupSelector = '[role="listbox"],[role="dialog"],[class*="select-popup"],[class*="select-dropdown"],[class*="select-list"],[class*="selectList"],[class*="dropdown-menu"],[class*="dropdownMenu"],[class*="menu-list"],[class*="menuList"],[class*="popover"],[class*="popup"]';
      // 页面可能把经历表单放在独立滚动容器里；扫描能看到字段不代表它当前在视口内。
      // 仅在字段确实离开视口时滚动；已打开的 portal 不能被无意义的滚动事件销毁。
      const fieldRect = field.el.getBoundingClientRect();
      if (fieldRect.top < 0 || fieldRect.bottom > doc.defaultView.innerHeight) {
        field.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        await pause(80);
      }
      // 飞书会把旧 portal 节点留在 body 里，节点可能仍有尺寸但 opacity=0、pointer-events=none
      // 或已经移到视口外。它们不能算当前字段的候选，否则多个历史弹层会让归属判断保守失败。
      const popupVisible = node => {
        if (!visible(node)) return false;
        const style = doc.defaultView.getComputedStyle(node);
        if (Number(style.opacity) < 0.02 || style.pointerEvents === 'none') return false;
        const rect = node.getBoundingClientRect();
        // 当前字段已在可视表单区域内；弹层完全位于视口外时是旧 portal 残留，不参与归属。
        return rect.bottom >= 0 && rect.top <= doc.defaultView.innerHeight;
      };
      const before = new Set(Array.from(doc.querySelectorAll(popupSelector)).filter(popupVisible));
      const beforeNodes = new Set(Array.from(doc.body?.querySelectorAll('*') || []));
      // 飞书的可见点击区域是 selector 内的 placeholder/content；里面的 readonly input
      // 有些租户只负责显示，对它派发合成事件不会让 React 弹出 portal。
      const trigger = field.el.querySelector('.ud__select__selector__placeholder')
        || field.el.querySelector('.ud__select__selector__content,.ud__select__selector,button,[role="combobox"],input')
        || field.el;
      const matchingPopups = () => Array.from(doc.querySelectorAll(popupSelector))
        .filter(node => !field.row.contains(node) && norm(node.textContent).includes(norm(value)));
      let popup;
      // 当前页可能已经由用户或上一轮动作打开弹层；再次点击会把它关掉。
      // 只复用唯一且实际占据视口空间的候选，避免接纳零尺寸历史节点。
      const existing = matchingPopups().filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1 && rect.bottom >= 0 && rect.top <= doc.defaultView.innerHeight;
      });
      if (existing.length === 1) popup = existing[0];
      if (!popup) {
        const Pointer = doc.defaultView.PointerEvent || doc.defaultView.MouseEvent;
        const rect = trigger.getBoundingClientRect();
        const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        trigger.dispatchEvent(new Pointer('pointerenter', { bubbles: false, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', ...point }));
        trigger.dispatchEvent(new doc.defaultView.MouseEvent('mouseenter', { bubbles: false, button: 0, buttons: 0, ...point }));
        trigger.dispatchEvent(new Pointer('pointerover', { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', ...point }));
        trigger.dispatchEvent(new doc.defaultView.MouseEvent('mouseover', { bubbles: true, button: 0, buttons: 0, ...point }));
        trigger.dispatchEvent(new doc.defaultView.MouseEvent('mousemove', { bubbles: true, button: 0, buttons: 0, ...point }));
        trigger.dispatchEvent(new Pointer('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', ...point }));
        trigger.dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, ...point }));
        trigger.dispatchEvent(new Pointer('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', ...point }));
        trigger.dispatchEvent(new doc.defaultView.MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0, ...point }));
        trigger.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, button: 0, buttons: 0, ...point }));
        trigger.closest('.ud__select__selector')?.querySelector('input')?.focus();
      }
      popup ||= await waitFor(() => {
        const directMatches = matchingPopups();
        if (directMatches.length === 1) return directMatches[0];
        if (directMatches.length > 1) return null;
        const owners = [field.el, trigger].flatMap(node => ['aria-controls','aria-owns','aria-describedby'].flatMap(name => (node.getAttribute(name) || '').split(/\s+/)))
          .filter(Boolean).map(id => doc.getElementById(id)).filter(Boolean);
        const candidates = Array.from(doc.querySelectorAll(popupSelector)).filter(popupVisible).filter(node => !before.has(node))
          .filter(node => !Array.from(doc.querySelectorAll(popupSelector)).some(parent => parent !== node && parent.contains(node)));
        const owned = owners.length ? candidates.filter(node => owners.some(owner => owner === node || owner.contains(node) || node.contains(owner))) : candidates;
        if (owned.length === 1) return owned[0];
        if (owners.length || owned.length > 1) return null;
        // 部分飞书版本复用同一个无 id 的 portal 节点；它不属于 before 的新增集合，
        // 但当前只剩一个可见且包含目标文本的弹层时，文本和视口位置足以完成归属证明。
        const nearby = Array.from(doc.querySelectorAll(popupSelector)).filter(popupVisible)
          .filter(node => !field.row.contains(node) && norm(node.textContent).includes(norm(value)));
        if (nearby.length === 1) return nearby[0];
        // 安克当前租户会先把正在打开的 portal 保持 opacity:0，再由内部动画完成显示；
        // selector 已明确处于 open 且目标文本唯一时，可把这个当前节点作为候选，
        // 但仍必须经过唯一选项点击和最终字段读回，避免接纳旧的隐藏弹层。
        const openSelector = field.el.querySelector('.ud__select__selector-open');
        if (openSelector) {
          const openMatches = matchingPopups();
          if (openMatches.length === 1) return openMatches[0];
        }
        // 飞书租户之间的弹层 class 不稳定，有些只生成普通 portal 节点而没有 listbox/dialog 语义。
        // 仅接受点击后新增、可见、位于当前字段外且包含唯一目标候选的浮层，避免把页面正文同名文字当成选项。
        const optionSelector = '[role="option"],li,[data-value],button,[class*="option"],[class*="Option"],[class*="item"],[class*="Item"]';
        const matches = Array.from(doc.querySelectorAll(optionSelector)).filter(option => visible(option) && !field.row.contains(option) && norm(option.textContent) === norm(value));
        const roots = Array.from(new Set(matches.map(option => {
          let node = option;
          for (let depth = 0; node.parentElement && depth < 8; depth++, node = node.parentElement) {
            const style = doc.defaultView.getComputedStyle(node);
            const popupLike = node !== doc.body && (node.getAttribute('role') === 'listbox' || node.getAttribute('role') === 'dialog' || /popup|select|dropdown|menu|popover|option|list/i.test(String(node.className)) || ['fixed','absolute','sticky'].includes(style.position));
            if (popupLike && (beforeNodes.has(node) === false || node.parentElement === doc.body)) return node;
          }
          return option.parentElement;
        })).filter(root => root && popupVisible(root) && !field.row.contains(root)));
        return roots.length === 1 ? roots[0] : null;
      }, 1600);
      if (!popup) throw new Error('未识别到当前飞书字段的归属弹层，请本人选择');
      const options = Array.from(popup.querySelectorAll('[role="option"],li,[data-value],[class*="option"],[class*="Option"],[class*="item"],[class*="Item"]')).filter(visible)
        .filter(option => option.getAttribute('aria-disabled') !== 'true' && !/disabled/i.test(String(option.className)));
      const matches = options.filter(option => norm(option.textContent) === norm(value));
      if (matches.length !== 1) throw new Error(matches.length ? '飞书候选不唯一，请本人选择' : '飞书没有唯一匹配候选，请本人选择');
      matches[0].click();
      if (!await waitFor(() => norm(read(field)) === norm(value), 1200)) throw new Error('飞书选择未完成最终读回');
      selectedEvidence.set(field.el, { row: field.row, label: field.label, menu: popup, option: matches[0], display: String(value).trim() });
      return true;
    }
    // Phoenix 的四种弹层共用“先开层、再定位、最后确认”的交互；把它们统一登记，
    // 才能在开层前判断是否已有未关闭的层。
    const PHOENIX_LAYER_SELECTOR = '.common-unmodeled-layer,.constant-main-selector-container,.area-selector-container,.phoenix-date-picker,.phoenix-calendar';
    const PHOENIX_OPEN_SELECTOR = '.common-unmodeled-layer .phoenix-selectList,.constant-main-selector-container,.area-selector-container,.phoenix-date-picker,.phoenix-calendar';
    // 地区级联的选项文本会打乱层级顺序（如“肇庆市广东省”），按最细一级地名做包含匹配。
    const areaToken = value => {
      const text = String(value ?? '').trim();
      const match = text.match(/[^省市区县]+[市区县]$/);
      return match ? match[0] : text;
    };
    const optionLabel = option => option.querySelector('.item-text-label,.phoenix-selectList__singleLabel')?.textContent || option.textContent;
    const phoenixOptionMatch = (options, value) => {
      const exact = options.filter(option => norm(optionLabel(option)) === norm(value));
      if (exact.length) return exact;
      const token = norm(areaToken(value));
      if (!token) return [];
      return options.filter(option => {
        const text = norm(optionLabel(option));
        return text.includes(token) || token.includes(text);
      });
    };
    // React 把 props 挂在 DOM 节点的私有键上；键名随版本变化，逐个探测。
    const reactProps = node => {
      for (const key of Object.keys(node).filter(name => /^__react(EventHandlers|Props)\$/.test(name))) if (node[key]) return node[key];
      const fiberKey = Object.keys(node).find(name => /^__reactFiber\$/.test(name));
      return fiberKey ? node[fiberKey]?.memoizedProps : null;
    };
    // 公开指针序列在多数租户可提交；少数租户（如 job.imou.com）只把 onClick 挂在
    // 选项内的单选图标上，普通点击到不了。此时回落到组件自己的 React 处理器——
    // 只在公开路径未产生可验证结果后使用，且只作用于当前节点，不触发表单提交。
    const reactClick = node => {
      const handler = reactProps(node)?.onClick;
      if (typeof handler !== 'function') return false;
      handler.call(node, { type: 'click', target: node, currentTarget: node, bubbles: false, cancelable: true, defaultPrevented: false, isTrusted: false, nativeEvent: {}, stopPropagation() {}, preventDefault() {} });
      return true;
    };
    const pointerClick = (doc, node) => {
      const Pointer = doc.defaultView.PointerEvent || doc.defaultView.MouseEvent;
      const rect = node.getBoundingClientRect();
      const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      node.dispatchEvent(new Pointer('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', ...point }));
      node.dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, ...point }));
      node.dispatchEvent(new Pointer('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', ...point }));
      node.dispatchEvent(new doc.defaultView.MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0, ...point }));
      node.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, button: 0, buttons: 0, ...point }));
    };
    async function commitNode(doc, node, verify, ms = 700) {
      pointerClick(doc, node);
      if (await waitFor(verify, ms)) return true;
      if (!reactClick(node)) return false;
      return Boolean(await waitFor(verify, ms));
    }
    // 程序化打开不会自动关闭上一个弹层；用“打开前后可见层差集”定位当前字段的层，
    // 并轮询等待渲染（后台标签页的定时器节流让固定等待不可靠）。
    async function openPhoenixLayer(field, layerSelector) {
      const doc = field.el.ownerDocument;
      const before = new Set(Array.from(doc.querySelectorAll(PHOENIX_LAYER_SELECTOR)).filter(visible));
      openPhoenix(field);
      const layer = await waitFor(() => {
        const nodes = Array.from(doc.querySelectorAll(layerSelector)).filter(visible);
        const roots = nodes.filter(node => !nodes.some(parent => parent !== node && parent.contains(node)));
        const fresh = roots.filter(node => !before.has(node) && !before.has(node.closest('.common-unmodeled-layer') || node));
        if (fresh.length === 1) return fresh[0];
        if (fresh.length > 1) return null;
        return roots.length === 1 ? roots[0] : null;
      }, 2500);
      if (!layer) throw new Error('未识别到当前 Phoenix 弹层，请手动选择');
      return layer;
    }
    // ConstantSelector 与地区级联都是“点图标暂存 → 点确定提交”。没有暂存证据就
    // 绝不点确定，避免把默认项提交成字段值。
    const stagedCount = layer => {
      const node = Array.from(layer.querySelectorAll('*')).find(el => !el.children.length && /已选/.test(el.textContent));
      const match = node && String(node.textContent).match(/(\d+)/);
      return match ? Number(match[1]) : null;
    };
    const stagedVisual = option => {
      const checked = text => /check|select|active/i.test(text) && !/uncheck|unselect|unchecked|inactive/i.test(text);
      return checked(String(option.querySelector('svg')?.getAttribute('class') || '')) || checked(String(option.className || ''));
    };
    const confirmButton = layer => Array.from(layer.querySelectorAll('.phoenix-button'))
      .find(button => /^确定$/.test(String((button.querySelector('.phoenix-button__content') || button).textContent).trim()));
    const selectedMatches = (field, value, optionText) => {
      const shown = norm(read(field));
      if (!shown) return false;
      return [norm(value), norm(optionText), norm(areaToken(value))].filter(Boolean)
        .some(target => shown === target || shown.includes(target) || target.includes(shown));
    };
    async function pickPhoenixStageSelect(field, value, { layerSelector, optionSelector, searchPlaceholder }) {
      if (!blank(read(field))) return false;
      const doc = field.el.ownerDocument;
      let layer;
      try {
        layer = await openPhoenixLayer(field, layerSelector);
        const search = layer.querySelector(`input[placeholder="${searchPlaceholder}"]`);
        if (search) { writeNative(search, areaToken(value)); await pause(220); }
        const options = await waitFor(() => {
          const found = Array.from(layer.querySelectorAll(optionSelector)).filter(visible);
          return found.length ? found : null;
        }, 1500) || [];
        const enabled = options.filter(option => !option.matches('.is-disabled,[aria-disabled="true"]') && !/disabled/i.test(String(option.className)));
        const matches = phoenixOptionMatch(enabled, value);
        if (matches.length !== 1) throw new Error(matches.length ? 'Phoenix 候选项不唯一，请手动选择' : 'Phoenix 无唯一匹配候选，请手动选择');
        const option = matches[0];
        const icon = option.querySelector('svg');
        if (!icon) throw new Error('Phoenix 候选项缺少可点击图标，请手动选择');
        const before = stagedCount(layer);
        const verifyStage = () => before === null ? stagedVisual(option) : (stagedCount(layer) ?? before) > before;
        if (!await commitNode(doc, icon, verifyStage, 700)) throw new Error('Phoenix 选项未被暂存，请手动选择');
        const confirm = confirmButton(layer);
        if (!confirm) throw new Error('未找到 Phoenix 确认按钮，请手动选择');
        if (!await commitNode(doc, confirm, () => selectedMatches(field, value, optionLabel(option)), 900)) throw new Error('Phoenix 选择未完成最终读回');
        selectedEvidence.set(field.el, { row: field.row, label: field.label, display: rootValue(field) || String(value).trim() });
        return true;
      } finally {
        if (layer?.isConnected && !await closePhoenix(field, layer)) throw new Error('Phoenix 弹层未能安全关闭，请手动处理');
      }
    }
    const pickPhoenixConstant = (field, value) => pickPhoenixStageSelect(field, value, { layerSelector: '.constant-main-selector-container', optionSelector: '.list-item-container', searchPlaceholder: '搜索' });
    const pickPhoenixArea = (field, value) => pickPhoenixStageSelect(field, value, { layerSelector: '.area-selector-container', optionSelector: '.area-item-container', searchPlaceholder: '搜索' });
    function openPhoenix(field) {
      const doc = field.el.ownerDocument;
      const existing = Array.from(doc.querySelectorAll(PHOENIX_OPEN_SELECTOR)).filter(visible);
      if (existing.length) throw new Error('请先关闭当前 Phoenix 弹层');
      const target = field.el.querySelector('input') || field.el;
      // 部分 Phoenix 租户只在指针序列上打开弹层；单独派发 click 会让 DOM
      // 看似可点击但不会生成选项面板，导致“未识别到面板”。仍只作用于当前
      // 字段，不调用框架私有状态，也不触发表单提交。
      field.el.scrollIntoView?.({ block: 'center', behavior: 'instant' });
      const Pointer = doc.defaultView.PointerEvent || doc.defaultView.MouseEvent;
      const rect = target.getBoundingClientRect();
      const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      target.dispatchEvent(new Pointer('pointerenter', { bubbles: false, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', ...point }));
      target.dispatchEvent(new doc.defaultView.MouseEvent('mouseenter', { bubbles: false, button: 0, buttons: 0, ...point }));
      target.dispatchEvent(new Pointer('pointerover', { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', ...point }));
      target.dispatchEvent(new doc.defaultView.MouseEvent('mouseover', { bubbles: true, button: 0, buttons: 0, ...point }));
      target.dispatchEvent(new doc.defaultView.MouseEvent('mousemove', { bubbles: true, button: 0, buttons: 0, ...point }));
      target.dispatchEvent(new Pointer('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', ...point }));
      target.dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, ...point }));
      target.dispatchEvent(new Pointer('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', ...point }));
      target.dispatchEvent(new doc.defaultView.MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0, ...point }));
      target.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, button: 0, buttons: 0, ...point }));
      return doc;
    }
    function phoenixPopup(doc, selector) {
      const panels = Array.from(doc.querySelectorAll(selector)).filter(visible);
      const roots = panels.filter(panel => !panels.some(parent => parent !== panel && parent.contains(panel)));
      if (roots.length !== 1) throw new Error('Phoenix 弹层归属不唯一，请手动处理');
      return roots[0];
    }
    async function closePhoenix(field, popup) {
      if (!popup?.isConnected || !visible(popup)) return true;
      const doc = field.el.ownerDocument;
      const gone = () => !popup.isConnected || !visible(popup);
      const title = field.title || field.row?.querySelector('label,.form-item__text');
      if (title) for (const type of ['mousedown', 'mouseup', 'click']) title.dispatchEvent(new doc.defaultView.MouseEvent(type, { bubbles: true, button: 0 }));
      if (await waitFor(gone, 600)) return true;
      // ConstantSelector 与地区级联的层不响应标题点击，退回到 footer 的“取消”与 Escape。
      const cancel = Array.from(popup.querySelectorAll('.phoenix-button'))
        .find(button => /^取消$/.test(String((button.querySelector('.phoenix-button__content') || button).textContent).trim()));
      if (cancel) {
        pointerClick(doc, cancel);
        if (await waitFor(gone, 500)) return true;
        reactClick(cancel);
        if (await waitFor(gone, 500)) return true;
      }
      (field.el.querySelector('input') || field.el).dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      doc.body?.dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { bubbles: true }));
      return Boolean(await waitFor(gone, 600));
    }
    function virtualListComplete(popup, options, searched) {
      const virtual = popup.querySelector('.phoenix-selectList__virtualList,[class*="virtualList"],[class*="virtual-list"]');
      if (!virtual) return true;
      const loading = virtual.getAttribute('aria-busy') === 'true' || popup.querySelector('[class*="loading"],[class*="Loading"],[data-loading="true"]') || /加载更多|正在加载|没有更多/i.test(popup.textContent);
      if (loading) return false;
      const setSizeNode = popup.querySelector('[aria-setsize]') || virtual.querySelector('[aria-setsize]');
      const setSize = Number(setSizeNode?.getAttribute('aria-setsize'));
      const scrollComplete = Number(virtual.scrollHeight) > 0 && Number(virtual.clientHeight) > 0 && Number(virtual.scrollHeight) <= Number(virtual.clientHeight) + 1;
      const countComplete = Number.isFinite(setSize) && setSize > 0 ? options.length >= setSize : false;
      // 搜索后的唯一结果本身提供了足够归属证据；未搜索时必须证明没有被虚拟化截断。
      return searched ? options.length === 1 : scrollComplete || countComplete;
    }
    async function pickPhoenix(field, value) {
      if (!blank(read(field))) return false;
      const doc = openPhoenix(field);
      let popup, committed = false;
      try {
        popup = await waitFor(() => { try { return phoenixPopup(doc, '.common-unmodeled-layer .phoenix-selectList'); } catch { return null; } }, 1500);
        if (!popup) throw new Error('未识别到 Phoenix 选项面板，请手动选择');
        const search = popup.querySelector('input.phoenix-input__input[placeholder="搜索"],input[placeholder="搜索"]');
        if (search) {
          writeNative(search, value);
          await pause(120);
        }
        const options = Array.from(popup.querySelectorAll('li.phoenix-selectList__listItem')).filter(visible)
          .filter(option => option.getAttribute('aria-disabled') !== 'true' && !/disabled/i.test(String(option.className)));
        const matches = options.filter(option => norm(option.querySelector('.phoenix-selectList__singleLabel')?.textContent || option.textContent) === norm(value));
        if (matches.length !== 1) throw new Error(matches.length ? 'Phoenix 候选不唯一，请手动选择' : 'Phoenix 无唯一匹配候选，请手动选择');
        if (!virtualListComplete(popup, options, Boolean(search))) throw new Error('Phoenix 虚拟列表未能证明完整呈现，需本人选择');
        matches[0].click();
        committed = true;
        if (!await waitFor(() => field.el.isConnected && phoenixRead(field) === String(value).trim(), 1200)) throw new Error('Phoenix 选项未完成最终读回');
        selectedEvidence.set(field.el, { row: field.row, label: field.label, display: String(value).trim() });
        if (popup.isConnected && !await closePhoenix(field, popup)) throw new Error('Phoenix 选项弹层未能安全关闭，请手动处理');
        return true;
      } finally {
        if (!committed && popup?.isConnected && !await closePhoenix(field, popup)) throw new Error('Phoenix 选项弹层未能安全关闭，请手动处理');
      }
    }
    async function pickPhoenixRadio(field, value) {
      if (!blank(read(field))) return false;
      const root = field.el, doc = root.ownerDocument;
      const options = Array.from(root.querySelectorAll('.phoenix-radio')).filter(visible)
        .filter(option => !option.matches('[aria-disabled="true"],.is-disabled') && norm(option.querySelector('.phoenix-radio__radio-text')?.textContent || option.textContent) === norm(value));
      if (options.length !== 1) throw new Error('Phoenix 单选项不唯一，请手动选择');
      options[0].click();
      if (!await waitFor(() => root.isConnected && options[0].classList.contains('phoenix-radio--checked') && root.querySelectorAll('.phoenix-radio--checked').length === 1, 700)) throw new Error('Phoenix 单选未完成最终读回');
      return true;
    }
    async function pickAriaRadio(field, value) {
      if (!blank(read(field))) return false;
      const root = field.el, options = Array.from(root.querySelectorAll('[role="radio"]')).filter(visible)
        .filter(option => option.getAttribute('aria-disabled') !== 'true' && norm(option.textContent) === norm(value));
      if (options.length !== 1) throw new Error('ARIA 单选项不唯一，请手动选择');
      options[0].click();
      if (!await waitFor(() => root.isConnected && options[0].getAttribute('aria-checked') === 'true' && root.querySelectorAll('[role="radio"][aria-checked="true"]').length === 1, 700)) throw new Error('ARIA 单选未完成最终读回');
      return true;
    }

    async function pickFeishuRadio(field, value) {
      if (!blank(read(field))) return false;
      const options = field.parts.filter(option => visible(option) && !option.disabled && (norm(option.value) === norm(value) || Array.from(option.labels || []).some(label => norm(label.textContent) === norm(value))));
      if (options.length !== 1) throw new Error('飞书单选项不唯一，请本人选择');
      options[0].click();
      if (!await waitFor(() => options[0].checked && field.parts.filter(option => option.checked).length === 1 && norm(read(field)) === norm(value), 700)) throw new Error('飞书单选未完成最终读回');
      return true;
    }
    async function pickFeishuDateRange(field) {
      const values = field.rangeValues;
      const month = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
      if (!values || !month(values.start) || !month(values.end) || values.start > values.end) throw new Error('起止月份缺失、精度不符或顺序错误，请本人处理');
      const inputs = () => Array.from(field.row.querySelectorAll('.throne-biz-date-range-picker-wrapper .throne-biz-date-range-picker-input input, .throne-biz-date-range-picker-wrapper input.ud__native-input'));
      const current = inputs();
      if (current.length !== 2 || current.some(input => input.type !== 'text' || input.disabled || input.readOnly || !visible(input))) throw new Error('日期范围控件结构或编辑状态不明确，请本人处理');
      if (current.some(input => !blank(input.value)) || field.row.querySelector('input[type="checkbox"]:checked')) throw new Error('日期范围已有部分值或至今状态，请本人核验');
      // 受控表单可能在开始月份的 input/change 后替换内部 input；结束月份必须从同一业务行重新获取。
      writeNative(current[0], values.start);
      const afterStart = await waitFor(() => {
        if (!field.row.isConnected || !field.el.isConnected) return null;
        const fresh = inputs();
        return fresh.length === 2 && fresh[0].value === values.start && blank(fresh[1].value) ? fresh : null;
      }, 800);
      if (!afterStart || afterStart[1].readOnly || afterStart[1].disabled) throw new Error('开始月份写入后控件变化，未继续填写结束月份');
      writeNative(afterStart[1], values.end);
      if (!await waitFor(() => {
        if (!field.row.isConnected || !field.el.isConnected) return false;
        const fresh = inputs();
        return fresh.length === 2 && fresh[0].value === values.start && fresh[1].value === values.end && !fresh.some(input => input.getAttribute('aria-invalid') === 'true') && !field.row.querySelector('.ud-formily-item-feedback:not(:empty)');
      }, 1000)) throw new Error('日期范围未完成双值读回或页面校验未通过');
      return true;
    }
    async function pickPhoenixDate(field, value) {
      if (!blank(read(field))) return false;
      const target = dateValue(value, '', '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) throw new Error('日期精度不明确或不是完整日期，需本人选择');
      const doc = openPhoenix(field); let popup, committed = false;
      try {
        popup = await waitFor(() => { try { return phoenixPopup(doc, '.phoenix-date-picker,.phoenix-calendar'); } catch { return null; } }, 1500);
        if (!popup) throw new Error('未识别到 Phoenix 日期面板，请手动选择');
        const input = popup.querySelector('.phoenix-calendar-input');
        if (!input) throw new Error('Phoenix 日期输入不可验证，请手动选择');
        writeNative(input, target); await pause(120);
        if (String(input.value) !== target) throw new Error('Phoenix 日期输入未接受目标值');
        if (!await waitFor(() => rootValue(field) === target, 900)) throw new Error('Phoenix 日期未完成外层字段读回');
        selectedEvidence.set(field.el, { row: field.row, label: field.label, display: target });
        committed = true;
        // Escape 在现场不会关闭 Phoenix 日期层；标题的鼠标事件序列是可观察的安全关闭路径。
        if (!await closePhoenix(field, popup)) throw new Error('Phoenix 日期弹层未能安全关闭，请手动处理');
        return true;
      } finally {
        if (!committed && popup?.isConnected) {
          await closePhoenix(field, popup);
        }
      }
    }
    async function pickMoka(field, value) {
      const doc = field.el.ownerDocument, win = doc.defaultView;
      // Moka 老页面有 Dropdown 外壳，当前明源云页面则直接把
      // sd-Select-container 作为字段根节点；两者都属于同一类弹出选择控件。
      const container = field.el.closest('[class*="sd-Dropdown-container-"],[class*="sd-Select-container-"]')
        || (field.el.matches?.('[class*="sd-Dropdown-container-"],[class*="sd-Select-container-"]') ? field.el : null);
      if (!container) throw new Error('下拉结构未识别，请手动选择');
      const menuSelector = '[class*="sd-Dropdown-dropdown-"]';
      if (Array.from(doc.querySelectorAll(`${menuSelector},[role="dialog"]`)).some(visible)) throw new Error('请先关闭当前选择面板');
      const identity = mokaIdentity(field);
      let popup;
      try {
        const opened = new Set(Array.from(doc.querySelectorAll(menuSelector)).filter(visible));
        field.el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const trigger = field.el.querySelector('label,input,[role="combobox"]') || field.el;
        trigger.click();
        popup = await waitFor(() => {
          const menus = Array.from(doc.querySelectorAll(menuSelector)).filter(menu => visible(menu) && !opened.has(menu));
          const matching = menus.filter(menu => Array.from(menu.querySelectorAll('[class*="sd-Select-common-item-"]')).some(option => norm(option.querySelector('[class*="option-label-"]')?.textContent || option.textContent) === norm(value)));
          if (menus.length !== 1 || matching.length !== 1) return null;
          const refs = [field.el, ...field.el.querySelectorAll('[aria-controls],[aria-owns],[aria-describedby]')]
            .flatMap(node => ['aria-controls','aria-owns','aria-describedby'].flatMap(name => (node.getAttribute(name) || '').split(/\s+/)))
            .filter(Boolean).map(id => doc.getElementById(id)).filter(Boolean);
          if (refs.length && !refs.some(ref => ref === menus[0] || ref.contains(menus[0]) || menus[0].contains(ref))) return null;
          return menus[0];
        }, 1500);
        if (!popup) throw new Error('未识别到 Moka 选项面板，请手动选择');
        const options = await waitFor(() => { const found = Array.from(popup.querySelectorAll('[class*="sd-Select-common-item-"]')).filter(visible); return found.length ? found : null; }, 1500);
        const matches = (options || []).filter(option => !option.matches('[disabled],[aria-disabled="true"]') && !Array.from(option.classList).some(name => /disabled/i.test(name)) && norm(option.querySelector('[class*="option-label-"]')?.textContent || option.textContent) === norm(value));
        if (matches.length !== 1) throw new Error('没有唯一的匹配选项，搜索或级联候选请手动选择');
        const fresh = refreshMokaField(field);
        if (fresh.el !== field.el || !ctx.editable(fresh) || !blank(read(fresh)) || mokaIdentity(fresh) !== identity) throw new Error('字段或记录在选择期间发生变化，已停止');
        matches[0].click();
        if (!await waitFor(() => { const current = refreshMokaField(field); return norm(read(current)) === norm(value) && !current.validationError; }, 1000) && !bestEffort()) throw new Error('选项未生效或页面仍报错，请检查');
        return true;
      } finally {
        await closeMokaPopup(field);
      }
    }
    async function closeMokaPopup(field) {
      const doc = field?.el?.ownerDocument || document;
      const menuSelector = '[class*="sd-Dropdown-dropdown-"]';
      const visibleMenus = () => Array.from(doc.querySelectorAll(`${menuSelector},[role="dialog"]`)).filter(visible);
      if (!visibleMenus().length) return true;
      const input = field.el.querySelector?.('input,[role="combobox"]') || field.el;
      const win = doc.defaultView;
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (await waitFor(() => !visibleMenus().length, 350)) return true;
      input.click();
      if (await waitFor(() => !visibleMenus().length, 350)) return true;
      doc.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
      doc.body.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      return await waitFor(() => !visibleMenus().length, 350);
    }
    const mokaPartValue = part => part?.querySelector('[class*="sd-Input-display-value-"]')?.textContent?.trim() || '';
    async function pickMokaMonthPart(field, index, value, identity) {
      const doc = field.el.ownerDocument, win = doc.defaultView;
      const menuSelector = '[class*="sd-Dropdown-dropdown-"]';
      const fresh = refreshMokaField(field);
      const part = fresh.selectParts?.[index];
      if (!part) throw new Error('年月控件结构未识别，请手动选择');
      if (Array.from(doc.querySelectorAll(`${menuSelector},[role="dialog"]`)).some(visible)) throw new Error('请先关闭当前选择面板');
      const opened = new Set(Array.from(doc.querySelectorAll(menuSelector)).filter(visible));
      part.scrollIntoView({ block: 'center', behavior: 'instant' });
      const trigger = part.querySelector('input,[role="combobox"]') || part;
      trigger.click();
      let popup;
      try {
        popup = await waitFor(() => {
          const menus = Array.from(doc.querySelectorAll(menuSelector)).filter(menu => visible(menu) && !opened.has(menu));
          const matching = menus.filter(menu => Array.from(menu.querySelectorAll('[class*="sd-Select-common-item-"]')).some(option => norm(option.querySelector('[class*="option-label-"]')?.textContent || option.textContent) === norm(value)));
          return menus.length === 1 && matching.length === 1 ? menus[0] : null;
        }, 1500);
        if (!popup) throw new Error('未识别到 Moka 年月选项面板，请手动选择');
        const options = await waitFor(() => { const found = Array.from(popup.querySelectorAll('[class*="sd-Select-common-item-"]')).filter(visible); return found.length ? found : null; }, 1500);
        const matches = (options || []).filter(option => !option.matches('[disabled],[aria-disabled="true"]') && !Array.from(option.classList).some(name => /disabled/i.test(name)) && norm(option.querySelector('[class*="option-label-"]')?.textContent || option.textContent) === norm(value));
        if (matches.length !== 1) throw new Error('年月选项没有唯一匹配，请手动选择');
        const before = refreshMokaField(field);
        if (mokaIdentity(before) !== identity || !ctx.editable(before)) throw new Error('字段或记录在年月选择期间发生变化，已停止');
        matches[0].click();
        if (!await waitFor(() => {
          const current = refreshMokaField(field), currentPart = current.selectParts?.[index];
          return currentPart && norm(mokaPartValue(currentPart)) === norm(value) && !current.validationError;
        }, 1000) && !bestEffort()) throw new Error('年月选项未生效或页面仍报错，请检查');
      } finally {
        await closeMokaPopup({ el: part });
      }
    }
    async function pickMokaMonthPair(field, value) {
      const parts = String(value).match(/^(\d{4})[-./](\d{1,2})$/);
      if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 12) throw new Error('MD 日期需为 YYYY-MM，当前控件未接受其他精度');
      const identity = mokaIdentity(field);
      await pickMokaMonthPart(field, 0, parts[1], identity);
      await pickMokaMonthPart(field, 1, String(Number(parts[2])).padStart(2, '0'), identity);
      const current = refreshMokaField(field);
      if (read(current) !== `${parts[1]}-${String(Number(parts[2])).padStart(2, '0')}` || current.validationError) throw new Error('年月范围未完成最终读回，请手动核验');
      return true;
    }
    async function pickJdProfession(field, value) {
      const doc = field.el.ownerDocument;
      const parts = value.split('/').map(x => x.trim());
      if (parts.length !== 2 || parts.some(x => !x)) throw new Error('专业类别资料需为大类/子类');
      if (Array.from(doc.querySelectorAll('[class*="pickerWrap"],.am-modal,[role="dialog"]')).some(visible)) throw new Error('请先完成或关闭当前选择面板');
      if (!blank(read(field))) return false;
      field.el.scrollIntoView({ block: 'center', behavior: 'instant' }); field.el.click();
      const panel = await waitFor(() => Array.from(doc.querySelectorAll('[class*="pickerWrap"]')).find(x => visible(x) && x.querySelector('[class*="pickerLeftWrap"]') && x.querySelector('[class*="pickerRightWrap"]')), 1500);
      if (!panel) throw new Error('专业类别面板未打开');
      const parents = Array.from(panel.querySelector('[class*="pickerLeftWrap"]').children).filter(x => norm(x.textContent) === norm(parts[0]));
      if (parents.length !== 1) throw new Error('专业大类未唯一匹配，请手动完成面板');
      parents[0].click();
      const child = await waitFor(() => { if (!parents[0].className.includes('pickerActiveItem')) return null; const options = Array.from(panel.querySelector('[class*="pickerRightWrap"]').children).filter(x => norm(x.textContent) === norm(parts[1])); return options.length === 1 ? options[0] : null; }, 4000);
      if (!child) throw new Error('专业子类未加载或未匹配，请手动完成面板');
      if (!field.el.isConnected || !blank(read(field))) throw new Error('字段在选择期间发生变化，已停止');
      child.click();
      if (!await waitFor(() => norm(read(field)) === norm(value), 1200)) throw new Error('专业类别未生效，请检查');
      return true;
    }
    async function apply(field, value) {
      if (!ctx.editable(field) || !blank(read(field))) return false;
      const el = field.el;
      if (field.unsupported) throw new Error('必填控件尚未渲染，请手动处理');
      if (el.type === 'file') throw new Error('附件请手动选择');
      if (el.type === 'password') throw new Error('密码字段需本人处理');
      if (el.type === 'checkbox' || /验证码|密码|协议|声明|承诺|同意/.test(field.label)) throw new Error('此项需本人处理');
      if (field.driver === 'jd-profession') return pickJdProfession(field, value);
      if (field.widgetKind === 'phoenix-select') return field.dateControl ? pickPhoenixDate(field, value) : pickPhoenix(field, value);
      if (field.widgetKind === 'phoenix-constant') return pickPhoenixConstant(field, value);
      if (field.widgetKind === 'phoenix-area') return pickPhoenixArea(field, value);
      if (field.widgetKind === 'owned-popup-select') return pickOwnedPopup(field, value);
      if (field.widgetKind === 'phoenix-radio') return pickPhoenixRadio(field, value);
      if (field.widgetKind === 'aria-radio') return pickAriaRadio(field, value);
      if (field.widgetKind === 'feishu-radio') return pickFeishuRadio(field, value);
      if (field.widgetKind === 'feishu-date-range') return pickFeishuDateRange(field);
      if (field.mokaMonthPair) return pickMokaMonthPair(field, value);
      if (field.custom) return field.selectDriver === 'moka' ? pickMoka(field, value) : pick(field, value);
      if (el.type === 'radio') {
        const group = ctx.radios(el);
        if (!group.length || group.some(x => !x.isConnected)) throw new Error('单选组在填写期间发生变化');
        const options = group.filter(x => visible(x) && !x.disabled && (norm(x.value) === norm(value) || Array.from(x.labels || []).some(l => norm(l.textContent) === norm(value))));
        if (options.length !== 1) throw new Error('单选项不唯一');
        if (group.some(x => x.checked)) return false;
        // 浏览器会自动取消同 form 同 name 的其他选项；跨业务组重名时不发出点击。
        if (options[0].name && Array.from((options[0].form || options[0].ownerDocument).querySelectorAll('input[type="radio"]')).some(x => x.form === options[0].form && x.name === options[0].name && !group.includes(x))) throw new Error('单选名称跨字段重复，需本人处理');
        const target = options[0].labels?.[0] || options[0].closest('label') || options[0];
        target.click();
        if (!await waitFor(() => {
          const fresh = ctx.radios(el);
          return fresh.length === group.length && fresh.every((x, i) => x === group[i] && x.isConnected) && options[0].checked && fresh.filter(x => x.checked).length === 1;
        }, 500)) throw new Error('单选未生效或单选组发生变化');
        return true;
      }
      let target = value;
      if (el.tagName === 'SELECT') {
        const matches = Array.from(el.options).filter(x => !x.disabled && (ctx.optionMatches(field,value,x.textContent) || x.value === value));
        if (matches.length !== 1) throw new Error('没有唯一的下拉选项');
        target = matches[0].value;
      } else if (el.type === 'date' || el.type === 'month' || /日期|时间|年月/.test(field.label)) target = dateValue(value, el.type, el.placeholder);
      if (el.maxLength > 0 && target.length > el.maxLength) throw new Error('资料超过网站字数限制，未截断');
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) throw new Error('此类编辑器暂不支持');
      if (el.matches('[role="combobox"]') || el.getAttribute('aria-autocomplete') === 'list') throw new Error('搜索选择框需手动确认候选项');
      writeNative(el, target); await pause(120);
      if ((!el.isConnected || String(el.value) !== target || (el.validity && !el.validity.valid)) && !bestEffort()) throw new Error('字段未生效或未通过页面格式检查');
      return true;
    }
    const readWidgetSelected = field => {
      if (field?.widgetKind === 'phoenix-radio') return field.el.querySelector('.phoenix-radio--checked .phoenix-radio__radio-text')?.textContent?.trim() || undefined;
      if (field?.widgetKind === 'aria-radio') return field.el.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim() || undefined;
      if (field?.widgetKind === 'owned-popup-select') {
        const proof = selectedEvidence.get(field.el);
        // 通用 ARIA 下拉没有固定展示 class；只从当前控件自身读取 readonly/value 或可见文字，
        // 不递归调用 engine.read，避免新控件在尚无本轮 selected 证据时栈溢出。
        const raw = field.el.matches?.('input,textarea') ? field.el.value
          : field.el.querySelector?.('input[readonly],textarea')?.value
          || field.el.querySelector?.('.selected,[aria-selected="true"],[data-selected="true"]')?.textContent
          || field.el.textContent;
        const value = String(raw || '').trim();
        if (proof && proof.row === field.row && proof.label === field.label && proof.display === value) return proof.display;
        return value && !/^(请选择|选择|未选择|select an option)$/i.test(value) ? value : undefined;
      }
      return field?.widgetKind?.startsWith('phoenix-') ? phoenixRead(field) : readSelected(field);
    };
    return { apply, pick, pickMoka, pickJdProfession, pickPhoenix, pickPhoenixConstant, pickPhoenixArea, pickPhoenixRadio, pickAriaRadio, pickFeishuRadio, pickFeishuDateRange, pickPhoenixDate, pickOwnedPopup, waitFor, readSelected: readWidgetSelected };
  }
  globalThis.JobfillWidgetDrivers = { version: 8, create };
})();
