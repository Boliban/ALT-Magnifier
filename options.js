/* ALT Magnifier — 设置页逻辑
 * 直接读写 chrome.storage.sync：内容脚本监听 onChanged，改完立即在所有已打开
 * 的标签页生效，不用刷新页面。
 */
'use strict';

const S = window.MagSettings;
const NUMBER_KEYS = new Set(['step', 'min', 'max', 'settleDelay']);

const form = document.querySelector('main');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('reset');

let saveTimer = 0;
let statusTimer = 0;

function status(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.add('hide'), 1600);
}

function fields() {
  return Array.from(form.querySelectorAll('[data-key]'));
}

function coerce(el, cfg) {
  const key = el.dataset.key;
  if (el.type === 'checkbox') return el.checked;
  if (key === 'siteList') {
    return el.value
      .split(/[\n,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (key === 'invert') return el.value === 'true';
  if (key === 'modifier' || key === 'siteMode') return el.value;
  if (NUMBER_KEYS.has(key)) {
    const n = parseFloat(el.value);
    return isFinite(n) ? n : cfg[key];
  }
  return el.value;
}

function paint(cfg) {
  fields().forEach((el) => {
    const key = el.dataset.key;
    const v = cfg[key];
    if (el.type === 'checkbox') {
      el.checked = !!v;
    } else if (key === 'siteList') {
      el.value = Array.isArray(v) ? v.join('\n') : '';
    } else if (key === 'invert') {
      el.value = v ? 'true' : 'false';
    } else {
      el.value = v;
    }
  });
}

function collect(cfg) {
  const out = {};
  fields().forEach((el) => {
    out[el.dataset.key] = coerce(el, cfg);
  });
  return out;
}

function boot() {
  S.get((cfg) => {
    paint(cfg);
    status('已同步');
  });
  drawCanvas();
}

function commit() {
  S.get((cfg) => {
    const raw = collect(cfg);
    const next = S.sanitize(raw);
    S.set(next, (saved) => {
      // 把被夹取过的值回填，让用户看到真实生效值
      paint(saved);
      status('已保存', 'saving');
    });
  });
}

function scheduleCommit() {
  status('保存中…', 'saving');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(commit, 260);
}

form.addEventListener('input', (e) => {
  if (e.target.closest('[data-key]')) scheduleCommit();
});
form.addEventListener('change', (e) => {
  if (e.target.closest('[data-key]')) scheduleCommit();
});

resetBtn.addEventListener('click', () => {
  S.set(S.sanitize(null), (saved) => {
    paint(saved);
    status('已恢复默认', 'saving');
  });
});

// 预览区里的 canvas 画点东西，用来验证位图内容放大后不模糊、不位移
function drawCanvas() {
  const c = document.getElementById('pcanvas');
  if (!c) return;
  const g = c.getContext('2d');
  if (!g) return;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#d7dbe3';
  g.lineWidth = 1;
  for (let x = 0; x <= c.width; x += 10) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, c.height);
    g.stroke();
  }
  for (let y = 0; y <= c.height; y += 10) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(c.width, y + 0.5);
    g.stroke();
  }
  g.fillStyle = '#3b6ef6';
  g.font = '600 13px Consolas, monospace';
  g.fillText('canvas 13px', 12, 30);
  g.fillStyle = '#e0533d';
  g.beginPath();
  g.arc(180, 62, 14, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#1a9e63';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(10, 74);
  g.lineTo(110, 44);
  g.stroke();
}

boot();
