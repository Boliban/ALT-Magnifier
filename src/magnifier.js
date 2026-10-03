/* ALT Magnifier — 核心引擎
 * ---------------------------------------------------------------------------
 * 目标：按住 Alt + 滚轮，把整个页面「当成一张图片」整体放大，
 *       并且放大过程中元素位置零漂移（不重排、不改布局）。
 *
 * 原理（唯一改动）：
 *   document.documentElement.style.transform = 'scale(k)'  (+ transform-origin: 0 0)
 *
 *   为什么这样元素位置不会变：
 *     1) transform 只影响绘制/合成阶段，不进入布局（layout）阶段 —— 零次重排。
 *     2) 根元素带 transform 后，scrollWidth/scrollHeight 会按倍率自动放大，
 *        所以滚动条天然可用，不需要加任何 width/height 补丁
 *        （加补丁的那种做法才是真的会改变布局，也才会导致元素脱位）。
 *     3) 页面里的 JS 读到的 window.innerWidth / offsetTop / offsetWidth 全部不变，
 *        网站察觉不到任何变化 —— 这是它与浏览器缩放(Ctrl+)/CSS zoom 的本质差别，
 *        后两者会改布局视口，触发 vw/vh 与媒体查询断点重算，页面立刻重排。
 *
 * 锚点补偿（让鼠标指着的那一点钉在原地）：
 *   设 k=旧倍率, k'=新倍率, a=鼠标在视口中的位置(clientX/clientY)，
 *   s=当前滚动位置(scrollLeft/scrollTop)，则鼠标下那个内容点的文档坐标是
 *       d = (s + a) / k
 *   换上新倍率后要让它回到同一个屏幕像素：
 *       s' = d * k' - a
 *   全程用 d 重新计算而不是在 s 上累加，所以零累计误差，滚一百次也不漂。
 *
 * 性能：
 *   - 平时（未按住 Alt）：只有 2 个 capture 阶段监听器（wheel 是 passive 的），
 *     非 Alt 立即 return，零样式写入、零合成层、零 rAF。等于不存在。
 *   - 按住 Alt 那一刻才挂上非 passive 的 wheel（为了 preventDefault 阻止页面滚动）
 *     和 scroll 监听，退出时全部摘掉。
 *   - 缩放过程用 rAF 合并同一帧的多次滚轮事件，每帧写入固定次数的样式。
 *   - HUD 只在缩放期间存在，退出即销毁。
 */
'use strict';

(function () {
  if (window.__altMagnifierLoaded) return;
  window.__altMagnifierLoaded = true;

  const S = window.MagSettings;
  const HUD = window.MagHUD || null; // iframe 里没有 HUD，其余逻辑照常工作
  if (!S) return;

  const ROOT = document.documentElement;

  // ------------------------------------------------------------------ 状态
  let cfg = S.sanitize(null);
  let siteOK = true;
  let sessionOn = true; // Alt 按下期间的会话开关
  let active = false; // 是否已写入 transform
  let k = 1; // 当前倍率（布局空间，纯 CSS scale）
  let anchor = null; // { x, y, sx, sy } 视口锚点 + 进入放大时的滚动位置

  let rafId = 0;
  let running = false;
  let lastTs = 0;
  let target = null;
  let settleTimer = 0;
  let keyDown = false;
  let lastPointer = { x: 0, y: 0 };

  let rootOrig = null; // 根元素内联样式原值快照
  const overlayOrig = []; // 被覆写的 background-attachment 原值
  let scanPending = false;

  // ------------------------------------------------------------------ 工具
  const clamp = (v, lo, hi) => (lo <= hi ? Math.min(hi, Math.max(lo, v)) : v);
  const now = () => performance.now();

  function modifierDown(e) {
    switch (cfg.modifier) {
      case 'ctrl':
        return e.ctrlKey;
      case 'meta':
        return e.metaKey;
      case 'shift':
        return e.shiftKey;
      default:
        return e.altKey;
    }
  }

  function log() {
    if (!cfg.debug) return;
    try {
      console.log.apply(console, ['[ALT Magnifier]'].concat([].slice.call(arguments)));
    } catch (_) {}
  }

  // ------------------------------------------------- 根元素样式：写入 / 精确还原
  function stampRoot() {
    if (rootOrig) return;
    rootOrig = {
      transform: {
        v: ROOT.style.getPropertyValue('transform'),
        p: ROOT.style.getPropertyPriority('transform'),
      },
      origin: {
        v: ROOT.style.getPropertyValue('transform-origin'),
        p: ROOT.style.getPropertyPriority('transform-origin'),
      },
      anchor: {
        v: ROOT.style.getPropertyValue('overflow-anchor'),
        p: ROOT.style.getPropertyPriority('overflow-anchor'),
      },
    };
  }

  function writeTransform(value) {
    ROOT.style.setProperty('transform-origin', '0 0', 'important');
    ROOT.style.setProperty('transform', value, 'important');
    ROOT.style.setProperty('overflow-anchor', 'none', 'important');
  }

  function restoreRoot() {
    if (!rootOrig) return;
    const put = (prop, rec) => {
      if (rec.v) ROOT.style.setProperty(prop, rec.v, rec.p);
      else ROOT.style.removeProperty(prop);
    };
    put('transform', rootOrig.transform);
    put('transform-origin', rootOrig.origin);
    put('overflow-anchor', rootOrig.anchor);
    rootOrig = null;
  }

  function scroller() {
    return document.scrollingElement || ROOT || document.body;
  }

  function maxScroll() {
    const sc = scroller();
    return {
      x: Math.max(0, sc.scrollWidth - sc.clientWidth),
      y: Math.max(0, sc.scrollHeight - sc.clientHeight),
    };
  }

  // ------------------------------------- background-attachment: fixed 的定点修复
  // 这类背景图在根元素被 transform 后会「对画布投递」，导致背景与元素尺寸不成
  // 比例（B站图文页那种模糊大背景就是它）。放大期间临时覆写成 scroll，
  // 退出时按保存的原值逐条精确还原。
  const OVERLAY_TAGS = { IMG: 1, VIDEO: 1, CANVAS: 1, IFRAME: 1, SVG: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1 };

  function scanOverlayBackgrounds() {
    if (!cfg.fixFixedBackgrounds) return;
    const t0 = now();
    let list;
    try {
      list = document.body ? document.body.querySelectorAll('*') : null;
    } catch (_) {
      return;
    }
    if (!list) return;
    const budget = 6; // ms：单帧最多花这么多时间，超了就分片到后续帧
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = { x: 0, y: 0, w: vw, h: vh };
    for (let i = 0; i < list.length; i++) {
      if (now() - t0 > budget) {
        scanChunk(list, i, rect, vw, vh);
        return;
      }
      consider(list[i], rect, vw, vh);
    }
  }

  function scanChunk(list, start, rect, vw, vh) {
    const t0 = now();
    let i = start;
    for (; i < list.length; i++) {
      if (now() - t0 > 6) break;
      consider(list[i], rect, vw, vh);
    }
    if (i < list.length && active) {
      requestAnimationFrame(() => {
        if (active) scanChunk(list, i, { x: 0, y: 0, w: vw, h: vh }, vw, vh);
      });
    }
  }

  function consider(el, rect, vw, vh) {
    if (OVERLAY_TAGS[el.tagName]) return;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return;
    }
    if (!r.width || !r.height) return;
    // 只处理落在当前可视矩形内的元素；根元素放大后可视区在文档坐标里会移动，
    // 所以分片扫描会随时间推移覆盖到页面的不同部分。
    if (r.right < rect.x || r.left > rect.x + rect.w || r.bottom < rect.y || r.top > rect.y + rect.h) return;
    let bg = '';
    try {
      bg = getComputedStyle(el).backgroundAttachment;
    } catch (_) {
      return;
    }
    if (!bg || bg.indexOf('fixed') < 0) return;
    // 小元素（图标、徽标）忽略，只处理真正会露馅的大背景
    if (r.width * r.height < Math.min(vw * vh, 1e9) * 0.08) return;
    if (el.dataset && el.dataset.altMagBg !== undefined) return;
    if (el.dataset) el.dataset.altMagBg = '1';
    overlayOrig.push({
      el,
      v: el.style.getPropertyValue('background-attachment'),
      p: el.style.getPropertyPriority('background-attachment'),
    });
    try {
      el.style.setProperty('background-attachment', 'scroll', 'important');
    } catch (_) {}
  }

  function restoreOverlayBackgrounds() {
    for (let i = 0; i < overlayOrig.length; i++) {
      const rec = overlayOrig[i];
      const el = rec.el;
      try {
        if (el.dataset) delete el.dataset.altMagBg;
        if (rec.v) el.style.setProperty('background-attachment', rec.v, rec.p);
        else el.style.removeProperty('background-attachment');
      } catch (_) {}
    }
    overlayOrig.length = 0;
  }

  // ------------------------------------------------------------------ 缩放主循环
  function minK() {
    return Math.min(cfg.min, cfg.max);
  }
  function maxK() {
    return Math.max(cfg.min, cfg.max);
  }

  /** 单步滚轮后的目标倍率。末尾的吸附用于消掉浮点残留
   *  （1 / 1.12 * 1.12 在浮点下不严格等于 1）。与 src/math.js 保持一致。 */
  function nextScale(cur, dir) {
    const lo = minK();
    const hi = maxK();
    const step = cfg.step;
    const factor = dir > 0 ? step : 1 / step;
    const v = clamp(cur * factor, lo, hi);
    if (Math.abs(v - lo) < 1e-9) return lo;
    if (Math.abs(v - hi) < 1e-9) return hi;
    return v;
  }

  function pushTarget(next) {
    const lo = minK();
    const hi = maxK();
    const c = clamp(next, lo, hi);
    if (c === k && !running) {
      if (cfg.indicator && HUD && active) HUD.show(k, k, c === lo || c === hi, '／' + hi + '×');
      return;
    }
    target = c;
    if (!running) {
      running = true;
      lastTs = 0;
      rafId = requestAnimationFrame(frame);
    }
  }

  function frame(ts) {
    rafId = 0;
    if (!running) return;
    if (!active) {
      running = false;
      return;
    }
    const prev = k;
    let next = prev;
    if (target !== null && Math.abs(target - prev) > 1e-4) {
      const prevTs = lastTs || ts;
      lastTs = ts;
      const dt = Math.min(64, Math.max(1, ts - prevTs));
      // 指数逼近：约 110ms 收敛，慢帧自动加大步长，快速连滚时自然合并
      const alpha = 1 - Math.exp(-dt / 32);
      next = prev + (target - prev) * alpha;
      // 用绝对阈值收敛，而不是按倍率取相对值：
      // 按 target*0.0008 算的话，32 倍时阈值高达 0.026，动画会提前「跳」到目标值。
      if (Math.abs(target - next) < 0.001) next = target;
    } else {
      next = target === null ? prev : target;
      lastTs = 0;
    }
    applyScale(next);

    if (target !== null && Math.abs(target - k) > 1e-4) {
      rafId = requestAnimationFrame(frame);
    } else {
      running = false;
      target = null;
      lastTs = 0;
      // 收敛后再扫一片，继续找 background-attachment: fixed
      if (active) scheduleScan();
    }
  }

  function applyScale(nk) {
    if (!active || !anchor) return;
    const sc = scroller();
    const ax = anchor.x;
    const ay = anchor.y;
    // 鼠标下的内容点在「未缩放文档坐标」中的位置，基于进入放大时的基准计算，
    // 因此不会随着多次滚轮累积误差。
    const dx = (anchor.sx + ax) / anchor.k;
    const dy = (anchor.sy + ay) / anchor.k;

    k = nk;
    writeTransform('scale(' + k + ')');
    // 只读镜像，供诊断/自动化脚本读取，页面本身读不到（隔离世界）
    window.__altMagnifierK = k;

    // 关键：滚动值**不做取整**。取整会在每一格引入 0.5px 的锚点误差，
    // 连滚几十格就会累积成肉眼可见的漂移。小数滚动量在 Chromium 里是安全的，
    // 绘制阶段会把合成层对齐到整数设备像素，不会让文字发虚。
    const m = maxScroll();
    let nx = dx * k - ax;
    let ny = dy * k - ay;
    if (!isFinite(nx)) nx = 0;
    if (!isFinite(ny)) ny = 0;
    nx = clamp(nx, 0, m.x);
    ny = clamp(ny, 0, m.y);
    if (Math.abs(nx - sc.scrollLeft) > 0.01) sc.scrollLeft = nx;
    if (Math.abs(ny - sc.scrollTop) > 0.01) sc.scrollTop = ny;

    if (cfg.indicator && HUD) {
      HUD.show(k, k, k >= maxK() - 1e-6 || k <= minK() + 1e-6, '／' + maxK() + '×');
    }
  }

  function scheduleScan() {
    if (scanPending || !active) return;
    scanPending = true;
    requestAnimationFrame(() => {
      scanPending = false;
      if (!active) return;
      scanOverlayBackgrounds();
    });
  }

  // ------------------------------------------------------------------ 进入 / 退出
  function beginMagnify() {
    if (active || !cfg.enabled || !siteOK) return;
    if (!ROOT) return;
    const sc = scroller();
    active = true;
    anchor = {
      x: lastPointer.x,
      y: lastPointer.y,
      sx: sc.scrollLeft,
      sy: sc.scrollTop,
      k: 1, // 进入时永远是 1x，基准直接取未缩放文档坐标，最稳
    };
    stampRoot();
    writeTransform('scale(1)');
    attachActiveListeners();
    scheduleScan();
  }

  function endMagnify() {
    cancelSettle();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    running = false;
    target = null;
    lastTs = 0;
    if (!active) {
      if (cfg.indicator && HUD) HUD.hide();
      return;
    }
    const sc = scroller();
    restoreRoot();
    restoreOverlayBackgrounds();
    active = false;
    anchor = null;
    k = 1;
    // 还原后滚动范围变回正常尺寸，浏览器会自动把 scroll 钳制在合法区间，
    // 观感上就是「在哪一格放大，松手后就停在哪一格」。
    void sc.scrollLeft;
    detachActiveListeners();
    if (cfg.indicator && HUD) HUD.hide();
    log('exited, scroll =', sc.scrollLeft, sc.scrollTop);
  }

  function resetView() {
    // Esc：从当前放大位置直接读出一个未缩放的滚动目标，然后还原。
    if (!active || !anchor) return;
    const sc = scroller();
    const dx = (sc.scrollLeft + anchor.x) / k;
    const dy = (sc.scrollTop + anchor.y) / k;
    restoreRoot();
    restoreOverlayBackgrounds();
    active = false;
    cancelSettle();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    running = false;
    target = null;
    k = 1;
    const m = maxScroll();
    sc.scrollLeft = clamp(dx - anchor.x, 0, m.x);
    sc.scrollTop = clamp(dy - anchor.y, 0, m.y);
    anchor = null;
    detachActiveListeners();
    if (cfg.indicator && HUD) HUD.hide();
    log('reset to', sc.scrollLeft, sc.scrollTop);
  }

  function restoreView() {
    // Alt+0：回到「按下 Alt 时的原地」。
    if (!active || !anchor) return;
    const a = anchor;
    restoreRoot();
    restoreOverlayBackgrounds();
    active = false;
    cancelSettle();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    running = false;
    target = null;
    k = 1;
    const sc = scroller();
    const m = maxScroll();
    sc.scrollLeft = clamp(a.sx, 0, m.x);
    sc.scrollTop = clamp(a.sy, 0, m.y);
    anchor = null;
    detachActiveListeners();
    if (cfg.indicator && HUD) HUD.hide();
  }

  function cancelSettle() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
  }

  function scheduleSettle() {
    cancelSettle();
    if (!active) return;
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      if (active) endMagnify();
    }, cfg.settleDelay);
  }

  function toggleSession() {
    sessionOn = !sessionOn;
    if (!sessionOn) endMagnify();
    log('session', sessionOn ? 'on' : 'off');
  }

  // ------------------------------------------------------------------ 事件
  function onWheelCapture(e) {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    if (!cfg.enabled || !siteOK) return;
    if (!e.isTrusted) return;
    if (!modifierDown(e)) return;
    // Ctrl+滚轮是浏览器自身的缩放，网页收不到 keydown 也基本收不到 wheel，
    // 这里只做兜底：如果真收到了就直接阻断，避免和浏览器缩放叠加。
    e.preventDefault();
    e.stopPropagation();

    // 步进方向
    let dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    if (e.deltaY === 0) dir = e.deltaX < 0 ? 1 : e.deltaX > 0 ? -1 : 0;
    if (dir === 0) return;
    if (cfg.invert) dir = -dir;

    // 第一次滚轮才真正进入放大（单击 Alt 不会有任何副作用）
    if (!active) {
      if (dir < 0) {
        scheduleSettle(); // 已经是最小倍率，按下 Alt 滚了一下但不放大
        return;
      }
      beginMagnify();
      if (!active) return;
    }

    const base = target === null ? k : target;
    pushTarget(nextScale(base, dir));
    scheduleSettle();
  }

  function onKeyDown(e) {
    if (isModifierKey(e)) {
      if (keyDown) return;
      keyDown = true;
      lastPointer.x = window.innerWidth / 2;
      lastPointer.y = window.innerHeight / 2;
      return;
    }
    if (e.key === 'Escape' && active) {
      resetView();
      return;
    }
    if (!active || !cfg.enabled) return;
    if (e.key === '0' && modifierDown(e)) {
      e.preventDefault();
      restoreView();
      return;
    }
    // Alt + W：不依赖滚轮的开关（用于滚轮本身有问题、或想快速验证引擎是否活着）
    if ((e.key === 'w' || e.key === 'W') && modifierDown(e) && !e.repeat) {
      e.preventDefault();
      if (active) endMagnify();
      else beginMagnify();
    }
  }

  function onKeyUp(e) {
    if (isModifierKey(e)) {
      keyDown = false;
      scheduleSettle();
    }
  }

  function isModifierKey(e) {
    return (
      (cfg.modifier === 'alt' && (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight')) ||
      (cfg.modifier === 'ctrl' && (e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight')) ||
      (cfg.modifier === 'meta' && (e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight')) ||
      (cfg.modifier === 'shift' && (e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight'))
    );
  }

  function onWindowBlur() {
    keyDown = false;
    scheduleSettle();
  }

  // 窗口尺寸变化会让 transform-origin:0 0 的锚点含义失效，直接退出最稳。
  // 判定要精确：滚动条显隐本身会造成 1~15px 的尺寸抖动，如果只看一变就退出，
  // 用户一动滚动条就会被踢出放大模式。
  let lastW = 0;
  let lastH = 0;
  let lastDpr = 0;

  function readViewport() {
    const vv = window.visualViewport;
    return {
      w: Math.round(window.innerWidth),
      h: Math.round(window.innerHeight),
      dpr: window.devicePixelRatio || 1,
      vw: vv ? Math.round(vv.width) : 0,
      vh: vv ? Math.round(vv.height) : 0,
    };
  }

  function takeViewportBaseline() {
    const v = readViewport();
    lastW = v.w;
    lastH = v.h;
    lastDpr = v.dpr;
  }

  function viewportChanged() {
    const v = readViewport();
    // 浏览器自身缩放（Ctrl+滚轮 / Ctrl+加号）：devicePixelRatio 或视觉视口会变，
    // 这时必须退出，否则两套缩放叠加会算错锚点。
    if (Math.abs(v.dpr - lastDpr) > 0.001) return true;
    if (v.vw && v.vh && (Math.abs(v.vw - v.w) > 2 || Math.abs(v.vh - v.h) > 2)) return true;
    // 真正的窗口尺寸变化
    return Math.abs(v.w - lastW) > 24 || Math.abs(v.h - lastH) > 32;
  }

  function onViewportChange() {
    if (!active) return;
    if (viewportChanged()) {
      log('viewport changed, exiting');
      endMagnify();
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'sync' || !changes[S.KEY]) return;
    const oldMod = cfg.modifier;
    cfg = S.sanitize(changes[S.KEY].newValue);
    siteOK = S.siteAllowed(cfg, location.hostname);
    keyDown = false;
    if (!cfg.enabled || !siteOK) {
      endMagnify();
      return;
    }
    if (oldMod !== cfg.modifier) {
      // 换过按键就重新评估，避免用键盘以外的方式卡在放大态
    }
    if (active) {
      if (k > maxK() + 1e-6) pushTarget(maxK());
      else if (k < minK() - 1e-6) pushTarget(minK());
      else if (cfg.indicator) HUD.show(k, k, false, '／' + maxK() + '×');
    }
  }

  // --------------------------------------------------- 双套监听器（性能关键）
  // 平时只挂这一组：capture + passive，非 Alt 立即 return，不阻止任何默认行为。
  const PASSIVE = { capture: true, passive: true };
  const ACTIVE_KEY = { capture: true };
  const ACTIVE_WHEEL = { capture: true, passive: false };
  let activeAttached = false;

  function attachActiveListeners() {
    if (activeAttached) return;
    activeAttached = true;
    window.addEventListener('wheel', onWheelCapture, ACTIVE_WHEEL);
    takeViewportBaseline();
  }

  function detachActiveListeners() {
    if (!activeAttached) return;
    activeAttached = false;
    window.removeEventListener('wheel', onWheelCapture, ACTIVE_WHEEL);
  }

  function init() {
    window.addEventListener('wheel', onWheelCapture, PASSIVE);
    window.addEventListener('keydown', onKeyDown, ACTIVE_KEY);
    window.addEventListener('keyup', onKeyUp, ACTIVE_KEY);
    window.addEventListener('blur', onWindowBlur, PASSIVE);
    window.addEventListener('resize', onViewportChange, PASSIVE);
    try {
      // 浏览器自身缩放（Ctrl+滚轮 / Ctrl+加号）会让视觉视口变化，这里能第一时间发现
      if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange, PASSIVE);
    } catch (_) {}
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (_) {}
    try {
      // 供后台确认「本页引擎是否活着」+ 导出运行时状态用于排障
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg.type !== 'string') return false;
        if (msg.type === 'alt-magnifier:ping') {
          sendResponse({ ok: true, active: active, k: k });
          return false;
        }
        if (msg.type === 'alt-magnifier:dump') {
          let storage = null;
          try {
            storage = {
              enabled: cfg.enabled,
              modifier: cfg.modifier,
              step: cfg.step,
              min: cfg.min,
              max: cfg.max,
              invert: cfg.invert,
              indicator: cfg.indicator,
              settleDelay: cfg.settleDelay,
              siteMode: cfg.siteMode,
              siteList: cfg.siteList,
            };
          } catch (_) {}
          let foundKeys = null;
          try {
            foundKeys = Object.keys(localStorage).filter((x) => x.indexOf('magnifier') >= 0);
          } catch (_) {}
          sendResponse({
            ok: true,
            href: location.href,
            host: location.hostname,
            isTop: window.top === window.self,
            siteOK: siteOK,
            enabled: cfg.enabled,
            modifier: cfg.modifier,
            active: active,
            k: k,
            modifierDown: keyDown,
            anchor: anchor ? { x: anchor.x, y: anchor.y } : null,
            listenersAttached: activeAttached,
            storage: storage,
            rootTransform: ROOT ? ROOT.style.getPropertyValue('transform') : null,
            localStorageKeys: foundKeys,
          });
          return false;
        }
        if (msg.type === 'alt-magnifier:toggle') {
          if (active) endMagnify();
          else beginMagnify();
          sendResponse({ ok: true, active: active, k: k });
          return false;
        }
        return false;
      });
    } catch (_) {}

    S.get((loaded) => {
      cfg = loaded;
      siteOK = S.siteAllowed(cfg, location.hostname);
      // 兜底：扩展被重载/禁用时尽量把样式还回去
      window.addEventListener(
        'pagehide',
        () => {
          if (active) restoreRoot();
        },
        PASSIVE
      );
      log('ready', cfg);
    });
  }

  // 调试/自动化入口（诊断脚本会用）
  window.__altMagnifier = {
    get state() {
      return { active, k, target, cfg, modifierDown: keyDown, anchor: anchor ? { x: anchor.x, y: anchor.y } : null };
    },
    get active() {
      return active;
    },
    get k() {
      return k;
    },
    begin: beginMagnify,
    end: endMagnify,
    set: (v) => {
      if (!active) beginMagnify();
      pushTarget(clamp(v, minK(), maxK()));
    },
    reset: resetView,
  };

  // ------------------------------------------------------------------ 诊断注入
  // 只有在 URL 上显式带 ?magDiag=1 时才注入漂移检测脚本，且只注入顶层文档。
  // 平时零开销；注入的是页面世界的脚本，所以检测结果页面自己也能看到。
  function injectDiagnose() {
    try {
      if (window.top !== window.self) return;
      if (!/[?&]magDiag=1(&|$)/.test(location.search)) return;
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('test/diagnose.js');
      s.async = false;
      s.onload = () => {
        if (s.parentNode) s.parentNode.removeChild(s);
        console.log('[ALT Magnifier] 漂移检测已注入。按住 Alt 滚轮放大，松手后自动出报告。');
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (err) {
      log('diagnose inject failed', err);
    }
  }

  init();
  injectDiagnose();
})();
