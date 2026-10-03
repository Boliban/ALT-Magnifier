/* 临时验证：真实无头 Edge 里，后台 service worker 与内容脚本能否正常应答
 * 通过 CDP 在**后台 service worker** 的执行上下文里直接调用 chrome.tabs.sendMessage，
 * 这样能把「后台没起来」和「内容脚本没应答」两种情况彻底分开。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXT_DIR = path.resolve(import.meta.dirname, '..');
const HTTP_PORT = 8171;
const CDP_PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<html><body><h1>probe</h1><p>hello</p></body></html>');
});
await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const profile = mkdtempSync(path.join(tmpdir(), 'altmag-sw-'));
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--load-extension=' + EXT_DIR,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (!m.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  send(method, params = {}, sid) {
    const id = ++this.id;
    const payload = { id, method, params };
    const s = sid === undefined ? this.sessionId : sid;
    if (s) payload.sessionId = s;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('timeout ' + method));
        }
      }, 8000);
    });
  }
  sendBrowser(m, p = {}) {
    return this.send(m, p, null);
  }
}

const guarded = async (p, ms, label) =>
  Promise.race([
    p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e && e.message) })),
    new Promise((r) => setTimeout(() => r({ ok: false, err: label + ' 超时' }), ms)),
  ]);

try {
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
      if (r.ok) ver = await r.json();
    } catch (_) {}
    if (!ver) await sleep(250);
  }
  if (!ver) throw new Error('Edge 没起来');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  // 找出我们扩展的 service worker（url 以 background.js 结尾的那个）
  let swTarget = null;
  for (let i = 0; i < 40 && !swTarget; i++) {
    const { targetInfos } = await cdp.sendBrowser('Target.getTargets');
    swTarget = targetInfos.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url));
    if (!swTarget) await sleep(250);
  }
  console.log('我们的 service worker: ' + (swTarget ? swTarget.url : '✗ 没有起来！'));
  if (!swTarget) throw new Error('service worker 没有注册');

  const { sessionId: swSid } = await cdp.sendBrowser('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  const swEval = async (expr) => {
    const r = await guarded(cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, swSid), 8000, 'sw-eval');
    if (!r.ok) return { __timeout: r.err };
    if (r.v.exceptionDetails) return { __err: JSON.stringify(r.v.exceptionDetails.exception) };
    return r.v.result.value;
  };

  console.log('\n[A] service worker 自检：manifest / 权限 / 监听器');
  console.log('    manifest version = ' + JSON.stringify(await swEval('chrome.runtime.getManifest().version')));
  console.log('    permissions      = ' + JSON.stringify(await swEval('JSON.stringify(chrome.runtime.getManifest().permissions)')));
  console.log('    MagSettings 已加载 = ' + JSON.stringify(await swEval('typeof MagSettings')));
  console.log('    storage.session 可用 = ' + JSON.stringify(await swEval('typeof chrome.storage.session')));

  console.log('\n[B] 打开一个普通网页，然后从 service worker 侧发消息给内容脚本');
  const { targetId } = await cdp.sendBrowser('Target.createTarget', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' });
  await sleep(2000);

  const ping = await swEval(`(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${HTTP_PORT}/*' });
    if (!tabs.length) return { step: 'query', err: '查不到标签页', allUrls: (await chrome.tabs.query({})).map(t => t.url) };
    const tab = tabs[0];
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'alt-magnifier:ping' });
      return { step: 'ping-ok', tabId: tab.id, reply };
    } catch (e) {
      return { step: 'ping-fail', tabId: tab.id, tabUrl: tab.url, err: String(e && e.message) };
    }
  })()`);
  console.log('    ' + JSON.stringify(ping, null, 2).replace(/\n/g, '\n    '));

  console.log('\n[C] 从 service worker 侧调用 toggle（与面板「强制开关」完全同一条路径）');
  const toggle = await swEval(`(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${HTTP_PORT}/*' });
    if (!tabs.length) return { err: 'no tab' };
    try {
      const reply = await chrome.tabs.sendMessage(tabs[0].id, { type: 'alt-magnifier:toggle' });
      return { ok: true, reply };
    } catch (e) {
      return { ok: false, err: String(e && e.message) };
    }
  })()`);
  console.log('    ' + JSON.stringify(toggle));

  const { sessionId: pgSid } = await cdp.sendBrowser('Target.attachToTarget', { targetId, flatten: true });
  const pgEval = async (expr) => {
    const r = await guarded(cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, pgSid), 6000, 'page-eval');
    if (!r.ok) return { __timeout: r.err };
    return r.v.result.value;
  };
  console.log('    页面根元素 transform = ' + JSON.stringify(await pgEval('getComputedStyle(document.documentElement).transform')));
  console.log('    页面是否存在 HUD    = ' + JSON.stringify(await pgEval('!!document.getElementById("alt-magnifier-hud")')));

  console.log('\n[D] 从 service worker 侧调用 dump');
  const dump = await swEval(`(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${HTTP_PORT}/*' });
    try {
      return await chrome.tabs.sendMessage(tabs[0].id, { type: 'alt-magnifier:dump' });
    } catch (e) { return { err: String(e && e.message) }; }
  })()`);
  console.log('    ' + JSON.stringify(dump).slice(0, 400));
} catch (err) {
  console.log('EXCEPTION: ' + (err && err.stack ? err.stack : err));
} finally {
  child.kill();
  srv.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch (_) {}
}
