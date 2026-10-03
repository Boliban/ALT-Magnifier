/* ALT Magnifier — 核心数学（纯函数，无 DOM 依赖）
 * ---------------------------------------------------------------------------
 * 抽出来的唯一目的：让 tools/test-math.mjs 能在 Node 里直接验证「零漂移」。
 * 浏览器里的实现与这里逐字对应，改任何一边都要跑一次 `node tools/test-math.mjs`。
 *
 * 约定：
 *   k       当前倍率（纯 CSS scale，布局空间）
 *   a       锚点，视口坐标（clientX / clientY）
 *   scroll  滚动位置（layout 像素）
 *   doc     「未缩放文档坐标」：doc = (scroll + a) / k
 *           也就是这个屏幕像素下面究竟是页面的哪一点。
 *
 * 关键：每次都用 doc 重新算 scroll，而不是在当前 scroll 上做增量，
 *       因此任意次缩放都不会累积误差。
 */
'use strict';

(function () {
  const clamp = (v, lo, hi) => (lo <= hi ? Math.min(hi, Math.max(lo, v)) : v);

  /** 屏幕上 (a) 那一点对应的文档坐标 */
  function docPoint(k, scroll, a) {
    return (scroll + a) / k;
  }

  /** 要让文档坐标 d 重新落在屏幕 a 上，滚动位置应该是多少
   *  注意：这里**故意不取整**。取整会在每一格引入 0.5px 的锚点误差，
   *  连续滚 40 格就会累积成可见的漂移。滚动值用小数是安全的：
   *  Chromium 在绘制时会把滚动后的合成层对齐到整数设备像素，
   *  小数滚动量不会让文字发虚。 */
  function scrollFor(doc, k, a, maxScroll) {
    const raw = doc * k - a;
    const v = isFinite(raw) ? raw : 0;
    if (maxScroll === undefined || maxScroll === null || !isFinite(maxScroll)) return v;
    return clamp(v, 0, Math.max(0, maxScroll));
  }

  /** 单步滚轮后的目标倍率
   *  末尾的吸附是为了消掉浮点残留（1 / 1.12 * 1.12 严格等于 1 在浮点下不成立），
   *  否则「缩小回 1 倍」会停在 1.0000000000000009，退出判定就要靠容差去兜。 */
  function nextScale(cur, dir, step, min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const factor = dir > 0 ? step : 1 / step;
    const v = clamp(cur * factor, lo, hi);
    if (Math.abs(v - lo) < 1e-9) return lo;
    if (Math.abs(v - hi) < 1e-9) return hi;
    return v;
  }

  /** Alt 模式退出时的落点：把放大态下的视口坐标换算回未缩放的滚动位置 */
  function unscaledScroll(k, scroll, a) {
    return (scroll + a) / k - a;
  }

  const api = { clamp, docPoint, scrollFor, nextScale, unscaledScroll };
  if (typeof window !== 'undefined') window.MagMath = api;
  if (typeof self !== 'undefined') self.MagMath = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
