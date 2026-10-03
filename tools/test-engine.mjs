/* ALT Magnifier — 引擎单元测试（Node，用最小 DOM 桩真实加载扩展代码）
 *
 * 运行：node tools/test-engine.mjs
 *
 * 这里不是「重写一遍逻辑再测」，而是把 src/settings.js、src/math.js、src/hud.js、
 * src/magnifier.js 原样执行进一个最小 DOM 环境，然后：
 *   1. 直接调用消息监听器（ping / dump / toggle / 未知类型）
 *      —— 用户遇到的 "message port closed before a response was received"
 *         就是这里某个分支抛异常、没走到 sendResponse 导致的
 *   2. 验证「打开 → 写入 transform → 关闭 → 精确还原」的完整闭环
 *   3. 验证锚点来自鼠标位置，而不是被键盘事件覆盖成屏幕中心
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
let failures = 0;
let checks = 0;
const ok = (cond, label, detail) => {
  checks++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (!cond && detail ? '  → ' + detail : ''));
  if (!cond) failures++;
};

/* ------------------------------------------------------------ 最小 DOM 桩 */
function makeStyle() {
  const map = new Map();
  return {
    __map: map,
    getPropertyValue: (p) => (map.has(p) ? map.get(p).v : ''),
    getPropertyPriority: (p) => (map.has(p) ? map.get(p).p : ''),
    setProperty: (p, v, pr) => map.set(p, { v: String(v), p: pr || '' }),
    removeProperty: (p) => map.delete(p),
    get cssText() {
      return '';
    },
    set cssText(_v) {},
  };
}

function makeEl(tag, id) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    style: makeStyle(),
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    },
    attachShadow() {
      const sh = makeEl('shadow');
      sh.getElementById = () => null;
      return sh;
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    getContext: () => null,
    isConnected: true,
    parentNode: null,
  };
}

let currentK = 1;
const htmlEl = makeEl('html', 'root');
const scrollerEl = makeEl('html', 'scroller');
scrollerEl.scrollLeft = 0;
scrollerEl.scrollTop = 0;
for (const [prop, val] of [
  ['scrollWidth', () => Math.round(3000 * currentK)],
  ['clientWidth', () => 1280],
  ['scrollHeight', () => Math.round(9000 * currentK)],
  ['clientHeight', () => 800],
]) {
  Object.defineProperty(scrollerEl, prop, { get: val, configurable: true });
}

const documentStub = {
  documentElement: htmlEl,
  body: makeEl('body'),
  scrollingElement: scrollerEl,
  head: makeEl('head'),
  createElement: (t) => makeEl(t),
  createTextNode: () => ({}),
  getElementById: () => null,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

/* --------------------------------------------------------------- 沙箱 */
const winListeners = [];
const msgListeners = [];
const storageListeners = [];

const sandbox = {
  // 事件目标：sandbox 自己就是 window
  addEventListener(type, fn) {
    winListeners.push({ type, fn });
  },
  removeEventListener(type, fn) {
    const i = winListeners.findIndex((x) => x.type === type && x.fn === fn);
    if (i >= 0) winListeners.splice(i, 1);
  },
  requestAnimationFrame(fn) {
    return setTimeout(() => fn(performance.now()), 6);
  },
  cancelAnimationFrame(id) {
    clearTimeout(id);
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,

  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  visualViewport: null,

  document: documentStub,
  location: { href: 'https://example.com/page', hostname: 'example.com', search: '', protocol: 'https:' },
  navigator: { userAgent: 'node-test' },
  performance,
  console,
  localStorage: { length: 0 },

  chrome: {
    runtime: {
      lastError: null,
      onMessage: {
        addListener: (fn) => msgListeners.push(fn),
      },
      sendMessage() {},
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    storage: {
      sync: {
        get: (_k, cb) => cb({}),
        set: (_o, cb) => cb && cb(),
      },
      local: { set: (_o, cb) => cb && cb(), get: (_k, cb) => cb({}), remove: (_k, cb) => cb && cb() },
      session: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
  },

  getComputedStyle: () => ({ backgroundAttachment: 'scroll', position: 'static', transform: 'none' }),

  Object,
  Math,
  JSON,
  Error,
  TypeError,
  RegExp,
  String,
  Number,
  Boolean,
  Array,
  Map,
  Set,
  Date,
  isFinite,
  isNaN,
  parseFloat,
  parseInt,
  encodeURIComponent,
  decodeURIComponent,
};

sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.top = sandbox;

const NAMES = Object.keys(sandbox);

function load(file) {
  const code = readFileSync(path.join(EXT_DIR, file), 'utf8');
  const fn = new Function(...NAMES, code);
  fn(...NAMES.map((n) => sandbox[n]));
}

console.log('\n加载扩展源码到沙箱…');
for (const f of ['src/settings.js', 'src/math.js', 'src/hud.js', 'src/magnifier.js']) {
  try {
    load(f);
    console.log('  ✓ ' + f);
    checks++;
  } catch (err) {
    console.log('  ✗ ' + f + ' 加载失败: ' + ((err && err.stack) || err));
    checks++;
    failures++;
  }
}

const engine = sandbox.__altMagnifier;

console.log('\n【1】引擎注册是否完整');
ok(!!engine, 'window.__altMagnifier 已暴露（说明 magnifier.js 跑到了最后一行）');
ok(!!sandbox.MagSettings, 'MagSettings 已挂上');
ok(!!sandbox.MagMath, 'MagMath 已挂上');
ok(!!sandbox.MagHUD, 'MagHUD 已挂上');
ok(msgListeners.length >= 1, '注册了消息监听器（' + msgListeners.length + ' 个）');
ok(
  winListeners.some((x) => x.type === 'wheel'),
  '平时挂上了 wheel 监听器（未放大时也必须在，否则第一次滚轮收不到）'
);

console.log('\n【2】消息监听器绝不能抛异常，且必须回包');
const send = (msg) => {
  let replied = null;
  let threw = null;
  const sender = { frameId: 0, tab: { id: 1, url: 'https://example.com/' } };
  for (const fn of msgListeners) {
    try {
      fn(msg, sender, (r) => {
        replied = r;
      });
    } catch (err) {
      threw = (err && err.stack) || String(err);
    }
  }
  return { replied, threw };
};

for (const type of ['alt-magnifier:ping', 'alt-magnifier:dump', 'alt-magnifier:toggle', 'alt-magnifier:unknown', 'other:message']) {
  const r = send({ type });
  ok(!r.threw, type + ' 不抛异常', r.threw);
  if (type.indexOf('alt-magnifier:') === 0) {
    ok(r.replied !== null, type + ' 有回包（不回包 = 端口关闭 = 用户看到的报错）');
  }
}

const dump = send({ type: 'alt-magnifier:dump' }).replied;
ok(dump && dump.ok === true, 'dump 返回 ok:true');
ok(dump && dump.enabled === true, 'dump.enabled = true（默认配置）');
ok(dump && dump.modifier === 'alt', 'dump.modifier = alt');
ok(dump && dump.siteOK === true, 'dump.siteOK = true（example.com 未被规则排除）');
ok(dump && dump.isTop === true, 'dump.isTop = true（顶层文档）');

console.log('\n【3】强制开关闭环：打开 → 写入 transform → 关闭 → 精确还原');
for (let i = 0; i < 4 && send({ type: 'alt-magnifier:dump' }).replied.active; i++) {
  send({ type: 'alt-magnifier:toggle' });
  await new Promise((r) => setTimeout(r, 15));
}
ok(!send({ type: 'alt-magnifier:dump' }).replied.active, '已收敛到「未放大」初始态');

const on = send({ type: 'alt-magnifier:toggle' }).replied;
ok(on && on.ok === true && on.active === true, '打开：active = true', JSON.stringify(on));
const trOn = htmlEl.style.getPropertyValue('transform');
ok(trOn.indexOf('scale') >= 0, '打开：根元素写入了 transform = ' + JSON.stringify(trOn), JSON.stringify([...htmlEl.style.__map.entries()]));
ok(htmlEl.style.getPropertyPriority('transform') === 'important', 'transform 带 important（压过站点自身样式）');
ok(htmlEl.style.getPropertyValue('transform-origin') === '0 0', 'transform-origin = 0 0（锚点数学的前提）');
ok(htmlEl.style.getPropertyValue('overflow-anchor') === 'none', 'overflow-anchor = none（防止浏览器自行补偿滚动）');

const off = send({ type: 'alt-magnifier:toggle' }).replied;
ok(off && off.active === false, '关闭：active = false', JSON.stringify(off));
ok(htmlEl.style.getPropertyValue('transform') === '', '关闭：transform 精确还原为空');
ok(htmlEl.style.getPropertyValue('transform-origin') === '', '关闭：transform-origin 也还原');
ok(htmlEl.style.getPropertyValue('overflow-anchor') === '', '关闭：overflow-anchor 也还原');

console.log('\n【4】Alt + 滚轮：锚点必须来自鼠标位置');
sandbox.__altMagnifierLoaded = false;
winListeners.length = 0;
load('src/magnifier.js');
const wheelFn = (winListeners.find((x) => x.type === 'wheel') || {}).fn;
ok(!!wheelFn, '重新加载后拿到 wheel 监听器');

let prevented = false;
let threw = null;
try {
  wheelFn({
    isTrusted: true,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    deltaY: -120,
    deltaX: 0,
    clientX: 317,
    clientY: 233,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  });
} catch (err) {
  threw = (err && err.stack) || String(err);
}
ok(!threw, 'Alt+滚轮 处理不抛异常', threw);
ok(prevented, 'Alt+滚轮 调用了 preventDefault（阻止页面自己滚动）');
const st = sandbox.__altMagnifier.state;
ok(st.active === true, 'Alt+滚轮 之后 active = true');
ok(st.anchor && st.anchor.x === 317 && st.anchor.y === 233, '锚点 = 鼠标位置 (317,233)', JSON.stringify(st.anchor));
ok(st.target > 1, '已经排队了一个 >1 的目标倍率（target=' + st.target + '）');

console.log('\n【5】未按触发键时，滚轮必须完全不干预');
sandbox.__altMagnifier.end();
await new Promise((r) => setTimeout(r, 20));
let prevented2 = false;
wheelFn({
  isTrusted: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  deltaY: -120,
  deltaX: 0,
  clientX: 100,
  clientY: 100,
  preventDefault: () => {
    prevented2 = true;
  },
  stopPropagation: () => {},
});
ok(!prevented2, '不按 Alt 时没有 preventDefault（页面正常滚动）');
ok(sandbox.__altMagnifier.active === false, '不按 Alt 时不会进入放大');

console.log('\n【6】键盘路径不能污染鼠标锚点');
const keyFn = (winListeners.find((x) => x.type === 'keydown') || {}).fn;
if (keyFn) {
  try {
    keyFn({ key: 'Alt', code: 'AltLeft', altKey: true, preventDefault() {}, repeat: false });
    ok(true, '按下 Alt 不抛异常');
  } catch (err) {
    ok(false, '按下 Alt 抛异常了', (err && err.message) || String(err));
  }
} else {
  ok(false, '找不到 keydown 监听器');
}
// 再跑一次滚轮，锚点必须仍然是鼠标位置（不能被 Alt 按键覆盖成屏幕中心）
sandbox.__altMagnifier.end();
await new Promise((r) => setTimeout(r, 20));
wheelFn({
  isTrusted: true,
  altKey: true,
  deltaY: -120,
  deltaX: 0,
  clientX: 42,
  clientY: 77,
  preventDefault() {},
  stopPropagation() {},
});
const st2 = sandbox.__altMagnifier.state;
ok(st2.anchor && st2.anchor.x === 42 && st2.anchor.y === 77, '按过 Alt 之后锚点仍是鼠标位置 (42,77)', JSON.stringify(st2.anchor));

console.log('\n' + (failures ? '✗ ' + failures + '/' + checks + ' 项失败' : '✓ 全部 ' + checks + ' 项通过') + '\n');
process.exit(failures ? 1 : 0);
