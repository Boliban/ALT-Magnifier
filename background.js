/* ALT Magnifier — MV3 service worker
 *
 * 两件事：
 *   1. 提供「自愈注入」：不依赖 manifest 里的声明式 content_scripts，
 *      由这里用 chrome.scripting.executeScript 主动注入引擎。
 *      在 Edge 上遇到过「清单、权限、开关都正常，但声明式内容脚本就是不执行」
 *      的情况，这条通道能绕过去。
 *   2. 把真实报错原样交出来。注入失败时不再猜，直接把浏览器的报错字符串
 *      交给工具栏面板显示 —— 只有拿到确切原因才能对症。
 *
 * 注入是幂等的：magnifier.js / hud.js / settings.js 顶层都有
 * 「已加载就退出」的守卫，重复注入只会重新挂一次同名函数定义，不会重复绑事件。
 */
'use strict';

importScripts('src/settings.js');

const S = self.MagSettings;

const FILES = ['src/settings.js', 'src/hud.js', 'src/magnifier.js'];
const INJECTABLE = /^(https?|file):/i;

/** 哪些标签页已经注入过（tabId:frameId），避免无谓重复注入 */
const done = new Set();
const key = (tabId, frameId) => tabId + ':' + frameId;

chrome.runtime.onInstalled.addListener((details) => {
  S.get((cur) => {
    S.set(cur, () => {
      if (details.reason === 'install') {
        chrome.runtime.openOptionsPage().catch(() => {});
      }
    });
  });
});

/* ------------------------------------------------------------------ 注入 */

async function ping(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'alt-magnifier:ping' });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

async function inject(tabId, allFrames) {
  try {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: !!allFrames },
      files: FILES,
      injectImmediately: true,
    });
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

/**
 * 确保某个标签页里引擎是活的。
 * @returns {{ok:boolean, detail:string}}
 */
async function ensure(tabId, opts) {
  const allFrames = !!(opts && opts.allFrames);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, detail: '拿不到标签页信息' };
  if (!INJECTABLE.test(tab.url || '')) {
    return { ok: false, detail: '当前页面类型不允许注入：' + (tab.url || '未知').split('?')[0] };
  }

  const alive = await ping(tabId);
  if (alive) return { ok: true, detail: '引擎已在运行（无需注入）' };

  let res = await inject(tabId, allFrames);
  if (res && res.error && allFrames) {
    // 某些页面里有无法注入的 iframe，退一步只注入顶层文档
    res = await inject(tabId, false);
  }

  if (res && res.error) return { ok: false, detail: '注入被浏览器拒绝：' + res.error };

  await new Promise((r) => setTimeout(r, 90));
  let live = await ping(tabId);
  if (!live) {
    // 有一种情况是 ping 通道被挡，但脚本其实已经跑了：再给一次机会
    await new Promise((r) => setTimeout(r, 260));
    live = await ping(tabId);
  }
  if (live) {
    (res || []).forEach((f) => done.add(key(tabId, f.frameId || 0)));
    return { ok: true, detail: '已注入 ' + ((res && res.length) || 1) + ' 个文档' };
  }
  return {
    ok: false,
    detail:
      '脚本注入成功但引擎没有响应。可能原因：页面是我们无法访问的特殊页面（如 edge:// 或扩展商店），' +
      '或者内容安全策略极严。请在普通网页上重试。',
  };
}

/* -------------------------------------------------- 自动自愈（后台静默进行） */

async function healAll() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] }).catch(() => []);
  for (const t of tabs) {
    if (!t.id || t.discarded) continue;
    try {
      await ensure(t.id, { allFrames: true });
    } catch (_) {}
  }
}

chrome.runtime.onStartup.addListener(healAll);
chrome.runtime.onInstalled.addListener(healAll);

/* 新打开的页面：标签页加载完成后如果声明式注入没生效，这里补上。
   这是「兜底」而不是主路径 —— 主路径仍然是 manifest 里的 content_scripts，
   因为它能在 document_start 就位、零延迟。 */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab || !INJECTABLE.test(tab.url || '')) return;
  done.delete(key(tabId, 0));
  ping(tabId).then((alive) => {
    if (!alive) ensure(tabId, { allFrames: true }).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const k of Array.from(done)) {
    if (k.startsWith(tabId + ':')) done.delete(k);
  }
});

/* ------------------------------------------------------------------ 消息 */

/** 最近一次来自内容脚本的异常（排障用，面板会显示） */
let lastError = null;

/** 后台自己也被 --load-extension 之外的场景静默杀掉过，所以用 session 存储兜底 */
function rememberError(rec) {
  lastError = rec;
  try {
    chrome.storage.session.set({ altMagnifierLastError: rec });
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('alt-magnifier:') !== 0) return false;

  if (msg.type === 'alt-magnifier:ping') {
    sendResponse({ ok: true, where: sender.frameId === 0 ? 'top' : 'frame:' + sender.frameId });
    return false;
  }

  if (msg.type === 'alt-magnifier:error') {
    rememberError({
      at: Date.now(),
      where: msg.where,
      detail: msg.detail,
      stack: msg.stack ? String(msg.stack).slice(0, 1200) : null,
      url: sender && sender.tab ? sender.tab.url : null,
    });
    console.error('[ALT Magnifier] 内容脚本异常 @' + msg.where + ': ' + msg.detail);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'alt-magnifier:lastError') {
    chrome.storage.session.get('altMagnifierLastError', (data) => {
      sendResponse({ ok: true, error: lastError || (data && data.altMagnifierLastError) || null });
    });
    return true;
  }

  if (msg.type === 'alt-magnifier:ensure') {
    const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false, detail: '没有可注入的标签页（当前不在普通网页上）' });
      return false;
    }
    ensure(tabId, { allFrames: msg.allFrames !== false }).then(sendResponse, (err) =>
      sendResponse({ ok: false, detail: '内部异常：' + ((err && err.message) || err) })
    );
    return true; // 异步响应
  }

  if (msg.type === 'alt-magnifier:settings') {
    if (msg.action === 'get') {
      S.get((cur) => sendResponse({ ok: true, settings: cur }));
      return true;
    }
    if (msg.action === 'reset') {
      S.set(S.sanitize(null), (next) => sendResponse({ ok: true, settings: next }));
      return true;
    }
  }

  return false;
});
