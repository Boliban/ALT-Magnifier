/* ALT Magnifier — 漂移检测（内容脚本，运行在扩展的隔离世界里）
 * ---------------------------------------------------------------------------
 * 目的：不靠肉眼，用几何关系证明「放大后元素位置有没有变」。
 *
 * 数学：
 *   若整页真的被当成一张图片绕视口锚点 a 缩放 k 倍，那么任意元素放大前的
 *   视口坐标 p 与放大后的 p' 必须满足仿射关系
 *       p' = a + k * (p - a) = k * p + c,   c = a * (1 - k)
 *   反过来：只要能把 (k, c) 解出来并验证**所有**元素都落在同一条直线上，
 *   就等于证明了「零位移」。而 (k, c) 可以用元素两两之间的距离比来解，
 *   完全不需要相信扩展自己报出来的数字：
 *       k = Δp' / Δp    （取大量远距离元素对的中位数，抗个别异常值）
 *       c = median(p' - k * p)
 *   于是每个元素的残差 r = p' - (k*p + c) 就是它的真实位移（像素）。
 *
 * 流程：
 *   1. 按下触发键的瞬间（还没放大）采样所有参考元素的 rect
 *   2. 记录滚动时鼠标位置（锚点候选，仅用于展示）
 *   3. 停手后重新采样，按上面的关系逐元素核对，分类打印违规清单
 *
 * 脚本运行在隔离世界，页面无法伪造这些读数。
 */
'use strict';

(function () {
  if (window.__altMagDiagnoseLoaded) return;
  window.__altMagDiagnoseLoaded = true;

  const PX_TOL = 1.5; // 位移判定容差（像素）
  const SIZE_TOL_REL = 0.02; // 尺寸比例容差

  const SELECTOR =
    '[data-mag-test], h1, h2, h3, p, li, img, svg, canvas, iframe, video, table, header, footer, aside, button, a';

  let armed = false;
  let samples = [];
  let pointer = null;
  let wheelSeen = false;
  let stopTimer = 0;

  const now = () => performance.now();

  function capture() {
    const list = document.querySelectorAll(SELECTOR);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.id === 'alt-magnifier-hud' || el.id === 'mag-test-panel') continue;
      if (el.tagName === 'IFRAME') continue; // iframe 内部由子文档单独核对
      let r;
      let cs;
      try {
        r = el.getBoundingClientRect();
        cs = getComputedStyle(el);
      } catch (_) {
        continue;
      }
      if (!r.width || !r.height) continue;
      out.push({
        el,
        name: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''),
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        pos: cs.position,
        bgAttach: cs.backgroundAttachment,
      });
    }
    return out;
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** 用「距离足够远」的元素对解 k，中位数抗异常值 */
  function solveK(before, after, axis) {
    const key = axis === 'x' ? 'x' : 'y';
    const idx = before.map((b, i) => i).filter((i) => after[i]);
    idx.sort((a, b) => before[a][key] - before[b][key]);
    if (idx.length < 4) return NaN;
    const ratios = [];
    const picks = Math.min(120, Math.floor(idx.length / 2));
    for (let n = 1; n <= picks; n++) {
      const i = idx[0];
      const j = idx[Math.min(idx.length - 1, Math.floor((n * (idx.length - 1)) / picks))];
      const dp = before[j][key] - before[i][key];
      const dp2 = after[j][key] - after[i][key];
      if (Math.abs(dp) > 60) ratios.push(dp2 / dp);
    }
    return median(ratios);
  }

  function analyze(after) {
    const pairs = [];
    for (let i = 0; i < samples.length; i++) {
      if (after[i]) pairs.push([samples[i], after[i]]);
    }
    if (pairs.length < 4) return null;

    const before = pairs.map((p) => p[0]);
    const aft = pairs.map((p) => p[1]);

    let kx = solveK(before, aft, 'x');
    let ky = solveK(before, aft, 'y');
    if (!isFinite(kx)) kx = ky;
    if (!isFinite(ky)) ky = kx;
    const k = (kx + ky) / 2;

    const cx = median(before.map((b, i) => aft[i].x - kx * b.x));
    const cy = median(before.map((b, i) => aft[i].y - ky * b.y));
    const ax = kx !== 1 ? cx / (1 - kx) : NaN;
    const ay = ky !== 1 ? cy / (1 - ky) : NaN;

    const ok = [];
    const drift = [];
    const warp = [];
    for (let i = 0; i < before.length; i++) {
      const b = before[i];
      const n = aft[i];
      const errX = n.x - (kx * b.x + cx);
      const errY = n.y - (ky * b.y + cy);
      const err = Math.hypot(errX, errY);
      const expW = b.w * kx;
      const expH = b.h * ky;
      const sizeErr = Math.max(Math.abs(n.w - expW), Math.abs(n.h - expH));
      const rec = {
        name: b.name,
        pos: b.pos,
        bgAttach: b.bgAttach,
        err,
        errX,
        errY,
        sizeErr,
        w1: b.w,
        w2: n.w,
        expW,
        el: b.el.isConnected ? b.el : null,
      };
      if (err <= PX_TOL && sizeErr <= Math.max(PX_TOL, expW * SIZE_TOL_REL)) ok.push(rec);
      else if (sizeErr > PX_TOL && err <= PX_TOL * 2) warp.push(rec);
      else drift.push(rec);
    }
    return { k, kx, ky, ax, ay, ok, drift, warp, total: before.length };
  }

  function fmt(n) {
    if (!isFinite(n)) return 'n/a';
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function report(res) {
    const lines = [];
    lines.push('[ALT Magnifier 检测] 实测倍率 k = ' + fmt(res.k) + '  (kx=' + fmt(res.kx) + ', ky=' + fmt(res.ky) + ')');
    if (isFinite(res.ax)) lines.push('反解锚点 ≈ (' + fmt(res.ax) + ', ' + fmt(res.ay) + ')  鼠标记录锚点 ≈ (' + fmt(pointer ? pointer.x : NaN) + ', ' + fmt(pointer ? pointer.y : NaN) + ')');
    lines.push('参考元素 ' + res.total + ' 个｜完全符合整体缩放 ' + res.ok.length + ' 个');

    if (res.drift.length) {
      lines.push('—— 真实位移（应为 0，非 0 即 bug）共 ' + res.drift.length + ' 个 ——');
      res.drift
        .sort((a, b) => b.err - a.err)
        .slice(0, 30)
        .forEach((r) => {
          lines.push('  ' + r.name + '  [' + r.pos + ']  位移 ' + fmt(r.err) + 'px  (Δx=' + fmt(r.errX) + ', Δy=' + fmt(r.errY) + ')');
        });
    }
    if (res.warp.length) {
      lines.push('—— 尺寸不符（元素自身在改尺寸，多为站点 JS 或动画）共 ' + res.warp.length + ' 个 ——');
      res.warp.slice(0, 20).forEach((r) => {
        lines.push('  ' + r.name + '  ' + fmt(r.w1) + ' → ' + fmt(r.w2) + ' px（期望 ' + fmt(r.expW) + '）');
      });
    }
    const bgFixed = samples.filter((s) => s.bgAttach && s.bgAttach.indexOf('fixed') >= 0).length;
    if (bgFixed) lines.push('（' + bgFixed + ' 个 background-attachment:fixed 元素由定点修复单独处理，不计入上面的比例核对）');
    if (!res.drift.length) lines.push('✓ 位移检查通过：页面确实是绕锚点整体缩放的。');
    lines.push('完整结果对象：window.__magReport');

    const text = lines.join('\n');
    console.log(text);
    window.__magReport = res;
    return text;
  }

  function finish() {
    stopTimer = 0;
    if (!armed || !samples.length) return;
    armed = false;
    const after = capture();
    if (after.length !== samples.length) {
      // 页面在放大期间增删了节点，按索引比对会失真：按元素身份重采样
      const map = new Map(after.map((s) => [s.el, s]));
      let missing = 0;
      const rebuilt = samples.map((s) => {
        const hit = map.get(s.el);
        if (!hit) missing++;
        return hit || null;
      });
      if (missing > samples.length * 0.2) {
        console.log('[ALT Magnifier 检测] 放大期间页面结构变化过大（' + missing + ' 个元素消失），已跳过本次比对。');
        return;
      }
      const res = analyze(rebuilt);
      if (res) report(res);
      return;
    }
    const res = analyze(after);
    if (res) report(res);
  }

  function onKeyDown(e) {
    if (!e.isTrusted) return;
    if (e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift') return;
    if (armed) return;
    armed = true;
    pointer = null;
    wheelSeen = false;
    samples = capture();
  }

  function onWheel(e) {
    if (!e.isTrusted || !armed) return;
    if (!wheelSeen) {
      wheelSeen = true;
      pointer = { x: e.clientX, y: e.clientY };
    }
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(finish, 350);
  }

  function onKeyUp() {
    if (!armed) return;
    if (wheelSeen) {
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(finish, 120);
    } else {
      armed = false;
    }
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });

  // 控制台手动入口
  window.__magTest = {
    baseline(x, y) {
      armed = true;
      wheelSeen = true;
      pointer = { x: x == null ? window.innerWidth / 2 : x, y: y == null ? window.innerHeight / 2 : y };
      samples = capture();
      return samples.length + ' 个参考元素已采样，锚点 (' + fmt(pointer.x) + ', ' + fmt(pointer.y) + ')';
    },
    check: finish,
    get armed() {
      return armed;
    },
  };
})();
