/* ALT Magnifier — MV3 service worker
 * 职责极小：安装时写入默认设置；提供“重置设置”的消息入口。
 * 放大逻辑全在内容脚本里，后台常驻成本为零。
 */
'use strict';

importScripts('src/settings.js');

const S = self.MagSettings;

chrome.runtime.onInstalled.addListener((details) => {
  S.get((cur) => {
    // 只补齐缺失项，不覆盖用户已有配置
    S.set(cur, () => {
      if (details.reason === 'install') {
        chrome.runtime.openOptionsPage().catch(() => {});
      }
    });
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'alt-magnifier:settings') return false;
  if (msg.action === 'get') {
    S.get((cur) => sendResponse({ ok: true, settings: cur }));
    return true;
  }
  if (msg.action === 'reset') {
    S.set(S.sanitize(null), (next) => sendResponse({ ok: true, settings: next }));
    return true;
  }
  return false;
});
