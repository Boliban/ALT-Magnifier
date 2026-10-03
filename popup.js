/* ALT Magnifier — 工具栏面板
 * 直接读写 chrome.storage.sync：内容脚本监听 onChanged，改完立即生效，无需刷新页面。
 */
'use strict';

const S = window.MagSettings;
const M = window.MagMath;

const el = {
  enabled: document.getElementById('p-enabled'),
  min: document.getElementById('p-min'),
  max: document.getElementById('p-max'),
  step: document.getElementById('p-step'),
  modifier: document.getElementById('p-modifier'),
  status: document.getElementById('p-status'),
  test: document.getElementById('p-test'),
  copy: document.getElementById('p-copy'),
  copied: document.getElementById('p-copied'),
  options: document.getElementById('p-options'),
  selftest: document.getElementById('p-selftest'),
  dump: document.getElementById('p-dump'),
  toggle: document.getElementById('p-toggle'),
  out: document.getElementById('p-out'),
};

let saveTimer = 0;

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = 'note' + (kind ? ' ' + kind : '');
}

function paint(cfg) {
  el.enabled.checked = !!cfg.enabled;
  el.min.value = cfg.min;
  el.max.value = cfg.max;
  el.step.value = cfg.step;
  el.modifier.value = cfg.modifier;
}

function commit() {
  S.get((cur) => {
    const next = S.sanitize(
      Object.assign({}, cur, {
        enabled: el.enabled.checked,
        min: parseFloat(el.min.value),
        max: parseFloat(el.max.value),
        step: parseFloat(el.step.value),
        modifier: el.modifier.value,
      })
    );
    S.set(next, (saved) => {
      paint(saved);
      setStatus('已保存（已打开的标签页立即生效）', 'ok');
    });
  });
}

function scheduleCommit() {
  setStatus('保存中…');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(commit, 220);
}

['input', 'change'].forEach((evt) => {
  [el.enabled, el.min, el.max, el.step, el.modifier].forEach((node) => {
    node.addEventListener(evt, scheduleCommit);
  });
});

el.options.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

el.test.addEventListener('click', () => {
  // 用 window.open 而不是 chrome.tabs.create：前者不需要 tabs 权限，
  // 本扩展除了 storage 之外一个权限都不要。
  // 测试页是 file://，若扩展没有文件访问权限会打不开 —— 面板上的提示会告诉用户改用 http。
  window.open(chrome.runtime.getURL('test/test-page.html'), '_blank');
  window.close();
});

el.copy.addEventListener('click', async () => {
  const cmd = 'python -m http.server 8123';
  try {
    await navigator.clipboard.writeText(cmd);
    el.copied.hidden = false;
    setStatus('命令已复制到剪贴板，在扩展目录执行即可', 'ok');
  } catch (_) {
    el.copied.hidden = false;
    setStatus('自动复制失败，请手动复制下面这行', 'bad');
  }
  void cmd;
});

/* ---------------------------------------------------------------- 自检 */
el.selftest.addEventListener('click', () => {
  if (!M) {
    el.out.hidden = false;
    el.out.className = 'out bad';
    el.out.textContent = 'src/math.js 没加载进来，扩展安装可能不完整。';
    return;
  }
  const lines = [];
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) {
      pass++;
      lines.push('  ✓ ' + label);
    } else {
      fail++;
      lines.push('  ✗ ' + label);
    }
  };

  const STEP = 1.12;
  const MIN = 1;
  const MAX = 32;
  const docW = 3000;
  const docH = 9000;
  const vw = 1280;
  const vh = 800;
  const maxScroll = (k) => ({ x: Math.max(0, docW * k - vw), y: Math.max(0, docH * k - vh) });

  // 连滚 40 格：锚点漂移必须为 0
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
    check(k === MAX, '连滚 40 格后钳制在 32 倍');
    check(worst < 0.001, '锚点漂移 ' + worst.toExponential(1) + 'px（应为 0）');
    const dEnd = { x: M.docPoint(k, sx, ax), y: M.docPoint(k, sy, ay) };
    check(Math.abs(dEnd.x - d0.x) < 0.01 && Math.abs(dEnd.y - d0.y) < 0.01, '无累计误差');
  }
  // 放大再缩回：滚动位置必须复原
  {
    const ax = 300;
    const ay = 200;
    let k = 1;
    let sx = 777;
    let sy = 3333;
    const s0 = { x: sx, y: sy };
    for (let pass2 = 0; pass2 < 2; pass2++) {
      const dir = pass2 === 0 ? +1 : -1;
      for (let i = 0; i < 25; i++) {
        const d = { x: M.docPoint(k, sx, ax), y: M.docPoint(k, sy, ay) };
        k = M.nextScale(k, dir, STEP, MIN, MAX);
        const m = maxScroll(k);
        sx = M.scrollFor(d.x, k, ax, m.x);
        sy = M.scrollFor(d.y, k, ay, m.y);
      }
    }
    check(k === 1, '倍率精确回到 1');
    check(Math.hypot(sx - s0.x, sy - s0.y) < 1e-6, '滚动位置精确复原');
  }
  // 贴角锚点
  {
    let bad = false;
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
        if (!isFinite(sx) || !isFinite(sy) || sx < 0 || sy < 0 || sx > m.x || sy > m.y) bad = true;
      }
    });
    check(!bad, '四个角落锚点全程有限且不越界');
  }
  // 设置清洗
  {
    const s = S.sanitize({ step: 99, max: 999, modifier: 'bogus' });
    check(s.step === 2 && s.max === 32 && s.modifier === 'alt', '设置项越界值被正确夹取');
    check(S.hostMatches('www.bilibili.com', ['bilibili.com']), '站点规则子域匹配生效');
    check(!S.hostMatches('notbilibili.com', ['bilibili.com']), '站点规则不做后缀误匹配');
  }

  el.out.hidden = false;
  el.out.className = 'out ' + (fail ? 'bad' : 'ok');
  el.out.textContent =
    (fail ? '✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项' : '✓ 全部 ' + pass + ' 项通过') + '\n\n' + lines.join('\n');
});

/* ------------------------------------------------- 导出运行状态 / 强制开关 */
function ask(msg) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        if (chrome.runtime.lastError) {
          return res({ ok: false, detail: '后台没有响应：' + chrome.runtime.lastError.message });
        }
        res(reply || { ok: false, detail: '后台返回为空' });
      });
    } catch (err) {
      res({ ok: false, detail: '调用后台失败：' + ((err && err.message) || err) });
    }
  });
}

function showReport(title, text, kind) {
  el.out.hidden = false;
  el.out.className = 'out ' + (kind || '');
  el.out.textContent = title + '\n' + '─'.repeat(28) + '\n' + text;
}

el.dump.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || tab.id == null) {
    setStatus('当前不是普通网页，没有可导出的状态。', 'bad');
    return;
  }
  const res = await ask({ type: 'alt-magnifier:dump', tabId: tab.id });
  if (!res || !res.ok) {
    setStatus('导出失败：' + ((res && res.detail) || '未知'), 'bad');
    return;
  }
  const lines = [
    '页面      : ' + res.href,
    '顶层文档  : ' + (res.isTop ? '是' : '否（iframe）'),
    '站点被允许: ' + res.siteOK + '（黑名单/白名单规则）',
    '扩展启用  : ' + res.enabled,
    '触发键    : ' + res.modifier,
    '正在放大  : ' + res.active + '  当前倍率 k = ' + (typeof res.k === 'number' ? res.k.toFixed(3) : res.k),
    '触发键按下: ' + res.modifierDown + '（按下 Alt 时点本按钮可看到它变 true）',
    '根元素样式: ' + JSON.stringify(res.rootTransform),
    '发动机设置: ' + JSON.stringify(res.storage),
  ];
  showReport('运行状态导出（把这段发我）', lines.join('\n'), 'ok');
  setStatus('已导出。若「触发键按下」在按住 Alt 时为 false，问题就在键盘事件上。', 'ok');
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    setStatus('已导出并复制到剪贴板，直接粘贴给我即可。', 'ok');
  } catch (_) {}
});

el.toggle.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || tab.id == null) {
    setStatus('当前不是普通网页，无法强制开关。', 'bad');
    return;
  }
  const res = await ask({ type: 'alt-magnifier:toggle', tabId: tab.id });
  if (res && res.ok) {
    setStatus(res.active ? '✓ 已强制开启放大（应能立刻看到页面被放大）' : '✓ 已关闭放大', 'ok');
    showReport(
      '强制开关结果',
      '引擎响应正常，active = ' + res.active + '，k = ' + (typeof res.k === 'number' ? res.k.toFixed(3) : res.k) + '\n\n' +
        (res.active
          ? '这说明引擎和渲染链路都没问题：\n' +
            '· 如果页面确实被放大了 → 问题只出在「Alt + 滚轮」这个触发条件上\n' +
            '  （多半是触发键被改成了别的键，看上面导出的「触发键」字段）\n' +
            '· 如果页面没有任何变化 → 问题在渲染通道上，请把这段发我'
          : '已关闭。'),
      res.active ? 'ok' : ''
    );
  } else {
    setStatus('强制开关失败：' + ((res && res.detail) || '未知'), 'bad');
    showReport('强制开关失败', JSON.stringify(res, null, 2), 'bad');
  }
});

/* ------------------------------------------------- 启动时的安装健康检查 */
function activeTab() {
  return new Promise((res) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) return res(null);
        res((tabs && tabs[0]) || null);
      });
    } catch (_) {
      res(null);
    }
  });
}

function askEnsure(tabId) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'alt-magnifier:ensure', tabId, allFrames: true }, (reply) => {
        if (chrome.runtime.lastError) {
          return res({ ok: false, detail: '后台没有响应：' + chrome.runtime.lastError.message });
        }
        res(reply || { ok: false, detail: '后台返回为空' });
      });
    } catch (err) {
      res({ ok: false, detail: '调用后台失败：' + ((err && err.message) || err) });
    }
  });
}

function fileAccessAllowed() {
  return new Promise((res) => {
    try {
      if (!chrome.extension || !chrome.extension.isAllowedFileSchemeAccess) return res(null);
      chrome.extension.isAllowedFileSchemeAccess((v) => res(!!v));
    } catch (_) {
      res(null);
    }
  });
}

(async function boot() {
  const cfg = await new Promise((res) => S.get(res));
  paint(cfg);

  if (!cfg.enabled) {
    setStatus('扩展当前是「已停用」状态，请打开右上角开关。', 'bad');
    return;
  }

  // 关键一步：让后台对「当前这个标签页」做一次注入确认。
  // 这一步不依赖 manifest 里的声明式内容脚本，所以即使声明式注入失效也能救回来。
  const tab = await activeTab();
  const allowed = await fileAccessAllowed();

  if (!tab || tab.id == null) {
    setStatus('当前不是普通网页（扩展页 / edge:// / 新标签页），没法注入。打开一个网站再点这里。', 'bad');
    return;
  }

  setStatus('正在确认本页引擎状态…');
  const res = await askEnsure(tab.id);
  const host = (() => {
    try {
      return new URL(tab.url).host || tab.url;
    } catch (_) {
      return tab.url || '当前页';
    }
  })();

  if (res.ok) {
    setStatus('✓ ' + host + ' 引擎已就绪：按住 Alt + 滚轮即可放大。（' + res.detail + '）', 'ok');
  } else {
    const extra =
      allowed === false && /^file:/i.test(tab.url || '')
        ? ' 注意：本页是 file:// 且扩展没有文件访问权限 —— 请在扩展详情页打开「允许访问文件 URL」。'
        : '';
    setStatus('✗ ' + host + ' 引擎没起来。' + res.detail + extra, 'bad');
    el.out.hidden = false;
    el.out.className = 'out bad';
    el.out.textContent =
      '注入失败详情\n' +
      '────────────\n' +
      '标签页 : ' + (tab.url || '未知') + '\n' +
      '后台返回: ' + res.detail + '\n' +
      (allowed === null ? '' : 'file:// 权限: ' + (allowed ? '已允许' : '未允许') + '\n') +
      '\n如果上面写着「注入被浏览器拒绝」，把那句话原样发我，\n' +
      '它通常直接指出原因（企业策略 / 页面受限 / 权限不足）。';
  }
})();
