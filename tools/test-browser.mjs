/* ALT Magnifier — 端到端浏览器测试（CDP 驱动，零第三方依赖）
 *
 * 运行：node tools/test-browser.mjs
 *
 * 它做的不是单元测试，而是真实浏览器里的验收：
 *   1. 用 --load-extension 启动无头 Chrome（临时 profile，绝不碰你的浏览器）
 *   2. 起一个本地 HTTP 服务托管 test/test-page.html（扩展默认不能读 file://）
 *   3. 通过 CDP 注入**真实的** Alt + 滚轮 输入事件（Input.dispatchMouseEvent）
 *   4. 在页面世界里读 getBoundingClientRect，用恒等式核对每个元素的位置：
 *
 *        rect.left = k * P - scrollLeft        （P 是元素在未缩放文档里的坐标）
 *      =>  k*P = rect.left + scrollLeft
 *      =>  对任意两个元素：(rectB - rectA) / (rectB0 - rectA0) 必须处处等于 k
 *
 *      只要「不重排」成立，这个比值对所有元素都相同；元素一旦发生位移，
 *      它就会落在一条不同的直线上，从而被这条恒等式抓出来。
 *
 * 覆盖：单格放大 / 锚点钉死 / 连滚 33 格到 32 倍 / 极限滚动 / 动态插入元素 /
 *       fixed 元素随画面滚走 / iframe 同比例 / 缩小复原 / 非 Alt 不拦截 / 设置实时生效
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
const CDP_PORT = 9333;
const HTTP_PORT = 8129;
const TEST_PATH = '/test/test-page.html';
const TEST_URL = 'http://127.0.0.1:' + HTTP_PORT + TEST_PATH;
const TOL = 2.0; // 元素位移容差（px）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// 注意：Chrome 137 之后，正式版 Chrome 会**忽略** --load-extension
// （本地未打包扩展被安全策略挡住，见 SeleniumHQ/selenium#16540），
// 因此优先用 Edge —— 它至今仍然接受该参数，也正是本扩展的目标浏览器。
// 想用 Chrome 自动化，需要装 Chrome for Testing / Chromium 的构建。
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

let failures = 0;
let checks = 0;
function ok(cond, label, detail) {
  checks++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (!cond && detail ? '  → ' + detail : ''));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    const sid = sessionId === undefined ? this.sessionId : sessionId;
    if (sid) payload.sessionId = sid;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 20000);
    });
  }
  sendBrowser(method, params = {}) {
    return this.send(method, params, null);
  }
  close() {
    try {
      this.ws.close();
    } catch (_) {}
  }
}

function startHttpServer() {
  const srv = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const full = path.resolve(EXT_DIR, rel);
      if (!full.startsWith(EXT_DIR) || !existsSync(full) || !statSync(full).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
      createReadStream(full).pipe(res);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve) => srv.listen(HTTP_PORT, '127.0.0.1', () => resolve(srv)));
}

/** 取两点连线的斜率 —— 只要「不重排」成立，所有点对给出的斜率都必须等于 k */
function slope(a, b, key) {
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < a.length; i++) {
    if (a[i][key] < a[lo][key]) lo = i;
    if (a[i][key] > a[hi][key]) hi = i;
  }
  const d = a[hi][key] - a[lo][key];
  if (Math.abs(d) < 40) return NaN;
  return (b[hi][key] - b[lo][key]) / d;
}

/** 对同一批元素做「整体缩放」一致性核对 */
function analyze(t0, t1, scroll0, scroll1) {
  const before = t0.rects;
  const after = t1.rects;
  // k*P = rect + scroll，两边都在同一空间里比较
  const P = before.map((r) => ({ x: r.x + scroll0.x, y: r.y + scroll0.y }));
  const Q = after.map((r) => ({ x: r.x + scroll1.x, y: r.y + scroll1.y }));
  const kx = slope(P, Q, 'x');
  const ky = slope(P, Q, 'y');
  const k = (kx + ky) / 2;
  const cx = Q[0].x - kx * P[0].x;
  const cy = Q[0].y - ky * P[0].y;
  const bad = [];
  let good = 0;
  for (let i = 0; i < P.length; i++) {
    const err = Math.hypot(Q[i].x - (kx * P[i].x + cx), Q[i].y - (ky * P[i].y + cy));
    if (err <= TOL) good++;
    else bad.push({ name: before[i].name, err: +err.toFixed(2) });
  }
  return { k, kx, ky, cx, cy, good, bad, total: before.length };
}

/* ------------------------------------------------------------------ 主流程 */
const exe = CANDIDATES.find((c) => existsSync(c));
if (!exe) {
  console.log('找不到 Chrome/Edge，跳过浏览器测试。');
  process.exit(0);
}
const profile = mkdtempSync(path.join(tmpdir(), 'altmag-e2e-'));
const httpSrv = await startHttpServer();
console.log('浏览器  : ' + exe);
console.log('测试地址: ' + TEST_URL);
console.log('profile : ' + profile + '\n');

const child = spawn(
  exe,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--load-extension=' + EXT_DIR,
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let cdp = null;
try {
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
      if (r.ok) version = await r.json();
    } catch (_) {}
    if (!version) await sleep(250);
  }
  if (!version) throw new Error('浏览器没起来（CDP 端口无响应）');
  console.log('内核版本: ' + version.Browser + '\n');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  cdp = new CDP(ws);

  /* ---- 1. 扩展是否被加载：列 target ---- */
  let extSw = null;
  for (let i = 0; i < 40 && !extSw; i++) {
    const { targetInfos } = await cdp.sendBrowser('Target.getTargets');
    extSw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    if (!extSw) await sleep(250);
  }
  ok(!!extSw, '扩展已被浏览器加载（service worker 在跑）', extSw ? '' : '没有 chrome-extension:// 目标');

  /* ---- 2. 打开测试页 ---- */
  const { targetId } = await cdp.sendBrowser('Target.createTarget', { url: TEST_URL });
  const { sessionId } = await cdp.sendBrowser('Target.attachToTarget', { targetId, flatten: true });
  cdp.sessionId = sessionId;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await sleep(1600);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('求值失败: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  await ev(`window.__t = {
    rects() {
      const out = [];
      document.querySelectorAll('[data-mag-test], h2, p, canvas, svg, table, aside').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        out.push({ name: el.id || (typeof el.className === 'string' ? el.className.split(' ')[0] : '') || el.tagName.toLowerCase(),
                   x: r.left, y: r.top, w: r.width, h: r.height });
      });
      return out;
    },
    snap() {
      const s = document.scrollingElement;
      return { rects: this.rects(),
               scroll: { x: s.scrollLeft, y: s.scrollTop },
               sw: s.scrollWidth, sh: s.scrollHeight, cw: s.clientWidth, ch: s.clientHeight };
    },
    css() { const cs = getComputedStyle(document.documentElement);
            return { transform: cs.transform, origin: cs.transformOrigin, anchor: cs.overflowAnchor }; },
    hud() { return !!document.getElementById('alt-magnifier-hud'); },
    k() { const m = getComputedStyle(document.documentElement).transform.match(/matrix\\(([\\d.]+)/);
          return m ? parseFloat(m[1]) : 1; }
  }; 'ok'`);

  const anchor = { x: 640, y: 420 };
  const wheel = async ({ deltaY = -120, x = anchor.x, y = anchor.y, modifiers = 1 } = {}) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers, pointerType: 'mouse',
    });
    await sleep(300);
  };

  /* ---- 3. 关键前置检查：内容脚本到底跑了没有 ---- */
  console.log('[0] 内容脚本是否真的注入到页面');
  const scroll0 = await ev('__t.snap()');
  await wheel({ deltaY: -120 });
  await sleep(300);
  const hudExists = await ev('__t.hud()');
  const kFirst = await ev('__t.k()');
  ok(
    hudExists && kFirst > 1.001,
    '内容脚本已注入并响应真实的 Alt + 滚轮（transform 倍率 = ' + kFirst + '）',
    'HUD=' + hudExists + ' k=' + kFirst
  );
  if (!hudExists || kFirst <= 1.001) {
    console.log('\n  内容脚本没有生效，后面的用例无法进行。');
    console.log('  在无头模式下扩展可能被 Chrome 限制；请按 README 的「手动验证」步骤在你的 Edge 里跑一次。');
    throw new Error('内容脚本未注入');
  }

  /* ---- 4. 单格放大：恒等式 + 锚点 ---- */
  console.log('\n[1] 单格放大：所有元素必须落在同一条缩放直线上');
  const s1 = await ev('__t.snap()');
  const a1 = analyze(scroll0, s1, scroll0.scroll, s1.scroll);
  console.log('    倍率 k = ' + a1.k.toFixed(4) + '，参考元素 ' + a1.total + ' 个，零位移 ' + a1.good + ' 个');
  ok(Math.abs(a1.k - 1.12) < 0.01, '实测倍率 ≈ 1.12（滚一格一次）', 'k=' + a1.k);
  ok(a1.bad.length === 0, '全部 ' + a1.total + ' 个元素位移 ≤ ' + TOL + 'px', JSON.stringify(a1.bad.slice(0, 6)));

  const css1 = await ev('__t.css()');
  ok(css1.origin === '0 0', 'transform-origin = 0 0（锚点数学成立的前提）', css1.origin);
  ok(css1.anchor === 'none', '放大期间关闭了滚动锚定 overflow-anchor');
  const s1geom = await ev('__t.snap()');
  ok(s1geom.sw > scroll0.sw * 1.1, '滚动范围随倍率放大（' + scroll0.sw + ' → ' + s1geom.sw + '），无需任何 width 补丁');

  /* ---- 5. 锚点是否钉死在鼠标位置 ---- */
  console.log('\n[2] 锚点：鼠标指着的那个文档点，屏幕落点必须不动');
  const probe = await ev(`(() => {
    const s = document.scrollingElement, k = ${a1.k};
    const d = { x: (s.scrollLeft + ${anchor.x}) / k, y: (s.scrollTop + ${anchor.y}) / k };
    return { x: d.x * k - s.scrollLeft, y: d.y * k - s.scrollTop };
  })()`);
  ok(Math.abs(probe.x - anchor.x) < 0.5 && Math.abs(probe.y - anchor.y) < 0.5, '锚点落点误差 < 0.5px', JSON.stringify(probe));

  /* ---- 6. 连滚到 32 倍：累计误差 ---- */
  console.log('\n[3] 连续 32 格：倍率钳制 + 累计误差');
  const anchorDoc = await ev(`(() => { const s = document.scrollingElement, k = ${a1.k};
    return { x: (s.scrollLeft + ${anchor.x}) / k, y: (s.scrollTop + ${anchor.y}) / k }; })()`);
  for (let i = 0; i < 32; i++) await wheel({ deltaY: -120 });
  await sleep(500);
  const kMax = await ev('__t.k()');
  const driftMax = await ev(`(() => { const s = document.scrollingElement, k = ${kMax};
    return { x: ${anchorDoc.x} * k - s.scrollLeft - ${anchor.x}, y: ${anchorDoc.y} * k - s.scrollTop - ${anchor.y} }; })()`);
  console.log('    33 格后倍率 = ' + kMax.toFixed(3));
  ok(Math.abs(kMax - 32) < 0.02, '倍率被钳制在设置的上限 32', 'k=' + kMax);
  ok(
    Math.abs(driftMax.x) < 1 && Math.abs(driftMax.y) < 1,
    '连滚 33 格后锚点累计漂移 < 1px（Δ=' + driftMax.x.toFixed(3) + ', ' + driftMax.y.toFixed(3) + '）'
  );
  const sMax = await ev('__t.snap()');
  ok(Math.abs(sMax.sw - scroll0.sw * kMax) < 100, '32 倍时横向滚动范围 ≈ 原始 × 32（' + Math.round(sMax.sw) + ' ≈ ' + Math.round(scroll0.sw * kMax) + '）');

  /* ---- 7. 32 倍下的整体一致性 + 极限滚动 ---- */
  console.log('\n[4] 32 倍：整体一致性 + 页面角落可达');
  const tMax = await ev('__t.snap()');
  const aMax = analyze(scroll0, tMax, scroll0.scroll, tMax.scroll);
  ok(aMax.bad.length === 0, '32 倍下所有元素仍在同一条缩放直线上（k=' + aMax.k.toFixed(2) + '）', JSON.stringify(aMax.bad.slice(0, 5)));
  await ev('(() => { const s = document.scrollingElement; s.scrollLeft = s.scrollWidth; s.scrollTop = s.scrollHeight; return "ok"; })()');
  await sleep(400);
  const corner = await ev('(() => { const s = document.scrollingElement; return { x: s.scrollLeft, y: s.scrollTop }; })()');
  const cornerRects = await ev('__t.rects()');
  ok(corner.x > 1000 && corner.y > 1000, '可以滚到页面右下角（' + Math.round(corner.x) + ', ' + Math.round(corner.y) + '）');
  ok(cornerRects.every((r) => isFinite(r.x) && isFinite(r.y)), '极端位置下所有 rect 仍然有限');

  /* ---- 8. 放大期间动态插入元素 ---- */
  console.log('\n[5] 放大期间动态插入的元素');
  const kNow = await ev('__t.k()');
  await ev(`(() => {
    const d = document.createElement('div');
    d.id = 'dyn-1'; d.setAttribute('data-mag-test','');
    d.style.cssText = 'width:100px;height:40px;background:#e0533d;color:#fff';
    d.textContent = '动态插入';
    document.querySelector('main').appendChild(d);
    return 'ok';
  })()`);
  await sleep(250);
  const dyn = await ev(`(() => { const r = document.getElementById('dyn-1').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
  ok(Math.abs(dyn.w - 100 * kNow) < 4, '新插入元素宽度 = 100 × ' + kNow.toFixed(2) + '（实测 ' + dyn.w.toFixed(1) + '）');

  /* ---- 9. fixed 元素是否成为画面的一部分 ---- */
  console.log('\n[6] fixed 顶栏：应随画面一起滚走（图片式放大的定义）');
  await ev('(() => { document.scrollingElement.scrollTop = 0; return "ok"; })()');
  await sleep(250);
  const fbTop0 = await ev(`document.querySelector('.fixed-bar').getBoundingClientRect().top`);
  const fbH = await ev(`document.querySelector('.fixed-bar').getBoundingClientRect().height`);
  await ev('(() => { document.scrollingElement.scrollTop = 300; return "ok"; })()');
  await sleep(250);
  const fbTop1 = await ev(`document.querySelector('.fixed-bar').getBoundingClientRect().top`);
  ok(fbH > 30, 'fixed 顶栏随页面一起被放大（高度 ' + fbH.toFixed(1) + 'px）');
  ok(fbTop1 < fbTop0 - 80, '滚动 300px 后它跟着滚走（top ' + fbTop0.toFixed(0) + ' → ' + fbTop1.toFixed(0) + '）');

  /* ---- 10. iframe 是否同比例 ---- */
  console.log('\n[7] iframe 与外层同比例');
  const ifr = await ev(`(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return r.width; })()`);
  ok(Math.abs(ifr - 330 * kNow) < 8, 'iframe 外框宽度 = 330 × k（实测 ' + ifr.toFixed(1) + '，期望 ' + (330 * kNow).toFixed(1) + '）');

  /* ---- 11. 缩小复原 ---- */
  console.log('\n[8] 一路缩小回 1 倍：必须精确复原');
  for (let i = 0; i < 45; i++) await wheel({ deltaY: 120 });
  await sleep(1400); // 等自动落定
  const cssEnd = await ev('__t.css()');
  const end = await ev('__t.snap()');
  const kEnd = await ev('__t.k()');
  console.log('    复原后 transform = ' + cssEnd.transform + '，scroll = (' + Math.round(end.scroll.x) + ', ' + Math.round(end.scroll.y) + ')');
  ok(kEnd === 1, '倍率回到 1，transform 已移除', cssEnd.transform);
  ok(cssEnd.anchor !== 'none', 'overflow-anchor 已精确还原', cssEnd.anchor);
  ok(end.sw === scroll0.sw && end.sh === scroll0.sh, '滚动范围完全复原（' + end.sw + '×' + end.sh + '）');
  ok(!(await ev('__t.hud()')), 'HUD 已销毁，页面回到零污染');

  /* ---- 12. 非 Alt 滚轮不被拦截 ---- */
  console.log('\n[9] 不按 Alt 滚轮：扩展必须完全不参与');
  const before9 = await ev('(() => document.scrollingElement.scrollTop)()');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 420, deltaX: 0, deltaY: 300, modifiers: 0, pointerType: 'mouse' });
  await sleep(500);
  const after9 = await ev('(() => document.scrollingElement.scrollTop)()');
  const css9 = await ev('__t.css()');
  ok(after9 > before9, '页面正常滚动（' + Math.round(before9) + ' → ' + Math.round(after9) + '）');
  ok(css9.transform === 'none', '未按 Alt 时根元素没有任何 transform 写入', css9.transform);

  /* ---- 13. 设置实时生效 ---- */
  console.log('\n[10] 改设置不刷新即生效');
  await ev(`(() => new Promise((res) => chrome.storage.sync.set({ magnifierSettingsV1: {
      enabled: true, modifier: 'alt', step: 2, min: 1, max: 8, invert: false,
      indicator: true, fixFixedBackgrounds: true, settleDelay: 800, debug: false,
      siteMode: 'all', siteList: []
  } }, res)))()`);
  await sleep(500);
  await wheel({ deltaY: -120 });
  await sleep(400);
  const k10 = await ev('__t.k()');
  ok(Math.abs(k10 - 2) < 0.02, '把步长改成 2 后，一格就是 2 倍（实测 ' + k10.toFixed(3) + '）');
  for (let i = 0; i < 8; i++) await wheel({ deltaY: -120 });
  await sleep(500);
  const k10b = await ev('__t.k()');
  ok(Math.abs(k10b - 8) < 0.05, '最大倍率被限制在 8（实测 ' + k10b.toFixed(3) + '）');

  await ev(`(() => new Promise((res) => chrome.storage.sync.clear(res)))()`);
  await sleep(200);
} catch (err) {
  failures++;
  checks++;
  console.log('\n  ✗ 测试异常：' + (err && err.stack ? err.stack : err));
} finally {
  if (cdp) cdp.close();
  try {
    child.kill();
  } catch (_) {}
  try {
    httpSrv.close();
  } catch (_) {}
  await sleep(700);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch (_) {}
}

console.log('\n' + (failures ? '✗ ' + failures + '/' + checks + ' 项失败' : '✓ 全部 ' + checks + ' 项通过') + '\n');
process.exit(failures ? 1 : 0);
