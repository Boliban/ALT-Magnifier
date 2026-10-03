/* ALT Magnifier — 核心数学单测
 *
 * 运行：node tools/test-math.mjs
 *
 * 模拟一个滚动容器（scrollWidth/scrollHeight 会随倍率线性放大，这正是浏览器
 * 对根元素带 transform 时的真实行为），然后反复执行「滚轮 -> 反解滚动位置」，
 * 检查锚点下的那个文档点是否始终钉在同一个屏幕像素上。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../src/math.js');

const STEP = 1.12;
const MIN = 1;
const MAX = 32;

let failures = 0;
let checks = 0;

function ok(cond, label, detail) {
  checks++;
  if (cond) {
    console.log('  ✓ ' + label);
  } else {
    failures++;
    console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
  }
}

/** 模拟一个真实页面：文档 3000x9000（未缩放），视口 1280x800 */
function makeWorld() {
  return {
    docW: 3000,
    docH: 9000,
    vw: 1280,
    vh: 800,
    k: 1,
    sx: 0,
    sy: 0,
    maxScroll() {
      // 根元素带 transform: scale(k) 时，滚动范围按 k 线性放大
      return {
        x: Math.max(0, this.docW * this.k - this.vw),
        y: Math.max(0, this.docH * this.k - this.vh),
      };
    },
  };
}

/** 模拟一次「滚轮放大」；返回锚点下的文档坐标在屏幕上的落点 */
function wheel(w, dir, ax, ay) {
  const m = w.maxScroll();
  const dx = M.docPoint(w.k, w.sx, ax);
  const dy = M.docPoint(w.k, w.sy, ay);
  const nk = M.nextScale(w.k, dir, STEP, MIN, MAX);
  w.k = nk;
  const m2 = w.maxScroll();
  w.sx = M.scrollFor(dx, nk, ax, m2.x);
  w.sy = M.scrollFor(dy, nk, ay, m2.y);
  void m;
  // 落点：文档点 d 在新倍率下出现在屏幕的哪个位置
  return { x: dx * nk - w.sx, y: dy * nk - w.sy };
}

console.log('\n[1] 连续放大 40 格，锚点必须始终不漂（中部锚点）');
{
  const w = makeWorld();
  const ax = 640;
  const ay = 400;
  w.sx = 500;
  w.sy = 1200;
  const anchorDoc = { x: M.docPoint(1, w.sx, ax), y: M.docPoint(1, w.sy, ay) };
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    const p = wheel(w, +1, ax, ay);
    worst = Math.max(worst, Math.abs(p.x - ax), Math.abs(p.y - ay));
  }
  ok(w.k === MAX, '倍率被钳制在最大值 ' + MAX + '（实测 ' + w.k + '）');
  ok(worst <= 1.0, '锚点最大漂移 ' + worst.toFixed(3) + 'px ≤ 1px（取整带来的固有误差）', 'worst=' + worst);
  const back = { x: M.docPoint(w.k, w.sx, ax), y: M.docPoint(w.k, w.sy, ay) };
  ok(
    Math.abs(back.x - anchorDoc.x) < 0.01 && Math.abs(back.y - anchorDoc.y) < 0.01,
    '第 40 格时锚点下的文档坐标与初始一致（无累计误差）',
    'Δ=(' + (back.x - anchorDoc.x).toFixed(6) + ', ' + (back.y - anchorDoc.y).toFixed(6) + ')'
  );
}

console.log('\n[2] 放大后又缩小回去，必须回到原滚动位置');
{
  const w = makeWorld();
  const ax = 300;
  const ay = 200;
  w.sx = 777;
  w.sy = 3333;
  const s0 = { x: w.sx, y: w.sy };
  for (let i = 0; i < 25; i++) wheel(w, +1, ax, ay);
  for (let i = 0; i < 25; i++) wheel(w, -1, ax, ay);
  ok(w.k === 1, '倍率回到 1（实测 ' + w.k + '）');
  const err = Math.hypot(w.sx - s0.x, w.sy - s0.y);
  ok(err <= 2, '滚动位置回到原位，累计误差 ' + err.toFixed(2) + 'px ≤ 2px', 'err=' + err);
}

console.log('\n[3] 锚点贴边 / 贴角（文档边界）时不得出现 NaN 或越界');
{
  const w = makeWorld();
  for (const [ax, ay] of [
    [0, 0],
    [1279, 799],
    [0, 799],
    [1279, 0],
  ]) {
    w.k = 1;
    w.sx = 0;
    w.sy = 0;
    let bad = null;
    for (let i = 0; i < 30; i++) {
      const p = wheel(w, +1, ax, ay);
      if (!isFinite(p.x) || !isFinite(p.y)) bad = 'NaN 出现在第 ' + i + ' 格';
    }
    const m = w.maxScroll();
    if (w.sx < 0 || w.sy < 0 || w.sx > m.x || w.sy > m.y) bad = '滚动越界 ' + w.sx + ',' + w.sy;
    ok(!bad, '角落锚点 (' + ax + ',' + ay + ') 全程有限且不越界', bad || '');
  }
}

console.log('\n[4] 倍率钳制：不会越过下限/上限，也不会出现负倍率');
{
  let k = 1;
  for (let i = 0; i < 50; i++) k = M.nextScale(k, -1, STEP, MIN, MAX);
  ok(k === MIN, '连续缩小后停在 ' + MIN + '（实测 ' + k + '）');
  for (let i = 0; i < 80; i++) k = M.nextScale(k, +1, STEP, MIN, MAX);
  ok(k === MAX, '连续放大后停在 ' + MAX + '（实测 ' + k + '）');
  ok(M.nextScale(1, +1, 1.12, 0.5, 0.25) <= 0.5, 'min>max 时也不会越界');
}

console.log('\n[5] 32 倍下的滚动几何：页面每个角落都还能到达');
{
  const w = makeWorld();
  w.k = 32;
  const m = w.maxScroll();
  ok(m.x === 3000 * 32 - 1280 && m.y === 9000 * 32 - 800, '滚动范围按倍率线性放大');
  const last = { x: 2999, y: 8999 };
  const sx = M.scrollFor(last.x, 32, 10, m.x);
  const sy = M.scrollFor(last.y, 32, 10, m.y);
  ok(sx === m.x && sy === m.y, '文档末尾点可被滚到（右下角可达）');
}

console.log('\n[6] 退出放大：把放大态的视口换算回未缩放滚动位置');
{
  const w = makeWorld();
  const ax = 640;
  const ay = 400;
  w.sx = 1000;
  w.sy = 2000;
  for (let i = 0; i < 20; i++) wheel(w, +1, ax, ay);
  const m = w.maxScroll();
  const nx = M.unscaledScroll(w.k, w.sx, ax);
  const ny = M.unscaledScroll(w.k, w.sy, ay);
  const cl = {
    x: Math.max(0, Math.min(nx, Math.max(0, w.docW - w.vw))),
    y: Math.max(0, Math.min(ny, Math.max(0, w.docH - w.vh))),
  };
  ok(isFinite(cl.x) && isFinite(cl.y), '换算结果有限');
  ok(cl.x >= 0 && cl.y >= 0 && cl.x <= 1720 && cl.y <= 8200, '换算结果在合法滚动范围内 (' + cl.x + ', ' + cl.y + ')');
  void m;
}

console.log('\n' + (failures ? '✗ ' + failures + '/' + checks + ' 项失败' : '✓ 全部 ' + checks + ' 项通过') + '\n');
process.exit(failures ? 1 : 0);
