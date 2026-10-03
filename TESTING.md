# 测试说明（给后续维护者 / AI 协作者）

本文件描述 **ALT Magnifier 现有测试体系**：哪些能自动跑、哪些必须人工验证、
每个测试究竟在证明什么、以及**哪些坑已经踩过、不要再重复踩**。

> 结论先行：**核心数学与引擎行为有 60 项自动化断言（全部可复现），
> 真实浏览器里的 UI 行为需要人工验收（有现成的测试页 + 自动检测面板）。**

---

## 0. 先记住三条硬约束

改任何代码前，先接受这三条。它们决定了整个实现方式，违反其中任何一条
都会让「元素位置零漂移」这个核心需求失效：

1. **绝不能用浏览器缩放（`chrome.tabs.setZoom`）或 CSS `zoom`。**
   两者都会改变布局视口，触发 `vw`/`vh` 与媒体查询断点重算，页面立刻重排。
   本项目**只用** `transform: scale()` 作用在 `document.documentElement` 上。

2. **滚动位置绝不能取整。**
   取整会在每一格引入 0.5px 的锚点误差，连滚几十格累积成肉眼可见的漂移。
   小数 `scrollLeft`/`scrollTop` 是安全的：Chromium 绘制时会把合成层对齐到
   整数设备像素，文字不会发虚。

3. **锚点数学必须每帧从「文档坐标」重算，不能在当前滚动值上做增量。**
   一旦改成增量，误差会随滚轮次数累积。正确形式见下方 §2。

另外两个容易忽略的状态污染源：

- `lastPointer`（鼠标位置）是「以鼠标为锚点」的唯一来源，
  **任何键盘路径都不得改写它**（曾经因为在 `keydown` 里给兜底锚点赋值，
  导致锚点跑到屏幕中心 —— 这是真实发生过的 bug）。
- `getBoundingClientRect()` 在节点增删后不能跨帧按索引比对，必须按元素身份重采样
  （`test/diagnose.js` 里已经这么做了）。

---

## 1. 自动化测试（60 项断言，随时可跑）

```bash
node tools/test-math.mjs      # 16 项：核心数学
node tools/test-engine.mjs    # 44 项：引擎行为（真实加载扩展源码）
```

两个脚本都不依赖浏览器、不依赖网络、**不使用随机数**，因此结果完全可复现。

### 1.1 `tools/test-math.mjs` —— 16 项，纯数学

被测对象是 `src/math.js`（无 DOM 依赖的纯函数）。它模拟一个 3000×9000 的文档
与 1280×800 的视口，并模拟「根元素带 transform 时滚动范围按倍率线性放大」这一
浏览器真实行为。

| 小节 | 在证明什么 |
|---|---|
| [1] 连续放大 40 格 | 锚点漂移必须 < 1px；第 40 格时锚点下的文档坐标与初始一致（**零累计误差**） |
| [2] 放大后缩回 1 倍 | 倍率精确回到 1；滚动位置回到原位，累计误差 ≤ 2px |
| [3] 锚点贴四个角 | 全程有限值、不越界、不出现 NaN |
| [4] 倍率钳制 | 连续缩放停在 min/max；`min > max` 的畸形配置也不越界 |
| [5] 32 倍下的滚动几何 | 滚动范围 = 文档尺寸 × 倍率；文档末尾点可达（右下角能滚到） |
| [6] 退出换算 | 放大态的视口坐标能换算回合法的未缩放滚动位置 |

### 1.2 `tools/test-engine.mjs` —— 44 项，真实加载扩展源码

这个脚本**不是重写一遍逻辑再测**，而是把 `src/settings.js`、`src/math.js`、
`src/hud.js`、`src/magnifier.js` **原样执行进一个最小 DOM 沙箱**
（手写的 `document` / `window` / `chrome` / `getComputedStyle` 桩），
然后直接调用引擎暴露出来的消息监听器与内部状态。

| 小节 | 在证明什么 |
|---|---|
| 【1】引擎注册完整性 | `window.__altMagnifier` / `MagSettings` / `MagMath` / `MagHUD` 都挂上了；消息监听器已注册；**平时就挂好了 `wheel` 监听器**（否则第一次滚轮收不到） |
| 【2】消息监听器 | `ping` / `dump` / `toggle` / 未知类型 / 无关消息：**都不抛异常且必须回包** |
| 【3】强制开关闭环 | 打开 → 根元素写入 `transform: scale(1)`（带 `!important`）、`transform-origin: 0 0`、`overflow-anchor: none` → 关闭 → **三项都精确还原为空** |
| 【4】Alt + 滚轮 | 不抛异常；确实调用了 `preventDefault`；进入放大；`anchor` = 鼠标坐标；排入了 >1 的目标倍率 |
| 【5】不按触发键 | 滚轮**不得** `preventDefault`、不得进入放大态 |
| 【6】键盘路径 | 按下 Alt 不抛异常，且**不污染鼠标锚点**（后面再滚一次，锚点仍是鼠标位置） |

> 【2】这一节的存在原因值得记住：用户侧看到的现象是
> `The message port closed before a response was received`。
> 这个报错的唯一含义是「监听器抛异常了，没走到 `sendResponse`」。
> 因此**任何新增的消息分支都必须包 `try/catch` 并保证回包**。

---

## 2. 核心数学（改代码时不许破坏的不变量）

```js
// 鼠标下的内容点在「未缩放文档坐标」中的位置
d = (scroll + clientXY) / k

// 换上新倍率 k' 后，让它回到同一个屏幕像素
scroll' = clamp(d * k' - clientXY, 0, maxScroll)

// 退出放大时（k' = 1），把放大态视口换算回未缩放滚动位置
scrollExit = d - clientXY
```

配套要求：

- `transform-origin` 必须是 `0 0`，否则上面的补偿不成立。
- `nextScale()` 必须做浮点吸附（`1 / 1.12 * 1.12` 在浮点下不严格等于 1），
  否则「缩回 1 倍」会停在 `1.0000000000000009`。
- rAF 收敛阈值必须用**绝对量**（`< 0.001`），不能按倍率取相对值
  —— 32 倍时相对阈值高达 0.026，动画会提前跳到目标值。

---

## 3. 真实浏览器：能自动化的部分与不能自动化的部分

### 3.1 已确认可行的自动化路径

`tools/test-browser.mjs`：启动**无头 Edge**（`--load-extension` 指向本仓库），
起一个本地 HTTP 服务托管 `test/test-page.html`，通过 CDP 注入事件并核对 DOM。

它包含 10 组断言：单格放大后所有元素落在同一条缩放直线上、锚点落点、
连滚 32 格的钳制与累计误差、32 倍下整体一致性、动态插入元素、
`fixed` 顶栏随画面滚走、iframe 同比例、缩小回 1 倍精确复原、
不按 Alt 时完全不参与、改设置不刷新即生效。

`tools/_sw-check.mjs`：连到**后台 service worker 的调试上下文**，
从后台侧调用 `chrome.tabs.sendMessage`，用于把
「后台没起来」与「内容脚本没应答」这两种症状完全相同的故障区分开。

### 3.2 自动化边界（**踩过的坑，别再试**）

| 事项 | 实测结论 |
|---|---|
| Chrome 正式版加载未打包扩展 | **Chrome 137 起忽略 `--load-extension`**（本地未打包扩展被安全策略挡住）。Edge 154 仍接受。所以自动化要用 Edge，或改用 Chrome for Testing / Chromium |
| CDP 注入滚轮 | `Input.dispatchMouseEvent({type:'mouseWheel'})` 在无头 Edge 里**一律超时**（通道本身不可用），页面收不到事件 |
| CDP 手势注入 | `Input.synthesizeScrollGesture` 能生成 wheel 事件，但**会丢弃 Alt 修饰键**（页面侧实测 `wheelAlt: 0`）。因此 **「Alt + 滚轮」这条链路无法用 CDP 复现，必须由真人按键验证** |
| `file://` 页面 | 扩展默认不能访问，需要在扩展详情页打开「允许访问文件 URL」。测试页优先用 `python -m http.server` 走 `http://` |
| 通过 CDP 在 service worker 上下文里求值 | `chrome` 在该上下文里**取不到**（`ReferenceError: chrome is not defined`），只能复用它已有的逻辑入口 |

### 3.3 必须人工验收的部分

打开 `test/test-page.html`，页面左上角有一个自动检测面板 + 一个页内几何检测器。
两层检测的判定原理不同，互为交叉验证：

- **页内层（`test/detect.js`，页面世界）**：对 `[data-mag-test]` 元素取
  放大前后的 `getBoundingClientRect`，用相距最远的一对参考点反解仿射关系
  `p' = k·p + c`，再逐元素算残差 —— **残差就是位移的像素数**。
  标记为 `fixed`/`sticky` 的元素单独归类（它们合理地会随画面移动）。
- **扩展层（`test/diagnose.js`，隔离世界）**：把同一套几何核对跑在扩展的隔离世界里，
  页面无法伪造读数。可通过页面按钮「载入扩展级检测」或网址加 `?magDiag=1` 注入。

人工清单（`test/README.md` 里有更细的版本）：鼠标停在某个字上按住 Alt 滚轮 →
**那个字必须纹丝不动**；松开 Alt 后落回原处；`fixed` 顶栏随画面滚走；
`background-attachment: fixed` 色块与边框严丝合缝；iframe 与外层同比例；
连滚 30 格不漂移。

---

## 4. 生产环境可用的排障入口（不是测试专用）

这些入口在正式版里保留，后续排查同类问题应优先用它们，而不是靠猜：

| 入口 | 用途 |
|---|---|
| 工具栏面板 → **分层自检** | 逐层测试：①扩展上下文 storage ②后台 service worker ③面板直接注入（绕开后台）④内容脚本引擎。**任何一层坏了症状都一样（「没反应」），所以必须分层测** |
| 工具栏面板 → **导出运行状态** | 打印引擎真实内部状态：`enabled` / `modifier` / `siteOK` / `active` / `modifierDown` / 根元素 inline transform / 生效设置。**按住 Alt 的同时点它，就能判断键盘事件是否到达页面** |
| 工具栏面板 → **强制开/关放大** | 后台直接命令引擎放大一次，绕过所有键盘与滚轮判定。用来区分「引擎/渲染坏了」和「只有触发条件坏了」 |
| 网页上按 <kbd>Alt</kbd>+<kbd>W</kbd> | 不依赖滚轮的放大开关。有反应 = 引擎与渲染正常，问题只在滚轮事件上 |
| `src/magnifier.js` 的 `reportError()` | 所有异常都会 `console.error` + 上报后台（`alt-magnifier:error`），后台用 `chrome.storage.session` 兜底缓存，面板可读回 |

> 排查顺序建议：**先分层自检定位「哪一层」，再导出状态看「哪个字段」**。
> 不要一上来就让用户翻 Console 或改权限开关 —— 那是最慢的路径。

---

## 5. 已知限制（不是 bug，不要试图"修"）

- **`fixed` / `sticky` 元素会随画面一起滚走。** 这是 `transform` 创建新包含块的
  必然结果，也是「像放大图片」的定义。浏览器自带缩放之所以能钉住顶栏，
  正是因为它不创建新包含块 —— 代价是必须重排。
- **单击 Alt 仍会点亮 Edge「设置及其他」菜单。** 浏览器级 UI，网页层拦不住。
  想彻底躲开可在设置里换触发键。
- **放大期间鼠标滚轮只缩放、不平移。** 大范围移动靠滚动条。
- **32 倍是硬上限。** 再高会让滚动范围膨胀到「页面高度 × 倍率」，合成层显存
  与滚动精度都会开始出问题。
- **站点自己用 `getBoundingClientRect()` 算位置再写回布局属性**（拖拽跟随、
  进度条把手）仍可能偏移 —— 那是站点把视觉坐标当布局坐标用。
  扩展已避免触发它（不派发任何事件、不改视口相关属性），但挡不住站点自己在滚动时重算。
  这类页面用设置页的站点黑名单排除。

---

## 6. 文件地图

```
src/math.js             核心数学（纯函数，无 DOM）→ 被 test-math.mjs 直接测
src/settings.js         设置读写 + 清洗 + 站点规则匹配（也有纯函数可测）
src/magnifier.js        引擎：事件、缩放循环、锚点补偿、样式快照/还原、异常上报
src/hud.js              倍率角标（Shadow DOM；iframe 里不安装）

tools/test-math.mjs     16 项数学断言            ← CI 首选
tools/test-engine.mjs   44 项引擎断言（DOM 沙箱） ← CI 首选
tools/test-browser.mjs  无头 Edge 端到端（含 3.2 的边界）
tools/_sw-check.mjs     后台/内容脚本分层诊断（手动排障用）
tools/make_icons.py     图标生成（Pillow）

test/test-page.html     人工验收页（含自动漂移检测面板）
test/detect.js          页内检测（页面世界）
test/diagnose.js        扩展级检测（隔离世界）
test/README.md          人工验收清单
README.md               用户向：安装、使用、已知限制
TESTING.md              本文件：维护者向
```

## 7. 提交前的最小检查

```bash
node tools/test-math.mjs     # 必须 16/16
node tools/test-engine.mjs   # 必须 44/44
```

改了以下任一处时，除上面两项外**必须**再人工走一遍 `test/test-page.html`：

- `src/magnifier.js` 的 `applyScale` / `nextScale` / `frameGuard` / `beginMagnify`
- `src/math.js` 的任何函数
- `manifest.json` 的 `permissions` / `content_scripts` / `action`
- 任何新增的消息分支（记住 §1.2 的教训：必须 `try/catch` + 必须回包）
