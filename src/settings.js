/* ALT Magnifier — 设置读写（content script / options / popup 共用）
 *
 * 设计要点：内容脚本永远不因为 storage 出错而挂掉，读取失败一律回落到默认值。
 */
'use strict';

(function () {
  const KEY = 'magnifierSettingsV1';
  const MODIFIERS = ['alt', 'ctrl', 'meta', 'shift'];
  const DEFAULT_KEYWORD = 'alt';
  const FALLBACK = {
    enabled: true,
    modifier: DEFAULT_KEYWORD,
    step: 1.12,
    min: 1,
    max: 32,
    invert: false,
    indicator: true,
    fixFixedBackgrounds: true,
    settleDelay: 600,
    debug: false,
    siteMode: 'all',
    siteList: [],
  };

  const num = (v, fb, lo, hi) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  };

  function sanitize(raw) {
    const d = FALLBACK;
    const s = raw && typeof raw === 'object' ? raw : {};
    const out = {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
      modifier: MODIFIERS.indexOf(s.modifier) >= 0 ? s.modifier : d.modifier,
      step: num(s.step, d.step, 1.02, 2),
      min: num(s.min, d.min, 0.25, 32),
      max: num(s.max, d.max, 1, 32),
      invert: typeof s.invert === 'boolean' ? s.invert : d.invert,
      indicator: typeof s.indicator === 'boolean' ? s.indicator : d.indicator,
      fixFixedBackgrounds:
        typeof s.fixFixedBackgrounds === 'boolean' ? s.fixFixedBackgrounds : d.fixFixedBackgrounds,
      settleDelay: num(s.settleDelay, d.settleDelay, 0, 5000),
      debug: typeof s.debug === 'boolean' ? s.debug : d.debug,
      siteMode: s.siteMode === 'blacklist' || s.siteMode === 'whitelist' ? s.siteMode : d.siteMode,
      siteList: Array.isArray(s.siteList)
        ? s.siteList.map((x) => String(x).trim()).filter(Boolean).slice(0, 500)
        : d.siteList.slice(),
    };
    // 允许"反向缩放"：min 可以大于 max，此时方向相反（留作高级玩法，不强制修正）
    return out;
  }

  function normalizePattern(p) {
    let x = String(p || '').trim().toLowerCase();
    if (!x) return '';
    x = x.replace(/^[a-z]+:\/\//, ''); // 去掉协议
    x = x.replace(/[/#?].*$/, ''); // 去掉路径
    x = x.replace(/^\*\./, ''); // *.example.com -> example.com
    x = x.replace(/:\d+$/, ''); // 去掉端口
    return x;
  }

  function hostMatches(host, list) {
    const h = String(host || '').toLowerCase();
    if (!h) return false;
    return list.some((raw) => {
      const p = normalizePattern(raw);
      if (!p) return false;
      if (p.startsWith('re:')) {
        try {
          return new RegExp(p.slice(3)).test(h);
        } catch (_) {
          return false;
        }
      }
      return h === p || h.endsWith('.' + p);
    });
  }

  /** 当前站点是否允许放大 */
  function siteAllowed(settings, host) {
    if (settings.siteMode === 'all') return true;
    const listed = hostMatches(host, settings.siteList);
    return settings.siteMode === 'whitelist' ? listed : !listed;
  }

  function get(cb) {
    try {
      chrome.storage.sync.get(KEY, (data) => {
        if (chrome.runtime && chrome.runtime.lastError) return cb(sanitize(null));
        cb(sanitize(data && data[KEY]));
      });
    } catch (_) {
      cb(sanitize(null));
    }
  }

  function set(partial, cb) {
    get((cur) => {
      const next = sanitize(Object.assign({}, cur, partial));
      try {
        chrome.storage.sync.set({ [KEY]: next }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            /* ignore */
          }
          if (cb) cb(next);
        });
      } catch (_) {
        if (cb) cb(next);
      }
    });
  }

  // 兼容多个上下文（content script 用 window，options/popup 也是 window）
  const api = {
    KEY,
    MODIFIERS,
    DEFAULTS: FALLBACK,
    sanitize,
    normalizePattern,
    hostMatches,
    siteAllowed,
    get,
    set,
  };
  if (typeof window !== 'undefined') window.MagSettings = api;
  if (typeof self !== 'undefined') self.MagSettings = api;
})();
