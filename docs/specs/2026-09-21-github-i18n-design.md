# GitHub 汉化脚本（jiebukai/github-i18n）设计 spec

> 日期：2026-09-21
> 状态：待用户审阅
> 目标产物：Tampermonkey 用户脚本 `GitHub汉化插件.user.js`（由 `build.mjs` 生成，提交进仓库）

---

## 1. 背景与问题

`k1995/github-i18n-plugin`（GitHub 中文社区）是目前主流的 GitHub 界面汉化脚本。实测与代码分析显示它**漏翻**源于两个结构性原因，而不是个别词条缺失：

1. **遍历能力弱**：整页递归 `traverseElement` + jQuery 依赖；对 Shadow DOM、动态插入节点、属性文本（`aria-label` / `title` / `placeholder` / `data-confirm`）覆盖不足；剪枝黑白名单不完整，导致部分父节点被排除后整棵子树都不翻。
2. **词典量小**：`locales/zh-CN.json` 仅 **1680** 条 `dict` + **1** 条 `css` 规则（实测数据），且缺少带变量文本（如 `{n} commits`）的处理。

本 spec 定义一个重新设计的脚本：机制层修好遍历与匹配，词典层迁移并扩充上游条目，达到「UI 名称基本无残留英文、且不误翻代码与标识符」的效果。

## 2. 目标与成功标准

**作用域**：`https://github.com/*`、`https://gist.github.com/*`

**必须汉化**（用户确认的三类漏翻高发区）：
1. 导航栏 / 顶部菜单 / 新版 React UI 的按钮
2. 动态出现的内容：下拉菜单、悬浮 tooltip、弹窗
3. 页面字段名：仓库描述区、README 区周边控件、Wiki、搜索结果条目

**同时必须处理**：属性文本 `aria-label` / `title` / `placeholder` / `data-confirm` / `value`(button|submit)。

**成功判据**：
- 上述区域实测**基本无残留英文**（以人工手测清单为准，见 §10）。
- **零误翻**：代码块、文件名、仓库名、用户名、分支名、topic、README 正文、URL、邮箱、纯数字/日期。
- 不造成可感知卡顿：首屏翻译不阻塞交互，后续增量处理。

**明确不做**（YAGNI）：
- 日语等其他语言（`@resource ja` 不引入）。
- 自动机器翻译正文（改为用户点击才调，见 §8）。
- 众包/云端词典同步机制。
- 自建暗色主题（GitHub 自带主题，脚本不干预样式，仅面板自身用深色样式）。

## 3. 已确认的决策（用户拍板）

| 决策项 | 结论 |
|---|---|
| 仓库 | 新建独立仓库 `jiebukai/github-i18n`（与 `jiebukai/tampermonkey` 的 Eagle 主题分离） |
| 交付形态 | 词典源 JSON + `build.mjs` 内联生成 `.user.js`（产物提交进仓库，供 Tampermonkey 直装） |
| 词典来源 | 迁移上游 1680 条（MIT 声明）+ 清洗修正 + 自建补充 |
| 正文翻译 | 不自动译；注入「译」按钮按需调用；**Google 与 gitcn.org 两个服务都实现，设置面板可切换** |
| 依赖 | 不使用 jQuery、不使用 timeago.js（原生 DOM + `Intl.RelativeTimeFormat`） |

**许可事实（重要）**：上游 `k1995/github-i18n-plugin` 仓库**没有 LICENSE 文件**，许可依据是其 `userscript.js` 头部注释 `// @license MIT`。本项目在 `NOTICE` 中署名来源并说明该许可声明情况，仅迁移「英文→中文」对照数据，不复制其脚本代码。

## 4. 架构

单一产物，内部按职责分成六个模块（同一 IIFE 内，逻辑区块清晰分隔）：

| 模块 | 职责 | 依赖 |
|---|---|---|
| `dict` | 加载内嵌词典；可选拉取 `@resource` 远程词典做兜底；查询接口 | `locales/*.json`（构建期内联）、`GM_getResourceText` |
| `matcher` | 文本归一化、精确匹配、模板匹配（带变量文本） | 纯函数，无 DOM 依赖 |
| `translator` | 遍历文本节点与属性、剪枝判定、写入译文 | `matcher`、`dict` |
| `observer` | `MutationObserver` 增量处理、`requestIdleCallback` 分片、SPA 路由重扫 | `translator` |
| `ui` | 悬浮入口 + 设置面板 + 状态持久化 | `GM_setValue`/`GM_getValue`/`GM_addStyle` |
| `bodyTranslate` | 正文「译」按钮、批量请求、回填、显示原文、缓存 | 两个翻译服务、`GM_xmlhttpRequest` |

**模块边界契约**：`matcher` 与剪枝判定（`classify`）必须是**纯函数**，不触碰 DOM —— 这是可测试性的关键，单元测试只测它们。

## 5. 词典格式与匹配规则

### 5.1 文件结构

`locales/zh-CN.json`：

```json
{
  "meta": { "lang": "zh-CN", "updated": "2026-09-21", "source": "built-in" },
  "dict": { "pull requests": "拉取请求", "issues": "议题" },
  "patterns": [
    { "re": "^(\\d+) commits? to (.+)$", "out": "$1 次提交到 $2", "flags": "" }
  ],
  "css": [
    { "selector": "a[aria-label='Pull requests you created']", "key": "!html", "replacement": "你创建的拉取请求" }
  ]
}
```

- `dict`：键 = **归一化后的英文小写**，值 = 中文。迁移上游时剔除 `__comments-1`、`__comments-css` 这类注释伪键（上游把它混在 `dict` 里，是漏配的噪音）。
- `patterns`：正则模板，处理带变量的文本。存储为字符串，运行时 `new RegExp(re, flags)`，编译结果缓存。
- `css`：选择器规则，兜住「文本键无法覆盖」的场景（同一英文文本在不同上下文需要不同译法、或需要直接改 `aria-label`）。上游只有 1 条，本项目按需扩充。

> 说明：为降低复杂度，**不**实现上下文相关词典（同一 key 多译法）；确实需要的场景走 `css` 规则。

### 5.2 归一化（固定算法）

```js
function normKey(s) {
  return s.replace(/\u00a0/g, ' ')   // NBSP → 空格
          .replace(/\s+/g, ' ')      // 连续空白压缩
          .trim()
          .toLowerCase();
}
```

### 5.3 匹配顺序

1. 原文去首尾空白后为空 → 跳过。
2. 纯数字 / 纯日期 / 纯 hex / 含 `://` / 邮箱形态 → 跳过。
3. `dict[normKey(raw)]` 命中 → 用译文替换。
4. 未命中 → 顺序尝试 `patterns`（首个命中即返回）。
5. 仍未命中 → 若开启远程词典兜底，查远程词典；命中则回填并写入本地缓存。

### 5.4 写回方式

保留原文首尾空白，只替换中间内容（避免破坏行内布局）：

```js
const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
node.nodeValue = m[1] + translated + m[3];
```

## 6. 剪枝规则（不翻译什么）

这是「零误翻」的核心。判定按顺序执行，任一命中即**不翻译**：

1. **标签**：`SCRIPT` `STYLE` `LINK` `IMG` `SVG` `PATH` `CODE` `PRE` `KBD` `SAMP` `VAR` `TEXTAREA` `CANVAS` `VIDEO` `TABLE`。
2. **容器（id/class 命中即整棵子树跳过）**：代码编辑器（`CodeMirror`、`cm-editor`、`react-code-lines`）、文件树与路径（`PRIVATE_TreeView-item`、`js-path-segment`、`final-path`、`react-tree-show-tree-items`、`js-navigation-container`）、正文（`markdown-body`）、`readme`、`topic-tag`、`search-input-container`、`search-match`、`repo`、`GlobalNav`。
3. **属性标记**：`[itemprop=name]`、`[data-testid=...]`?（不整体排除，仅用于测试定位）。
4. **标识符启发式（新增，防用户名/仓库名/分支名/文件名被翻）**：文本满足任一条件即跳过 ——
   - 无空格且含 `-` `_` `.` `/` `@` `:` `#`；
   - 形如 `camelCase` / `PascalCase`（含大写且非全大写、且含小写）；
   - 全大写且含下划线（如 `MAX_RETRIES`）；
   - 结尾是已知代码后缀（`.js` `.ts` `.py` `.md` `.json` `.yml` `.py` 等）。
5. **长度阈值**：单文本节点 > 200 字符 → 跳过（长句几乎都是正文，词典型翻译必然出错）。
6. **多词判定**：英文 UI 名称通常 ≤ 5 个词；超过则跳过（可配置常量）。

**已知取舍**：`repo-list` 上游整体排除导致搜索结果页字段名不翻。本项目**不排除** `repo-list`，改为靠第 4 条启发式保护仓库名、靠 `dict` 覆盖字段名（如 `Public`、`Updated`、`Issues`）——这正是回应「搜索结果条目仍是英文」的修法。

**可观测性**：提供调试开关（`localStorage` 或面板隐藏项），在 `console` 打印「跳过原因统计」，便于人工补规则。

## 7. 遍历、动态处理与性能

- **文本节点遍历**：`document.createTreeWalker(root, NodeFilter.SHOW_TEXT | SHOW_ELEMENT, filter)`，`filter` 内做剪枝判定（`FILTER_REJECT` 用于容器剪枝，`FILTER_SKIP` 用于属性处理）。
- **属性翻译**：对进入遍历的元素处理 `aria-label` / `title` / `placeholder` / `data-confirm`；`INPUT[type=button|submit]` 处理 `value`。
- **Shadow DOM**：元素若带 `shadowRoot` 则递归进入（新版 UI 的 `<relative-time>`、`<clipboard-copy>` 等 web component 在 shadow root 内渲染文本）。
- **去重**：用 `WeakSet` 记录已处理节点；已翻译的文本在 `nodeValue` 上打 `data-*` 标（或在 WeakSet 中记录「原文 → 已翻」），避免 MutationObserver 自触发导致的死循环。
- **增量**：`MutationObserver` 只对 `addedNodes` 走一遍 `translator`，**不全页重扫**；`characterData` / `attributes` 变更同样按节点增量处理。
- **分片**：每次批量处理用 `requestIdleCallback`（无则 `setTimeout(..., 0)`）分片，单帧处理上限（如 300 节点）后让出主线程。
- **SPA 路由**：GitHub 用 Turbo —— 监听 `turbo:load`、`pjax:end`、`popstate`，并兜底「`location.href` 变化轮询（1s）」；路由变化后做一次全页翻译。
- **首屏**：`@run-at document-idle`，`DOMContentLoaded` 后立即执行一次全页翻译（idle 分片），不阻塞。

## 8. 正文翻译（按需）

**注入位置**：容器旁注入小号「译」按钮 —— 仓库描述区（`About` 区块）、README 容器（`markdown-body`）、Wiki 内容区、搜索结果条目（每个结果项）。

**流程**：
1. 点击 → 收集目标容器内可译文本节点（复用 §6 剪枝，额外跳过 `CODE`/`PRE`/链接 URL）。
2. 合并成批次（每请求 ≤ 1500 字符），按序编号。
3. `GM_xmlhttpRequest` 调所选服务。
4. 按编号回填，并把原 `nodeValue` 存入 `Map` 以便「显示原文」切换。
5. 结果按 `location.pathname + 内容哈希` 缓存到 `GM_setValue`，二次访问直接命中。

**服务**：
- **Google**：`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=<text>`，响应为嵌套数组，拼接 `[0][*][0]`。需能访问 Google。
- **gitcn.org**：`https://gitcn.org/translate?i=<repoId>&q=<text>`（上游用法），返回 HTML 片段。需 `octolytics-dimension-repository_id` meta 取仓库 id，取不到时用 `0`。

**失败处理**：状态行提示（「翻译失败：服务不可达/限流」）+ 一键切换服务重试；不静默失败。

**`@connect`**：`translate.googleapis.com`、`gitcn.org`。

## 9. UI 与设置项

**悬浮入口**：右下角胶囊按钮，文字「译」；可拖动（Pointer Events，位移 > 3px 才算拖动，位置存 `GM_setValue`，越界拉回可视区）——沿用你微博脚本已有的交互约定。

**设置面板**（点击入口展开，深色样式，含 `color-scheme: dark`）：

| 设置 | 类型 | 默认值 |
|---|---|---|
| 启用汉化 | 开关 | `true` |
| 翻译属性文本（aria-label/title/placeholder/data-confirm） | 开关 | `true` |
| 相对时间中文化 | 开关 | `true` |
| 远程词典兜底 | 开关 | `true` |
| 正文「译」按钮 | 开关 | `true` |
| 正文翻译服务 | 单选：Google / gitcn.org | `google` |
| 术语表链接（只读提示） | 文本 | 链到 GitHub 官方词汇表中文版 |
| 清除正文翻译缓存 | 按钮 | — |

开关点击**即时保存**（沿用你微博脚本的教训：不能等关闭面板才存）。

**持久化键**：`gh-i18n:cfg`（单个 JSON），`gh-i18n:cache:*`（正文翻译缓存）。

## 10. 构建、仓库结构与元数据

### 10.1 仓库结构

```
github-i18n/
├─ README.md                 # 用途、安装链接、设置说明、来源与许可
├─ LICENSE                   # MIT（copyright jiebukai）
├─ NOTICE                    # 上游词典来源与许可声明情况说明
├─ .gitignore                # node_modules 等（无 node_modules 也应存在）
├─ locales/
│  ├─ zh-CN.json             # 主词典（内嵌源）
│  ├─ patterns.json          # 带变量文本模板
│  └─ css-rules.json         # 选择器规则
├─ src/
│  └─ userscript.template.js # 脚本模板，含 /*__DICT__*/ 等占位符
├─ build.mjs                 # 读 locales/*.json + template → 生成产物
├─ tools/
│  ├─ import-upstream.mjs    # 拉上游词典 → 转换/清洗 → 合并进 locales/zh-CN.json
│  └─ dict-lint.mjs          # 词典体检
├─ tests/
│  ├─ matcher.test.mjs       # 归一化/精确/模板匹配
│  ├─ classify.test.mjs      # 剪枝与标识符启发式（含反例）
│  └─ reltime.test.mjs       # 相对时间格式化
├─ docs/specs/2026-09-21-github-i18n-design.md
└─ GitHub汉化插件.user.js     # 构建产物（提交，供直装）
```

### 10.2 构建

`build.mjs`（零依赖，Node 内置 `fs`）：
1. 读 `locales/zh-CN.json`、`patterns.json`、`css-rules.json`。
2. 读 `src/userscript.template.js`，替换 `/*__DICT__*/`、`/*__PATTERNS__*/`、`/*__CSS__*/`、`/*__VERSION__*/`。
3. 写 `GitHub汉化插件.user.js`（LF 换行，UTF-8）。
4. 打印统计：dict 条数、patterns 条数、css 条数、产物大小。
5. `--check` 模式：只校验，不写文件（供测试用）。

**版本号来源**：`package.json` 的 `version`（仓库内 `package.json` 仅作版本与脚本入口，`private: true`，**无运行时依赖**）。

### 10.3 元数据（头部注释块）

```
// @name         GitHub汉化插件
// @namespace    https://github.com/jiebukai/github-i18n/
// @version      <由 build 注入>
// @description  GitHub 界面汉化（简体中文）：导航/按钮/菜单/属性文本，正文按需机器翻译
// @author       jiebukai
// @license      MIT
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @match        https://github.com/*
// @match        https://gist.github.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @resource     zh-CN-upstream https://cdn.jsdelivr.net/gh/k1995/github-i18n-plugin@refs/heads/master/locales/zh-CN.json
// @connect      translate.googleapis.com
// @connect      gitcn.org
// @run-at       document-idle
// @supportURL   https://github.com/jiebukai/github-i18n/issues
// @homepageURL  https://github.com/jiebukai/github-i18n
// @downloadURL  https://raw.githubusercontent.com/jiebukai/github-i18n/main/GitHub%E6%B1%89%E5%8C%96%E6%8F%92%E4%BB%B6.user.js
// @updateURL    https://raw.githubusercontent.com/jiebukai/github-i18n/main/GitHub%E6%B1%89%E5%8C%96%E6%8F%92%E4%BB%B6.user.js
```

命名纪律（沿用你现有仓库的约定）：**文件名 = `@name`**，`.user.js` 后缀必须保留（Tampermonkey 安装检测依赖 URL pathname 以 `.user.js` 结尾）。

## 11. 测试策略

1. **语法**：`node --check GitHub汉化插件.user.js`。
2. **单元测试**（`node --test tests/`，零第三方依赖）：
   - `matcher`：归一化（NBSP/多空白/大小写）、精确命中、模板匹配、未命中返回原文。
   - `classify`：**反例优先** —— 保证 `owner/repo`、`feature-x`、`v1.3.1`、`src/index.js`、`jiebukai`、`MAX_RETRIES`、URL、邮箱、纯数字、长正文（>200 字符）都不被翻译；同时保证 `Pull requests`、`Issues`、`Merge pull request` 等被翻译。
   - `reltime`：若干固定时间差 → 期望中文（「3 个月前」）。
3. **词典 lint**（`tools/dict-lint.mjs`）：重复键、空值、值里出现英文单词残留（如 `=> "拉取 requests"`）、`dict` 与 `patterns` 冲突、`css` 选择器语法。
4. **构建一致性**：`build.mjs --check` 后比对产物与工作区文件一致（防忘记构建）。
5. **手测清单（由用户执行，我无法驱动浏览器）**：
   - 首页/仪表盘：顶部导航、`+` 下拉菜单、通知面板、用户菜单、搜索框 placeholder。
   - 仓库页：Code/Issues/Pull requests/Actions 标签、About 侧栏、Watch/Fork/Star 按钮与其下拉。
   - 动态：hover 出现 tooltip、点击下拉/弹窗、SPA 内跳转后新增内容。
   - 搜索页：结果条目的字段名（`Public`、`Updated`、`Issues`…）。
   - 属性文本：用 DevTools 检查按钮 `aria-label` 是否已中文化。
   - 正文按钮：点击「译」→ 仓库描述/README 变中文 → 「显示原文」可切回 → 刷新后命中缓存。
   - 误翻检查：README 内代码块、仓库名、用户名、分支名、文件列表保持英文。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 误翻代码/标识符 | §6 保守剪枝 + 标识符启发式 + 反例单测兜底；面板可一键停用 |
| GitHub DOM 频繁改动导致规则失效 | 规则集中在 `locales/css-rules.json` 与 `classify` 表，易改；不依赖脆弱深层选择器 |
| 性能 | 增量 + idle 分片 + WeakSet 去重 + 长度/词数阈值 |
| 上游词典许可不清（仓库无 LICENSE 文件） | `NOTICE` 署名 + 说明许可依据为源文件头部 `@license MIT`；只迁移对照数据，不复制代码 |
| 翻译服务失效/限流 | 失败明确提示 + 可切换服务 + 结果缓存 |
| 中文译名不统一 | 以 GitHub 官方词汇表中文译本为准，写进 `NOTICE`/README 提供词条规范 |

## 13. 里程碑

| # | 内容 | 完成判据 |
|---|---|---|
| M1 | 仓库骨架 + 本 spec + 构建管线 | `node build.mjs` 能生成可安装的 `.user.js`（词典暂含少量条目） |
| M2 | 词典迁移与扩充 | 上游 1680 条清洗入库 + 自建补充；`dict-lint` 通过 |
| M3 | 翻译引擎（matcher/translator/observer） | 单测通过；手测首页/仓库页无残留英文且无误翻 |
| M4 | UI 面板与设置持久化 | 设置项全部即时生效并可持久化 |
| M5 | 正文翻译按钮 | 两个服务可用、可切换、可显示原文、命中缓存 |
| M6 | 发布 | 推送 GitHub，README 含安装链接，用 GitHub API 复核远端内容 |

## 14. 待用户审阅时可调整项

- `@name` 与文件名：当前定 `GitHub汉化插件` / `GitHub汉化插件.user.js`（无空格，保证「文件名 = @name」完全一致）。若你想保留空格（`GitHub 汉化插件`）请说明。
- 正文翻译默认服务：当前默认 `google`。
- 远程词典兜底：默认 `true`（仅在内嵌未命中时才请求 CDN）。
- 长度阈值（200 字符）与词数阈值（5 词）：当前为初值，手测后可调。
