/* ALT Magnifier — 设置页里的核心数学自检
 *
 * 它不需要你动鼠标：直接对 src/math.js 的纯函数做断言，现场验证
 * 「锚点零漂移、倍率钳制、边界钳制、退出换算」这几条命门。
 * 逻辑与 tools/test-math.mjs 完全一致（那边是 CI 版，这边是给人看的版本）。
 */
'use strict';

(function () {
  const M = window.MagMath;
  const S = window.MagSettings;
  const btn = document.getElementById('selftest');
  const out = document.getElementById('selftest-out');
  if (!btn || !out || !M || !S) return;

  const lines = [];
  let pass = 0;
  let fail = 0;

  function check(cond, label, detail) {
    if (cond) {
      pass++;
      lines.push('  ✓ ' + label);
    } else {
      fail++;
      lines.push('  ✗ ' + label + (detail ? '   → ' + detail : ''));
    }
  }

  function run() {
    lines.length = 0;
    pass = 0;
    fail = 0;

    const STEP = 1.12;
    const MIN = 1;
    const MAX = 32;

    // 模拟一个 3000×9000 的文档，视口 1280×800
    const docW = 3000;
    const docH = 9000;
    const vw = 1280;
    const vh = 800;
    const maxScroll = (k) => ({ x: Math.max(0, docW * k - vw), y: Math.max(0, docH * k - vh) });

    lines.push('【1】连续放大 40 格：锚点必须纹丝不动');
    {
      const ax = 640;
      const ay = 420;
      let k = 1;
      let sx = 500;
      let sy = 1200;
      const d0 = { x: (sx + ax) / k, y: (sy + ay) / k };
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        const d = { x: M.docPoint(k, sx, ax), y: M.docPoint(k, sy, ay) };
        k = M.nextScale(k, +1, STEP, MIN, MAX);
        const m = maxScroll(k);
        sx = M.scrollFor(d.x, k, ax, m.x);
        sy = M.scrollFor(d.y, k, ay, m.y);
        worst = Math.max(worst, Math.abs(d.x * k - sx - ax), Math.abs(d.y * k - sy - ay));
      }
      check(k === MAX, '倍率停在 32（实测 ' + k + '）');
      check(worst < 0.001, '锚点最大漂移 ' + worst.toExponential(2) + 'px（零累计误差）');
      const dEnd = { x: M.docPoint(k, sx, ax), y: M.docPoint(k, sy, ay) };
      check(Math.abs(dEnd.x - d0.x) < 0.01 && Math.abs(dEnd.y - d0.y) < 0.01, '第 40 格时锚点下的文档坐标与初始一致');
    }

    lines.push('');
    lines.push('【2】放大后缩回 1 倍：必须回到原滚动位置');
    {
      const ax = 300;
      const ay = 200;
      let k = 1;
      let sx = 777;
      let sy = 3333;
      const s0 = { x: sx, y: sy };
      for (let i = 0; i < 25; i++) {
        const d = { x: M.docPoint(k, sx, ax), y: M.docPoint(k, sy, ay) };
        k = M.nextScale(k, +1, STEP, MIN, MAX);
        const m = maxScroll(k);
        sx = M.scrollFor(d.x, k, ax, m.x);
        sy = M.scrollFor(d.y, k, ay, m.y);
      }
      for (let i = 0; i < 25; i++) {
        const d = { x: M.docPoint(k, sx, ax), y: M.docPoint(k, sy, ay) };
        k = M.nextScale(k, -1, STEP, MIN, MAX);
        const m = maxScroll(k);
        sx = M.scrollFor(d.x, k, ax, m.x);
        sy = M.scrollFor(d.y, k, ay, m.y);
      }
      check(k === 1, '倍率精确回到 1（实测 ' + k + '）');
      check(Math.hypot(sx - s0.x, sy - s0.y) < 1e-6, '滚动位置精确复原（误差 ' + Math.hypot(sx - s0.x, sy - s0.y).toExponential(2) + 'px）');
    }

    lines.push('');
    lines.push('【3】锚点贴边 / 贴角：不出现 NaN、不越界');
    {
      let bad = '';
      [
        [0, 0],
        [1279, 799],
        [0, 799],
        [1279, 0],
      ].forEach(([ax, ay]) => {
        let k = 1;
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < 30; i++) {
          const d = { x: M.docPoint(k, sx, ax), y: M.docPoint(k, sy, ay) };
          k = M.nextScale(k, +1, STEP, MIN, MAX);
          const m = maxScroll(k);
          sx = M.scrollFor(d.x, k, ax, m.x);
          sy = M.scrollFor(d.y, k, ay, m.y);
          if (!isFinite(sx) || !isFinite(sy)) bad = '角点 (' + ax + ',' + ay + ') 出现 NaN';
        }
        const m = maxScroll(k);
        if (sx < -0.001 || sy < -0.001 || sx > m.x + 0.001 || sy > m.y + 0.001) bad = '角点 (' + ax + ',' + ay + ') 越界';
      });
      check(!bad, '四个角落锚点全程有限且不越界', bad);
    }

    lines.push('');
    lines.push('【4】倍率钳制与退出换算');
    {
      let k = 1;
      for (let i = 0; i < 60; i++) k = M.nextScale(k, -1, STEP, MIN, MAX);
      check(k === MIN, '连续缩小停在 1（实测 ' + k + '）');
      for (let i = 0; i < 90; i++) k = M.nextScale(k, +1, STEP, MIN, MAX);
      check(k === MAX, '连续放大停在 32（实测 ' + k + '）');
      check(M.nextScale(1, +1, 1.12, 0.5, 0.25) <= 0.5, 'min > max 的配置也不会越界');
      const back = M.unscaledScroll(6, 1234, 400);
      check(isFinite(back), '退出时的滚动换算有限（' + back.toFixed(2) + '）');
    }

    lines.push('');
    lines.push('【5】设置项清洗与站点规则');
    {
      const s = S.sanitize({ step: 99, min: -5, max: 999, modifier: 'bogus', settleDelay: -1, invert: 'x' });
      check(s.step === 2, 'step 被夹到合法上限 2（实测 ' + s.step + '）');
      check(s.max === 32, 'max 被夹到 32（实测 ' + s.max + '）');
      check(s.min === 0.25, 'min 被夹到 0.25（实测 ' + s.min + '）');
      check(s.modifier === 'alt', '非法触发键回落到 alt（实测 ' + s.modifier + '）');
      check(s.settleDelay === 0, 'settleDelay 被夹到 0（实测 ' + s.settleDelay + '）');
      check(s.invert === false, 'invert 非法值回落 false');
      check(S.hostMatches('www.bilibili.com', ['bilibili.com']), '子域匹配 bilibili.com');
      check(!S.hostMatches('notbilibili.com', ['bilibili.com']), '不做后缀误匹配（notbilibili.com 不命中）');
      check(S.hostMatches('a.example.com', ['*.example.com']), '通配写法 *.example.com 生效');
      check(
        S.siteAllowed(S.sanitize({ siteMode: 'blacklist', siteList: ['bilibili.com'] }), 'www.bilibili.com') === false,
        '黑名单站点被正确排除'
      );
      check(
        S.siteAllowed(S.sanitize({ siteMode: 'whitelist', siteList: ['zhihu.com'] }), 'www.bilibili.com') === false,
        '白名单外的站点不被放大'
      );
    }

    const head = fail
      ? '✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项'
      : '✓ 全部 ' + pass + ' 项通过 —— 核心数学没有问题';
    out.hidden = false;
    out.textContent = head + '\n\n' + lines.join('\n');
    out.className = 'selftest ' + (fail ? 'bad' : 'ok');
    console.log('[ALT Magnifier 自检]\n' + head + '\n' + lines.join('\n'));
  }

  btn.addEventListener('click', run);
})();
