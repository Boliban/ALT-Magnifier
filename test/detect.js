/* ALT Magnifier — 测试页自带的自动漂移检测面板（运行在页面主世界）
 *
 * 数学：若整页真的绕视口锚点被整体缩放 k 倍，则任意元素放大前的视口坐标 p
 * 与放大后 p' 必须呈仿射关系  p' = k*p + c 。下面的脚本不依赖扩展自报的数字，
 * 而是用「相距最远的一对参考点」反解 (k, c)，再检查所有元素是否都落在同一条
 * 直线上 —— 落不上的就是真实位移（像素）。
 */
'use strict';

(function () {
  const panel = document.getElementById('mag-panel');
  const lead = document.getElementById('mag-lead');
  const TOL = 1.5; // 位移容差（px）
  const SEL = '[data-mag-test]';

  let armed = false;
  let base = null;
  let pointer = null;
  let wheelSeen = false;
  let kPeak = 1;
  let timer = 0;

  const fmt = (n) => (isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : '—');

  /** 输出区固定在面板里的 .out 节点，保证顶部按钮不被覆盖 */
  function say(html) {
    let out = panel.querySelector('.out');
    if (!out) {
      out = document.createElement('div');
      out.className = 'out';
      panel.appendChild(out);
    }
    out.innerHTML = html;
  }

  // 「载入扩展级检测」：注入 test/diagnose.js（扩展的内容脚本世界，
  // 读数页面无法伪造）。没有装扩展时会注入失败，这里给出明确提示。
  (function wireDiagButton() {
    const btn = document.getElementById('mag-diag-link');
    if (!btn) return;
    btn.addEventListener('click', () => {
      try {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('test/diagnose.js');
        s.onload = () => {
          s.remove();
          say(
            '<span class="ok">扩展级检测已注入。</span>\n' +
              '现在按住 Alt 滚轮放大，松手后控制台会输出漂移报告；\n' +
              '也可以先执行 __magTest.baseline() 再执行 __magTest.check()。'
          );
        };
        s.onerror = () => say('<span class="bad">注入失败：本页没有加载 ALT Magnifier 扩展。</span>');
        document.head.appendChild(s);
      } catch (err) {
        const isExt = location.protocol.indexOf('chrome-extension') === 0;
        say(
          '<span class="bad">无法注入扩展级检测</span>（' +
            (err && err.message ? err.message : '未知原因') +
            '）。\n' +
            (isExt
              ? ''
              : '提示：本地文件需要在扩展详情页打开「允许访问文件 URL」，或者改用 ' +
                'python -m http.server 起本地服务器访问，也可以直接在网址后面加 ?magDiag=1 打开本页。')
        );
      }
    });
  })();

  function sample() {
    const out = [];
    document.querySelectorAll(SEL).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cs = getComputedStyle(el);
      out.push({
        el,
        name: el.id || el.className.split(' ')[0] || el.tagName.toLowerCase(),
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        fixed:
          cs.position === 'fixed' ||
          cs.position === 'sticky' ||
          el.classList.contains('fixed-bottom') ||
          el.classList.contains('sticky-note'),
      });
    });
    return out;
  }

  /** 用相距最远的一对参考点反解 k */
  function solveK(a, b, key) {
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

  function check() {
    timer = 0;
    if (!base) return;
    const after = sample();
    if (after.length !== base.length) {
      say('<b>结构变化</b>：放大期间页面节点数量变了，本次跳过。');
      return;
    }
    let kx = solveK(base, after, 'x');
    let ky = solveK(base, after, 'y');
    if (!isFinite(kx)) kx = ky;
    if (!isFinite(ky)) ky = kx;
    const k = (kx + ky) / 2;

    const cx = after[0].x - kx * base[0].x;
    const cy = after[0].y - ky * base[0].y;

    const bad = [];
    let okCount = 0;
    let fixedOk = 0;
    for (let i = 0; i < base.length; i++) {
      const b = base[i];
      const n = after[i];
      const ex = kx * b.x + cx;
      const ey = ky * b.y + cy;
      const err = Math.hypot(n.x - ex, n.y - ey);
      const sizeErr = Math.max(Math.abs(n.w - b.w * kx), Math.abs(n.h - b.h * ky));
      if (err <= TOL && sizeErr <= TOL * 2) {
        okCount++;
        if (b.fixed) fixedOk++;
      } else {
        bad.push({ name: b.name, err, sizeErr, x: n.x, y: n.y, fixed: b.fixed });
      }
    }

    const lines = [];
    lines.push('<b>实测倍率 k = ' + fmt(k) + '</b>（kx=' + fmt(kx) + ', ky=' + fmt(ky) + '）');
    if (pointer) lines.push('鼠标锚点 ≈ (' + fmt(pointer.x) + ', ' + fmt(pointer.y) + ')');
    lines.push('参考元素 ' + base.length + ' 个｜符合比例 ' + okCount + ' 个');
    if (!bad.length) {
      lines.push('<span class="ok">✓ 通过：零位移，页面确实是整体缩放的。</span>');
    } else {
      lines.push('<span class="bad">✗ 位移 ' + bad.length + ' 个：</span>');
      bad
        .sort((a, b) => b.err - a.err)
        .slice(0, 12)
        .forEach((r) => {
          lines.push('  ' + r.name + (r.fixed ? '（fixed/sticky，需人工判断）' : '') + ' 位移 ' + fmt(r.err) + 'px，尺寸偏差 ' + fmt(r.sizeErr) + 'px');
        });
    }
    say(lines.join('\n'));
    window.__magPanelReport = { k, kx, ky, bad, okCount };
  }

  function onKeyDown(e) {
    if (!e.isTrusted) return;
    if (e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift') return;
    if (armed) return;
    armed = true;
    wheelSeen = false;
    pointer = null;
    base = sample();
    say('已采样 ' + base.length + ' 个参考元素，正在等你的滚轮…');
  }

  function onWheel(e) {
    if (!e.isTrusted || !armed) return;
    if (!wheelSeen) {
      wheelSeen = true;
      pointer = { x: e.clientX, y: e.clientY };
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, 400);
  }

  function onKeyUp() {
    if (!armed) return;
    if (wheelSeen) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 150);
    } else {
      armed = false;
    }
  }

  function onScroll() {
    const fb = document.getElementById('fb');
    if (fb) fb.textContent = 'scroll ' + Math.round(window.scrollX) + ', ' + Math.round(window.scrollY);
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  // ---- canvas 动画：模拟视频/高频重绘内容 ----
  (function anim() {
    const cv = document.getElementById('cv');
    const g = cv.getContext('2d');
    let t = 0;
    (function loop() {
      t += 0.02;
      const w = cv.width;
      const h = cv.height;
      const grd = g.createLinearGradient(0, 0, w, h);
      grd.addColorStop(0, '#1b1f26');
      grd.addColorStop(1, '#3b6ef6');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,255,255,.85)';
      g.lineWidth = 2;
      g.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = h / 2 + Math.sin(x * 0.05 + t) * 40;
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = '#ffb04a';
      g.beginPath();
      g.arc(w / 2 + Math.cos(t) * 90, h / 2 + Math.sin(t * 1.3) * 45, 9, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '600 13px Consolas, monospace';
      g.fillText('frame ' + Math.round(t * 10), 10, 20);
      requestAnimationFrame(loop);
    })();
  })();

  say(
    '1) 按住 <b>Alt</b> 在页面上滚轮放大到 4 倍左右\n' +
      '2) 松开 Alt，本面板会自动给出「实测倍率」与位移清单\n' +
      '3) 装好扩展后，点上面的「载入扩展级检测」，可再做一次独立取证的交叉验证'
  );

  /* ---- 首要诊断：内容脚本到底有没有注入到本页 ----
     内容脚本运行在扩展的隔离世界，页面脚本（本文件）看不到它的变量；
     所以这里用「Alt 按下后页面根元素是否被写入 transform」来判断，
     同时给出最可能的原因，避免用户在「扩展没注入」的状态下白试。 */
  (function checkInjection() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Alt' && e.key !== 'Control') return;
        setTimeout(() => {
          const t = document.documentElement.style.getPropertyValue('transform');
          const live = /scale\(/.test(t) || !!document.getElementById('alt-magnifier-hud');
          if (!live) {
            lead.innerHTML =
              '<span class="bad">未检测到扩展</span>';
            say(
              '<span class="bad">内容脚本没有注入到本页。</span>\n\n' +
                '最可能的原因（按概率排序）：\n' +
                '1. 本页是 file:// 打开，而扩展详情页里的\n' +
                '   「允许访问文件 URL」没打开\n' +
                '2. 扩展被停用，或代码改动后没有点「重新加载」\n' +
                '3. 设置页里「启用扩展」被关掉了\n\n' +
                '最快的排除方法：在扩展目录执行\n' +
                '  python -m http.server 8123\n' +
                '然后访问 http://localhost:8123/test/test-page.html\n' +
                '如果这里能用、file:// 不能用，就是原因 1。'
            );
          }
        }, 260);
      },
      true
    );
    setTimeout(() => {
      lead.innerHTML = '按 <b>Alt</b> + 滚轮 → 自动出报告';
    }, 300);
  })();
  window.__magTestBaseline = function (x, y) {
    armed = true;
    wheelSeen = true;
    pointer = { x: x == null ? window.innerWidth / 2 : x, y: y == null ? window.innerHeight / 2 : y };
    base = sample();
    say('手动基线已建立：' + base.length + ' 个元素，锚点 (' + fmt(pointer.x) + ', ' + fmt(pointer.y) + ')');
    return base.length;
  };
  window.__magTestCheck = check;
})();
