/* ALT Magnifier — 倍率角标（Shadow DOM 封装，不污染页面样式、不挡点击）
 *
 * 位置策略：position:fixed + transform-origin: right top + translateZ(0)。
 * 角标挂在 <html> 上，而 <html> 整体被 scale 放大，所以角标自己也要 scale，
 * 否则它会跟着一起被放大成巨大的方块。用 1/k 缩放并锚定右上角，它看起来
 * 就永远待在右上角、且大小恒定 —— 纯合成层动画，不触发重排。
 */
'use strict';

(function () {
  const HOST_ID = 'alt-magnifier-hud';
  const FADE_OUT_MS = 60;

  // 只在顶层文档装 HUD：iframe 的角标会被外层缩放二次放大，且会重复显示。
  try {
    if (window.top !== window.self) return;
  } catch (_) {
    return; // 跨域 iframe 拿不到 top，直接不装
  }

  let host = null;
  let wrap = null;
  let scaleEl = null;
  let maxEl = null;
  let hideAt = 0;
  let rafId = 0;

  function ensure() {
    if (wrap && wrap.isConnected) return;
    host = document.getElementById(HOST_ID);
    if (host && host.shadowRoot) {
      // 上一次注入留下的（例如扩展重新加载），复用
      wrap = host.shadowRoot.getElementById('wrap');
      scaleEl = host.shadowRoot.getElementById('scale');
      maxEl = host.shadowRoot.getElementById('max');
      if (wrap && scaleEl && maxEl) return;
    }

    host = document.createElement('div');
    host.id = HOST_ID;
    // 极高 z-index + 不参与交互；display:contents 让宿主本身不产生任何盒子
    host.style.cssText =
      'all:initial;position:fixed;top:0;right:0;z-index:2147483647;pointer-events:none;display:block;';

    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      #wrap {
        position: fixed;
        top: 12px;
        right: 12px;
        transform-origin: right top;
        transform: translateZ(0) scale(1);
        will-change: transform, opacity;
        opacity: 0;
        transition: opacity ${FADE_OUT_MS}ms linear;
        font: 600 12px/1 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        color: #fff;
        background: rgba(17, 20, 26, 0.82);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        padding: 6px 9px;
        letter-spacing: 0.2px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(6px);
        white-space: nowrap;
        user-select: none;
        contain: content;
      }
      #scale { font-size: 13px; }
      #max { opacity: 0.62; font-weight: 500; margin-left: 4px; }
      #wrap.limit { border-color: rgba(255, 176, 74, 0.9); }
    `;
    wrap = document.createElement('div');
    wrap.id = 'wrap';
    scaleEl = document.createElement('span');
    scaleEl.id = 'scale';
    maxEl = document.createElement('span');
    maxEl.id = 'max';
    wrap.appendChild(scaleEl);
    wrap.appendChild(maxEl);
    root.appendChild(style);
    root.appendChild(wrap);

    // 必须挂在 documentElement 上：这样 html 被 scale 时它也在缩放画布内
    (document.documentElement || document.body).appendChild(host);
  }

  function format(k) {
    const rounded = Math.round(k * 100) / 100;
    return '×' + (Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2).replace(/0$/, ''));
  }

  const api = {
    /** 更新显示内容。kScale 用于把角标反向缩放，保持屏幕尺寸恒定。 */
    show(k, kScale, atLimit, maxText) {
      ensure();
      scaleEl.textContent = format(k);
      if (maxText) {
        maxEl.textContent = maxText;
      } else {
        maxEl.textContent = '';
      }
      wrap.classList.toggle('limit', !!atLimit);
      wrap.style.transform = 'translateZ(0) scale(' + (1 / kScale).toFixed(4) + ')';
      wrap.style.opacity = '1';
      hideAt = performance.now() + 1200;
      if (!rafId) rafId = requestAnimationFrame(tick);
    },

    /** 立刻淡出（退出放大模式时调用） */
    hide() {
      hideAt = 0;
      if (wrap) wrap.style.opacity = '0';
    },

    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = wrap = scaleEl = maxEl = null;
    },
  };

  function tick() {
    rafId = 0;
    if (!wrap) return;
    if (hideAt && performance.now() >= hideAt) {
      wrap.style.opacity = '0';
      hideAt = 0;
      return;
    }
    if (hideAt) rafId = requestAnimationFrame(tick);
  }

  window.MagHUD = api;
})();
