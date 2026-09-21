# GitHub汉化插件

把 GitHub 界面汉化成简体中文的 Tampermonkey 用户脚本。

参考 [k1995/github-i18n-plugin](https://github.com/k1995/github-i18n-plugin) 的实现思路重新设计，
重点解决上游「部分名称仍是英文」的漏翻问题。

## 功能

- **UI 名称汉化**：导航栏、顶部菜单、按钮、标签页、下拉菜单、悬浮提示、弹窗、搜索结果字段。
- **属性文本汉化**：`aria-label` / `title` / `placeholder` / `data-confirm` / 按钮 `value`。
- **动态内容**：`MutationObserver` 增量处理 SPA 新增节点，进入 Shadow DOM（web component）。
- **相对时间中文化**：`<relative-time>` → 「3 个月前」，不依赖 timeago.js。
- **零 jQuery**：原生 DOM，无第三方运行时依赖。
- **正文按需翻译**：仓库描述 / README / 搜索结果条目旁的「译」按钮，点击才请求；
  支持 Google 与 gitcn.org 两个服务，可切换、可显示原文、结果缓存。
- **不误翻**：代码块、文件名、仓库名、用户名、分支名、topic、URL、邮箱一律保持原文。

## 安装

1. 浏览器先安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击安装：
   <https://raw.githubusercontent.com/jiebukai/github-cn/main/GitHub%E6%B1%89%E5%8C%96%E6%8F%92%E4%BB%B6.user.js>

脚本通过 `@updateURL` 自动更新。首次安装必须走以 `.user.js` 结尾的直链（Tampermonkey 的安装检测依赖该后缀）。

## 设置

页面右下角悬浮「译」按钮 → 打开设置面板：

| 设置 | 默认 | 说明 |
|---|---|---|
| 启用汉化 | 开 | 总开关，关闭后不翻译任何内容 |
| 翻译属性文本 | 开 | `aria-label` / `title` / `placeholder` / `data-confirm` / `data-content` |
| 相对时间中文化 | 开 | `<relative-time>` 显示为「3 个月前」 |
| 远程词典兜底 | 开 | 内嵌词典未命中时才请求 CDN 上的上游词典 |
| 正文「译」按钮 | 开 | 是否在描述 / README / 搜索结果旁注入按钮 |
| 正文翻译服务 | Google | 可切换为 gitcn.org |

设置即时保存（点击开关即写存储）。

## 与上游的区别

| 方面 | 上游 k1995 | 本项目 |
|---|---|---|
| 依赖 | jQuery + timeago.js（CDN） | 无 |
| 词典 | 1680 条，含 `__comments-*` 伪键 | 迁移后清洗 + 自建补充 |
| 遍历 | 整页递归 + 递归重扫 | TreeWalker + 增量 + 空闲分片 |
| Shadow DOM | 不处理 | 递归进入 `shadowRoot` |
| 属性文本 | 仅少量 css 规则 | 统一的属性翻译通道 |
| 带变量文本 | 无 | `patterns` 正则模板（`3 commits` → `3 次提交`） |
| 正文翻译 | 仅仓库描述，写死 gitcn.org | 描述/README/搜索条目，双服务可切换、可显示原文、带缓存 |
| 剪枝 | 黑白名单不完整（会把整棵子树漏掉） | 保守剪枝 + 标识符启发式 + 反例单测 |

## 开发

```bash
npm run build        # 生成 GitHub汉化插件.user.js
npm run check        # 只校验，不写文件（比对产物是否已最新）
npm run lint:dict    # 词典体检
npm test             # node --test tests/

# 覆盖率审计（Python 3，标准库）：抓公开页面 HTML，用与脚本同一份规则离线跑一遍，
# 输出命中率、被剪枝元素统计与「该翻但词典没有」的候选清单
python tools/audit-coverage.py
```

- 词典源在 `locales/`，脚本模板在 `src/userscript.template.js`，二者由 `build.mjs` 内联成单文件产物。
- `tools/import-upstream.mjs` 用于从上游拉取词条并转换合并（不复制上游代码）。

## 常见问题

**某处还是英文怎么办？**

1. 确认装的是本脚本、且是最新版：Tampermonkey 面板 →「检查更新」；页面控制台 `__ghI18n.version` 可查当前版本。
2. 如果同时装了 k1995 的上游插件，请**停用其一** —— 两个脚本会互相覆盖，不易判断谁在起作用。
3. 在页面控制台跑（`copy()` 会把结果放进剪贴板）：

   ```js
   // 列出本页「像 UI 名称、是英文、但词典未命中」的清单
   copy(__ghI18n.collect().join('\n'))

   // 报告某条文本为什么没被翻译（被剪枝 / 词典未命中 / 已被 SPA 覆盖）
   copy(JSON.stringify(__ghI18n.diagnose('Pull requests'), null, 2))
   ```

4. 把输出提到 [issue](https://github.com/jiebukai/github-cn/issues)，或直接补 `locales/zh-CN.json` 发 PR。

**为什么代码块、仓库名、用户名、分支名不翻译？**

刻意的：脚本用保守剪枝 + 标识符启发式（含 `-` `_` `.` `/` 的、camelCase/PascalCase、`MAX_RETRIES` 这类常量、URL、邮箱、纯数字/日期一律跳过），避免改坏用户内容。README 正文属长文本，只在点「译」时才机器翻译。

**正文的「译」按钮走哪个服务？**

默认 Google 翻译（`translate.googleapis.com`），可在设置面板切成 gitcn.org。请求由 `GM_xmlhttpRequest` 发出，**只在你点击时**触发；结果缓存在本地（键 `gh-i18n:cache`），设置面板可清空。

## 来源与许可

见 [NOTICE](./NOTICE)：词条部分迁移自 k1995/github-i18n-plugin（其源文件头部声明 `@license MIT`，
上游仓库未附 LICENSE 文件）；其余内容 MIT，见 [LICENSE](./LICENSE)。
