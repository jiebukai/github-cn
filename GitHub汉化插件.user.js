// ==UserScript==
// @name         GitHub汉化插件
// @namespace    https://github.com/jiebukai/github-cn/
// @version      1.0.4
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
// @supportURL   https://github.com/jiebukai/github-cn/issues
// @homepageURL  https://github.com/jiebukai/github-cn
// @downloadURL  https://raw.githubusercontent.com/jiebukai/github-cn/main/GitHub%E6%B1%89%E5%8C%96%E6%8F%92%E4%BB%B6.user.js
// @updateURL    https://raw.githubusercontent.com/jiebukai/github-cn/main/GitHub%E6%B1%89%E5%8C%96%E6%8F%92%E4%BB%B6.user.js
// ==/UserScript==

/**
 * GitHub汉化插件
 *
 * 由 build.mjs 从 src/userscript.template.js + src/engine.mjs + locales/*.json 生成，请勿直接编辑本文件。
 * 词条译名遵循 GitHub 官方词汇表中文译本；词条部分来源见仓库 NOTICE。
 */
(function () {
  'use strict';

  const DEBUG = false;
  const warn = (...a) => { if (DEBUG) console.debug('[gh-i18n]', ...a); };

  /* ======================================================================
   * 内联：纯函数层（构建期注入 src/engine.mjs）
   * ==================================================================== */
  /**
 * 纯函数层：文本归一化、词典/模板匹配、剪枝判定、相对时间格式化。
 *
 * 设计约束：这一层**不触碰 DOM**，因此可以被单元测试直接 import。
 * 构建时由 build.mjs 去掉 `export ` 前缀，内联进 GitHub汉化插件.user.js。
 */

/** 归一化词典键：NBSP → 空格、压缩连续空白、去首尾空白、转小写 */
function normKey(s) {
  return String(s == null ? '' : s)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 拆出首尾空白，便于只替换中间内容、不破坏行内布局 */
function splitEdges(raw) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(raw == null ? '' : raw));
  return { lead: m[1], body: m[2], trail: m[3] };
}

/** 词数（按空白分词） */
function wordCount(s) {
  const t = String(s == null ? '' : s).trim();
  return t ? t.split(/\s+/).length : 0;
}

const NUMERIC_RE = /^[\d\s.,:%+\-/()°]+$/;
const HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /(?:^|\s)(?:https?:\/\/|www\.)\S+/i;
const CODE_EXT_RE =
  /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|sh|ps1|bat|cmd|yml|yaml|json|json5|toml|ini|cfg|md|markdown|txt|css|scss|less|sass|html|htm|xml|svg|sql|kt|kts|swift|dart|lua|pl|pm|r|vue|svelte|lock|env)$/i;

/** 结构性文本：纯数字/日期/hex/邮箱/URL —— 永远不翻译 */
function isStructuralText(body) {
  const t = String(body || '').trim();
  if (!t) return true;
  if (NUMERIC_RE.test(t)) return true;
  if (HEX_RE.test(t)) return true;
  if (EMAIL_RE.test(t)) return true;
  if (URL_RE.test(t)) return true;
  return false;
}

/**
 * 标识符启发式：用户名 / 仓库名 / 分支名 / 文件名 / 常量 —— 不翻译。
 * 只对**不含空白**的文本生效（含空白的交给词典与模板判定）。
 */
function isIdentifierLike(body) {
  const t = String(body || '').trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;
  if (CODE_EXT_RE.test(t)) return true; // src/index.js、README.md
  if (/[-_./@:#=+~^]/.test(t)) return true; // owner/repo、feature-x、v1.2.3
  if (/^[A-Za-z]*\d+[A-Za-z0-9]*$/.test(t)) return true; // v2、2fa、utf8
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(t)) return true; // PascalCase
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+$/.test(t)) return true; // camelCase
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(t)) return true; // MAX_RETRIES
  return false;
}

/** 形状剪枝：返回跳过原因，或 null 表示可以进入词典匹配 */
function skipReason(body, options) {
  const maxLen = (options && options.maxLen) || 200;
  const t = String(body == null ? '' : body).trim();
  if (!t) return 'empty';
  if (t.length > maxLen) return 'too-long';
  if (isStructuralText(t)) return 'structural';
  if (isIdentifierLike(t)) return 'identifier';
  return null;
}

/**
 * 预编译模板正则。非法正则与带 g 标志的（会有 lastIndex 状态问题）被跳过/修正。
 */
function compilePatterns(patterns) {
  const out = [];
  for (const p of patterns || []) {
    if (!p || typeof p.re !== 'string' || typeof p.out !== 'string') continue;
    let re;
    try {
      re = new RegExp(p.re, String(p.flags || '').replace(/g/g, ''));
    } catch {
      continue;
    }
    out.push({ re, out: p.out });
  }
  return out;
}

/**
 * 本地匹配：归一化精确命中词典优先；未命中再按顺序试模板（首个命中即返回）。
 * @returns {string|null} 译文，或 null 表示无匹配
 */
function matchLocal(body, dict, patterns) {
  const raw = String(body == null ? '' : body);
  const key = normKey(raw);
  if (!key) return null;
  if (dict && Object.prototype.hasOwnProperty.call(dict, key)) {
    const v = dict[key];
    if (typeof v === 'string' && v && v !== key) return v;
    return null;
  }
  for (const p of patterns || []) {
    if (!p || !(p.re instanceof RegExp) || typeof p.out !== 'string') continue;
    if (p.re.test(raw)) return raw.replace(p.re, p.out);
  }
  return null;
}

const REL_UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/**
 * 相对时间中文化：过去 → 「3 个月前」，未来 → 「3 个月后」。
 * @returns {string|null} 无法解析的日期返回 null
 */
function formatRelativeTime(date, now, locale) {
  if (date == null || date === '') return null; // new Date(null) 会得到 1970，必须显式拦掉
  const d = date instanceof Date ? date : new Date(date);
  if (!d || Number.isNaN(d.getTime())) return null;
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const diffSec = (d.getTime() - nowDate.getTime()) / 1000;
  const abs = Math.abs(diffSec);
  let unit = 'second';
  let sec = 1;
  for (const [u, s] of REL_UNITS) {
    if (abs >= s) {
      unit = u;
      sec = s;
      break;
    }
  }
  const value = Math.round(diffSec / sec);
  try {
    return new Intl.RelativeTimeFormat(locale || 'zh-CN', { numeric: 'auto' }).format(value, unit);
  } catch {
    return null;
  }
}

  /* ======================================================================
   * 内联：词典与规则（构建期注入 locales/*.json）
   * ==================================================================== */
  const BUILTIN_DICT = {
    "(developer preview)": "（开发者预览版）",
    "(optional)": "(可选)",
    "(separate with spaces)": "（空格分隔）",
    "(undo)": "(撤销)",
    ", along with all of your forks, wikis, issues, pull requests, and github pages sites.": "以及您所有的复刻、维基、议题、拉取请求和 GitHub Pages 站点。",
    ", in the event of my death. i understand that this appointment of a successor does not override legally binding next-of-kin rules or estate laws of any relevant jurisdiction, and does not create a binding will.": "，在我死亡的情况下。我明白，这种指定继任者的做法并不凌驾于具有法律约束力的近亲规则或任何相关司法管辖区的遗产法，也不产生具有约束力的遗嘱。",
    ", or try cloning this repository via https.": "，或尝试通过 HTTPS 克隆此仓库。",
    ".": "。",
    ". exports will be available for 7 days.": "。导出结果将有 7 天有效期。",
    ". for more information about github's privacy practices, see the": "。有关 GitHub 隐私惯例的更多信息，请参阅",
    ". some good tag names might be": "。一些好的标签名称可能是",
    ". we won’t ask for your password again for a few hours.": " 。我们将在未来几个小时内不再要求您输入密码。",
    ". we'll occasionally send you account-related emails.": "。我们偶尔会向您发送与帐户相关的电子邮件。",
    ". would you like to update that as well?": "。您也想更新它吗？",
    ". your default notification email address is still set to": "。您的默认通知电子邮箱仍然设置为",
    ".gitignore template": ".gitignore 模板",
    ".gitignore template:": ".gitignore 模板:",
    "/ add new": "/ 新添",
    "30 days": "30天",
    "6-digit code": "6位验证码",
    "60 days": "60天",
    "7 days": "7天",
    "90 days": "90天",
    "__dict-end": "end",
    "a license tells others what they can and can't do with your code.": "许可证告诉其他人，他们可以使用您的代码做什么和不能做什么。",
    "a repository contains all project files, including the revision history. already have a project repository elsewhere?": "仓库包含项目中的所有文件，包括修订历史记录。在其他地方已有仓库？",
    "abandoned": "废弃",
    "able to merge.": "可以合并。",
    "about": "简介",
    "access": "访问权限",
    "access commit status": "访问提交状态",
    "access deployment status": "访问部署状态",
    "access notifications": "访问通知",
    "access public repositories": "访问公共仓库",
    "access repository invitations": "访问仓库邀请",
    "access user email addresses (read-only)": "访问用户电子邮件地址（只读）",
    "accessibility": "无障碍",
    "account": "账户",
    "account recovery": "帐户恢复",
    "account recovery with facebook is a simple way to recover your account.": "使用 Facebook 恢复帐户是一种恢复帐户的简单方法。",
    "account security": "帐户安全",
    "account settings": "帐户设置",
    "account? we won’t charge your payment information anymore.": "帐户吗？我们不会再收取您的付款信息。",
    "achievements": "成就",
    "action required": "需要采取行动",
    "actions": "操作",
    "active": "已激活",
    "activity log": "活动记录",
    "actor": "角色",
    "add": "添加",
    "add .gitignore": "添加 .gitignore 文件",
    "add a bulleted list <ctrl+shift+8>": "添加无序列表 <ctrl+shift+8>",
    "add a link <ctrl+k>": "添加链接 <ctrl+k>",
    "add a new public key": "添加新的公共密钥",
    "add a numbered list <ctrl+shift+7>": "添加有序列表 <ctrl+shift+7>",
    "add a numbered list <ctrl+shift+9>": "添加有序列表 <ctrl+shift+9>",
    "add a readme file": "添加 README 文件",
    "add a saved reply": "添加快捷回复",
    "add a short title to your reply": "为您的快捷回复添加简短的标题",
    "add a task list": "添加任务列表",
    "add all commits from the head branch onto the base branch individually.": "将来自头部分支的所有提交单独添加到基础分支。",
    "add all commits from the head branch to the base branch with a merge commit.": "使用合并提交将所有从头部分支的提交添加到基础分支。",
    "add an optional extended description": "添加可选的扩展描述",
    "add an optional extended description…": "添加可选的扩展描述…",
    "add bold text <ctrl+b>": "添加粗体文本 <ctrl+b>",
    "add email address": "添加电子邮箱",
    "add file": "添加文件",
    "add gpg key": "添加 GPG 密钥",
    "add header text": "添加标题文本",
    "add italic text <ctrl+i>": "添加斜体文本 <ctrl+i>",
    "add links to github sponsors or third-party methods your repository accepts for financial contributions to your project.": "添加指向 GitHub 赞助者或您的仓库接受的第三方收款链接，以便为您的项目提供资金捐助。",
    "add more commits by pushing to the": "添加更多的提交，推送到",
    "add review comment": "评论",
    "add rule": "添加规则",
    "add saved reply": "添加快捷回复",
    "add single comment": "添加评论",
    "add ssh key": "添加 SSH 密钥",
    "add successor": "添加继任者",
    "add your saved reply": "添加您的快捷回复",
    "added": "添加",
    "added a commit that referenced this issue": "添加了引用此议题的提交",
    "added the": "添加了",
    "additional navigation options": "更多导航选项",
    "advanced options": "高级选项",
    "advanced search": "高级搜索",
    "after pull requests are merged, you can have head branches deleted automatically.": "合并拉取请求后，您可以自动删除头部分支。",
    "ai code creation": "AI 代码生成",
    "ai-powered developer platform": "AI 驱动的开发者平台",
    "all": "所有",
    "all activity": "所有活动",
    "all checks have passed": "所有检查均已通过",
    "all commits from this branch will be added to the base branch via a merge commit.": "该分支的所有提交都将通过合并提交加入到基础分支中。",
    "all environments": "所有环境",
    "all gists": "所有片段",
    "all scheduled workflows will stop running.": "所有预定的工作流程将停止运行。",
    "all verified emails can now be used for password resets.": "所有已验证的电子邮箱现在均可用于密码重置。",
    "all workflows": "全部工作流程",
    "allow all verified emails": "允许所有已验证的电子邮箱",
    "allow auto-merge": "允许自动合并",
    "allow edits by maintainers": "允许维护者进行编辑",
    "allow merge commits": "允许提交合并",
    "allow rebase merging": "允许变基合并",
    "allow squash merging": "允许压缩合并",
    "alphabetically": "按字母顺序",
    "already have an account?": "已经有帐户吗？",
    "always": "总是",
    "an attachment with that filename already exists.": "该文件名的附件已经存在。",
    "and": "和",
    "and a lowercase letter": "和小写字母",
    "any": "所有",
    "any applications or scripts using this token will no longer be able to access the github api. you cannot undo this action.": "任何使用此令牌的应用程序或脚本将无法再访问 GitHub API。您无法撤消此操作。",
    "any commits you signed with this key will become unverified after removing it.": "删除后，您使用此密钥签名的任何提交都将变成未验证。",
    "any language": "任意语言",
    "any license": "任意许可证",
    "anyone on the internet can see this project. you choose who can make changes.": "互联网上的任何人都可以看到这个项目。您选择谁可以进行更改。",
    "anyone on the internet can see this repository. you choose who can commit.": "任何人都可以看到这个仓库，您可以选择谁能提交。",
    "app modernization": "应用现代化",
    "appearance": "外观",
    "appearance settings": "外观设置",
    "application security": "应用安全",
    "applications": "应用",
    "apply": "应用",
    "apply and reload": "应用并重新加载",
    "apply labels": "应用标签",
    "applying suggestions on deleted lines is not supported.": "不支持对删除的行应用建议。",
    "approve": "批准",
    "approved": "已批准",
    "approved review": "已批准的审查",
    "approved these changes": "批准修改",
    "apr": "4月",
    "april": "4月",
    "archive program": "归档计划",
    "archive repository": "归档仓库",
    "archive this repository": "归档仓库",
    "archived": "存档",
    "archives": "档案",
    "are entirely different commit histories.": "是完全不同的提交历史。",
    "are you absolutely sure?": "您完全确定吗？",
    "are you sure you don’t want to just": "您确定不希望仅仅是",
    "are you sure you want to delete this gpg key?": "您确定要删除此 GPG 密钥吗？",
    "are you sure you want to delete this issue?": "您确定要删除此议题吗？",
    "are you sure you want to delete this ssh key?": "您确定要删除此 SSH 密钥吗？",
    "are you sure you want to delete this token?": "您确定要删除此令牌吗？",
    "are you sure you want to discard your unsaved changes?": "您确定要丢弃您未保存的修改吗？",
    "are you sure you want to do this?": "您确定要这么做吗？",
    "are you sure?": "您确定哇?",
    "are your account recovery settings up to date? if not, you risk getting locked out of your account.": "您的帐户恢复设置是否最新？如果没有，您就有被锁定帐户的风险。",
    "artifacts": "附件",
    "as the default branch.": "为默认分支。",
    "assign": "分配",
    "assigned": "已分配",
    "assigned to nobody": "未分配给任何人",
    "assigned to the users": "分配给那些用户",
    "assignee": "受理人",
    "assignees": "受理人",
    "at least 15 characters": "至少需要15个字符",
    "at least 8 characters": "至少需要8个字符",
    "at least one email is required.": "至少需要一个电子邮箱。",
    "attach an image or video": "附加图片或视频",
    "attach binaries by dropping them here or selecting them.": "通过文件拖放到此处或选择它们来附加文件。",
    "attach files by dragging & dropping, selecting or pasting them.": "通过拖放，选择或粘贴来附加文件。",
    "attach files by selecting or pasting them.": "通过选择或粘贴来附加文件。",
    "attaching documents requires write permission to this repository.": "附加文件需要对该仓库拥有写入权限。",
    "aug": "8月",
    "august": "8月",
    "authenticate to the api over basic authentication": "通过 Basic Authentication 对 API 进行身份验证",
    "authentication code": "验证码",
    "authenticator app": "身份验证器应用",
    "author": "作者",
    "authored": "撰写",
    "authorized": "权限",
    "authorized oauth apps": "已授权的 OAuth 应用",
    "auto": "自动",
    "autogenerate table of contents for markdown files in this repository. the table of contents will be displayed near the top of the file.": "自动生成此仓库中 Markdown 文件的目录。目录将显示在文件顶部附近。",
    "automate any workflow": "自动化任何工作流",
    "automated kanban": "自动化看板",
    "automated kanban with reviews": "带审查的自动看板",
    "automatically delete head branches": "自动删除头部分支",
    "automatically detect common vulnerability and coding errors": "自动检测常见漏洞和编码错误",
    "available add-ons": "可用的附加组件",
    "awaiting review from you": "等待您审查",
    "awaiting review from you or your team": "等待您或您的团队的审查",
    "awaiting review from you specifically": "特别等待您审查",
    "back": "返回",
    "back to github": "返回到 GitHub",
    "back to notifications": "回到通知",
    "backup email address": "备用电子邮箱",
    "base repository:": "基础仓库:",
    "base:": "基础:",
    "basic kanban": "基础看板",
    "basic kanban-style board with columns for to do, in progress and done.": "基础风格看板，带有待办、进行中和已完成等栏目。",
    "be undone. this will permanently delete the": "被撤消。这将永久删除",
    "be undone. this will permanently delete the gpg key, and if you’d like to use it in the future, you will need to upload it again.": "被撤销。这将永久地删除 GPG 密钥，如果您想在未来使用它，您将需要再次上传它。",
    "be undone. this will permanently delete the ssh key and if you’d like to use it in the future, you will need to upload it again.": "被撤销。这将永久地删除 SSH 密钥，如果您想在未来使用它，您将需要再次上传它。",
    "because you have email privacy enabled,": "因为您已经启用了电子邮箱隐私，",
    "beep bop! tokens that live forever are scary. expiration dates are highly recommended!": "哔哔！永不过期的令牌是可怕的。强烈建议设置有效期！",
    "before you archive, please consider:": "在您归档之前，请考虑：",
    "begin import": "开始导入",
    "below:": "在下面:",
    "best match": "最佳匹配",
    "billable time": "计费时间",
    "billing": "帐单",
    "billing & plans": "计费 & 计划",
    "billing and licensing": "账单与许可",
    "billing and plans": "账单与套餐",
    "bio": "个人简介",
    "block command line pushes that expose my email": "阻止在命令行推送中暴露我的电子邮箱",
    "blocked users": "黑名单",
    "blog": "博客",
    "body": "内容",
    "bot": "机器人",
    "branch": "分支",
    "branch can be safely deleted.": "分支可以被安全删除。",
    "branch created.": "分支已成功创建。",
    "branch has unmerged commits.": "分支具有未合并的提交。",
    "branch has unmerged commits. you can delete this branch if you wish.": "分支具有未合并的提交。您可以根据需要删除此分支。",
    "branch on": "分支在",
    "branch protection rules": "分支保护规则",
    "branch.": "分支。",
    "branch:": "分支:",
    "branches": "分支",
    "branches, tags, commit ranges, and time ranges. in the same repository and across forks.": "分支、标签、提交范围和时间范围。 在同一个仓库中并跨分支。",
    "browse files": "浏览文件",
    "browse repository at this point": "浏览该时间点的仓库",
    "browse the repository at this point in the history": "在历史记录中的浏览仓库",
    "browse your starred repositories and topics": "浏览我的标星仓库和话题",
    "bug triage": "BUG 分类",
    "built for developers": "专为开发者打造",
    "business insights": "业务洞察",
    "by company size": "按公司规模",
    "by creating an account, you agree to the": "创建帐户即表示您同意",
    "by industry": "按行业",
    "by sending a one-time password to all addresses associated with this account.": "用于通过向该帐户关联的所有地址发送一次性密码。",
    "by use case": "按使用场景",
    "cancel": "取消",
    "cancel changes": "取消更改",
    "cancel plan and delete this account": "取消计划并删除此帐户",
    "cancel review": "取消审查",
    "cancelled": "已取消",
    "cannot": "不能",
    "cannot be merged until marked ready for review": "在标记为可供审查之前，不能合并",
    "can’t access your two-factor device or valid recovery codes?": "无法访问您的双因素验证设备或有效的恢复码？",
    "can’t automatically merge.": "无法自动合并。",
    "change my username": "更改我的用户名",
    "change notification settings": "更改通知设置",
    "change password": "更改密码",
    "change repository visibility": "更改仓库可见性",
    "change requested": "更改请求",
    "change the default name in": "改变默认名称在",
    "change this file’s name": "更改文件名称",
    "change username": "更改用户名",
    "change visibility": "更改可见性",
    "changed the title": "更改了标题",
    "changelog": "更新日志",
    "changes": "更改",
    "changes approved": "变更已获批准",
    "changes requested": "已请求更改",
    "changing your username can have": "更改用户名可能会有",
    "check it out here!": "看看这里！",
    "check out our guide to": "请看我们的指南",
    "checking for ability to merge automatically…": "检测自动合并的能力…",
    "checking mergeability…": "检查可合并性…",
    "checks": "检查",
    "choose .gitignore:": "选择 .gitignore:",
    "choose a base branch": "选择一个基础分支",
    "choose a base ref": "选择一个基础引用",
    "choose a base repository": "选择基础仓库",
    "choose a head ref": "选择一个头引用",
    "choose a head repository": "选择头部仓库",
    "choose a license": "选择许可证",
    "choose a new username": "选择一个新用户名",
    "choose a registry": "选择一个包托管服务",
    "choose a tag": "选择标签",
    "choose a tag to compare": "选择一个标签进行比较",
    "choose a template": "选择模板",
    "choose a theme": "选择一个主题",
    "choose an existing tag, or create a new tag on publish": "选择一个现有的标签，或在发布时创建一个新标签",
    "choose different branches or forks above to discuss and review changes.": "在上方选择其他分支或复刻以讨论和查看更改。",
    "choose how github looks to you. select a single theme, or sync with your system and automatically switch between day and night themes.": "选择 GitHub 在您眼中的样子。选择单一主题，或与您的系统同步并自动在白天和夜晚的主题之间切换。",
    "choose how github looks to you. select a single theme, or sync with your system and automatically switch between day and night themes. selections are applied immediately and saved automatically.": "选择 GitHub 的显示外观。可以选定单一主题，或与你的系统同步、在日间与夜间主题之间自动切换。选择会立即应用并自动保存。",
    "choose the default branch for your new personal repositories. you might want to change the default name due to different workflows, or because your integrations still require “master” as the default branch name. you can always change the default branch name on individual repositories.": "为您新的个人仓库选择默认的分支。由于工作流程的不同，或者由于您的集成仍然需要 “master ”作为默认分支名，您可能想改变默认名称。您可以随时改变个人仓库的默认分支名称。",
    "choose two branches to see what’s changed or to start a new pull request. if you need to, you can also": "选择两个分支以比较差异或启动新的拉取请求。如果需要，您也可以",
    "choose which files not to track from a list of templates.": "从模板列表中选择哪些文件不需要跟踪。",
    "clear current search query, filters, and sorts": "清除当前的搜索查询、过滤器和排序方式",
    "clear filter": "清除过滤器",
    "clear out the clutter.": "清除混乱。",
    "clone": "克隆",
    "clone via https": "通过 HTTPS 方式克隆",
    "clone via ssh": "通过 SSH 方式克隆",
    "clone with an ssh key and passphrase from your github settings.": "通过 GitHub 设置中的 SSH 密钥和密码进行克隆。",
    "clone with git or checkout with svn using the repository’s web address.": "通过仓库 web 地址进行 Git 克隆或 SVN 检出。",
    "clone with https": "通过 HTTPS 方式克隆",
    "clone with ssh": "通过 SSH 方式克隆",
    "close": "关闭",
    "close issue": "关闭议题",
    "close pull request": "关闭拉取请求",
    "close with comment": "评论并关闭议题",
    "closed": "已关闭",
    "closed this": "关闭了这个",
    "closed with unmerged commits": "已关闭未合并的提交",
    "closing all open issues and pull requests": "关闭所有打开的议题和拉取请求",
    "code": "代码",
    "code definitions": "代码定义",
    "code navigation index up-to-date": "代码导航索引最新",
    "code navigation not available for this commit": "该提交的代码导航不可用",
    "code of conduct": "行为准则",
    "code options": "代码选项",
    "code quality": "代码质量",
    "code review": "代码审查",
    "code scanning": "代码扫描",
    "code scanning alerts": "代码扫描警报",
    "code security": "代码安全",
    "code, planning, and automation": "代码、规划与自动化",
    "codespaces": "代码空间",
    "collaborator": "合作者",
    "collaborators have access to this repository. only you can contribute to this repository.": "个协作者有权访问此仓库。 只有您可以对此仓库做出贡献。",
    "collections": "集合",
    "colorblind": "色觉障碍",
    "combine all commits from the head branch into a single commit in the base branch.": "将来自头部分支的所有提交合并到基础分支中的单个提交中。",
    "comment": "评论",
    "comment on this commit": "评论",
    "commented": "评论于",
    "comments": "评论",
    "commit": "提交",
    "commit changes": "提交更改",
    "commit comments": "评论",
    "commit directly to the": "直接提交到",
    "commit merge": "提交合并",
    "commit new file": "提交新文件",
    "commits": "提交",
    "commits pushed to github using this email will still be associated with your account.": "使用此电子邮箱推送到 GitHub 的提交仍将与您的帐户相关联。",
    "commits pushed with a private email will no longer be blocked.": "使用私人电子邮箱推送的提交将不再被阻止。",
    "commits pushed with a private email will now be blocked and you will see a warning.": "使用私人电子邮箱推送的提交将被阻止，您会看到一个警告。",
    "committed": "提交",
    "committed to this repository in the past day": "过去一天致力于此仓库",
    "committed to this repository in the past week": "过去一周致力于此仓库",
    "common ssh problems": "常见的 SSH 问题",
    "community": "社区",
    "community forum": "社区论坛",
    "company": "公司",
    "compare": "对比",
    "compare & pull request": "对比 & 拉取请求",
    "compare across forks": "跨复刻比较",
    "compare and review just about anything": "比较和审查几乎任何东西",
    "compare changes": "比对差异",
    "compare changes across branches, commits, tags, and more below. if you need to, you can also": "比对不同分支、提交、标签等的差异。如果需要，您也可以",
    "compare:": "对比:",
    "comparing changes": "比对差异",
    "completed": "已完成",
    "configured": "已配置",
    "confirm": "确认",
    "confirm access": "授权访问",
    "confirm merge": "确认合并",
    "confirm new password": "确认新密码",
    "confirm password": "确认密码",
    "confirm password to continue": "确认密码以继续",
    "confirm your account recovery settings": "确认您的帐户恢复设置",
    "confirmed": "已确认",
    "conflicting files": "冲突的文件:",
    "contact": "联系",
    "contact github": "联系 GitHub",
    "continue": "继续",
    "contrast": "对比度",
    "contribute": "贡献",
    "contributing": "贡献指南",
    "contributing guidelines": "贡献指南",
    "contribution activity": "贡献动态",
    "contribution settings": "贡献设置",
    "contributions": "贡献",
    "contributor": "贡献者",
    "contributors": "贡献者",
    "conversation": "对话",
    "convert this pull request to draft?": "将此拉取请求转换为草案？",
    "convert to draft": "设置为草案",
    "coordinate, track, and update your work in one place, so projects stay transparent and on schedule.": "在这里协调、跟踪和更新您的工作，使项目保持透明和按计划进行。",
    "copied": "已复制",
    "copied!": "已复制！",
    "copilot for business": "面向企业的 Copilot",
    "copy": "复制",
    "copy line": "复制行",
    "copy lines": "复制行",
    "copy link": "复制链接",
    "copy path": "复制路径",
    "copy permalink": "复制永久链接",
    "copy raw contents": "复制原码内容",
    "copy sharable link for this gist.": "复制片段共享链接。",
    "copy the full sha": "复制完整的 SHA",
    "create": "创建",
    "create a": "创建一个",
    "create a merge commit": "创建合并提交",
    "create a new branch for this commit and start a pull request. learn more about pull requests.": "为此提交创建一个新分支，并启动拉取请求。",
    "create a new project": "创建一个新项目",
    "create a new pull request by comparing changes across two branches. if you need to, you can also": "通过比较两个分支之间的更改来创建新的拉取请求。如果需要，您也可以",
    "create a new release": "创建发行版",
    "create a new repository": "创建一个新仓库",
    "create a new saved reply…": "创建新的快捷回复…",
    "create a password": "创建密码",
    "create account": "创建帐户",
    "create an account": "新建帐户",
    "create an issue": "创建一个议题",
    "create an organization": "创建一个组织",
    "create dependabot security update": "创建可靠的安全更新",
    "create draft pull request": "创建拉取请求草案",
    "create gists": "创建 Gist",
    "create issue": "创建议题",
    "create label": "创建标签",
    "create list": "创建一个列表",
    "create new file": "新建文件",
    "create new filter": "创建新规则",
    "create project": "创建项目",
    "create public gist": "创建公开片段",
    "create pull request": "创建拉取请求",
    "create redirects for your repositories (web and git access).": "为您的仓库设置重定向（ web 和 git 访问）。",
    "create release": "创建发行版",
    "create repository": "新建仓库",
    "create secret gist": "创建私密片段",
    "create status badge": "创建状态徽章",
    "created": "已创建",
    "created on the dates": "创建于何时",
    "credentials": "凭据",
    "custom": "自定义",
    "custom domain": "自定义域",
    "custom domains allow you to serve your site from a domain other than": "自定义域允许您从其他域为您的站点提供服务，而不是",
    "custom...": "自定义...",
    "customer stories": "客户案例",
    "customer support": "客户支持",
    "customize": "自定义",
    "customize your pins": "自定义您的置顶项目",
    "danger zone": "危险区",
    "dark default": "深色（默认）",
    "dark dimmed": "昏暗",
    "dark high contrast": "高对比暗",
    "dark mode": "深色模式",
    "dark theme": "深色主题",
    "dashboard": "仪表盘",
    "date": "日期",
    "date range:": "时间范围",
    "day theme": "日间主题",
    "dec": "12月",
    "december": "12月",
    "default": "默认",
    "default branch": "默认分支",
    "default dark": "默认 - 暗",
    "default light": "默认 - 亮",
    "default replies": "默认回复",
    "define branch protection rules to disable force pushing, prevent branches from being deleted, and optionally require status checks before merging. new to branch protection rules?": "定义分支保护规则，以禁止强制推送，防止分支被删除，并可选择要求在合并前进行状态检查。对分支保护规则感到陌生？",
    "define how users should report security vulnerabilities for this repository": "定义用户应如何报告此仓库的安全漏洞",
    "delete": "删除",
    "delete account": "删除账户",
    "delete all logs": "删除所有日志",
    "delete branch": "删除分支",
    "delete directory": "删除文件夹",
    "delete file": "删除文件",
    "delete issue": "删除议题",
    "delete packages from github package registry": "从 GitHub 包注册表中删除包",
    "delete personal access token": "删除个人访问令牌",
    "delete repositories": "删除仓库",
    "delete revision from history": "从历史记录中删除修订",
    "delete the file in your fork of this project": "在您的复刻中删除该文件",
    "delete this draft": "删除草案",
    "delete this file": "删除本文件",
    "delete this issue": "删除议题",
    "delete this release": "删除发行版",
    "delete this repository": "删除仓库",
    "delete this token": "删除令牌",
    "delete workflow run": "删除工作流程运行",
    "delete your account": "删除帐户",
    "deleted branches will still be able to be restored.": "删除的分支仍然可以恢复。",
    "deleted repositories": "删除的仓库",
    "deleted the": "删除",
    "deleting issue…": "议题删除中…",
    "deleting your user account": "删除您的帐户",
    "deletion will remove the issue from search and previous references will point to a placeholder": "删除将从搜索中删除该议题，以前的引用将指向一个占位符",
    "dependabot alerts": "Dependabot 警报",
    "dependencies": "依赖",
    "deployed to github-pages": "部署到 github-pages",
    "describe this release": "发行版描述",
    "description": "描述",
    "designated below": "下面指定的",
    "details": "细节",
    "deuteranopia": "绿色盲",
    "developer settings": "开发者设置",
    "developer workflows": "开发者工作流",
    "developers": "开发者",
    "device:": "设备：",
    "direct access": "直接访问",
    "direct agents from issue to merge": "让智能体从议题直达合并",
    "directly mention a user or team": "直接提及用户或团队",
    "disable": "停用",
    "disable workflow": "禁用工作流程",
    "discard draft": "丢弃草案",
    "discuss and review the changes in this comparison with others.": "与他人讨论并回顾此次对比中的变化。",
    "discussions": "讨论",
    "discussions are not enabled for this repo": "此仓库未启用讨论功能",
    "discussions is the space for your community to have conversations, ask questions and post answers without opening issues.": "讨论是您的社区进行对话、提问和发布答案的地方，而无需打开议题。",
    "dismiss": "关闭",
    "dismiss alert": "忽略警告",
    "dismiss for all repositories": "在所有仓库关闭",
    "dismiss for this repository only": "仅在此仓库关闭",
    "display a \"sponsor\" button": "显示 “赞助” 按钮",
    "display pro badge": "显示 Pro 徽章",
    "do not share my personal information": "不要分享我的个人信息",
    "docs": "文档",
    "documentation": "文档",
    "done": "已完成",
    "don’t worry, you can still create the pull request.": "别担心，您仍然可以创建拉取请求。",
    "downgrade your account": "降级您的帐户",
    "download": "下载",
    "download deleted": "导出内容已删除",
    "download log archive": "下载日志存档",
    "download packages from github package registry": "从 GitHub 包注册表下载包",
    "download template": "下载模板",
    "download zip": "下载 Zip 压缩包",
    "downloads": "下载",
    "draft": "草案",
    "draft a new release": "起草发行版",
    "draft pull request": "拉取请求草案",
    "draft pull requests cannot be merged.": "拉取请求草案不能被合并。",
    "duplicate tag name": "重复的标签名称",
    "duplicate the repository": "复制仓库",
    "ebooks & reports": "电子书与报告",
    "edit": "编辑",
    "edit file": "编辑文件",
    "edit new file": "编辑新文件",
    "edit personal access token": "编辑个人访问令牌",
    "edit profile": "编辑个人资料",
    "edit release": "编辑发行版",
    "edit repository details": "编辑仓库详情",
    "edit saved reply": "编辑快捷回复",
    "edit the file in your fork of this project": "在您的复刻中编辑该文件",
    "edit them?": "编辑他们？",
    "edit this file": "编辑本文件",
    "edited": "编辑",
    "editing": "编辑",
    "email address": "电子邮箱地址",
    "email is invalid or already taken": "电子邮件无效或已被占用",
    "email preferences": "邮件首选项",
    "email settings": "电子邮箱设置",
    "emails": "邮箱",
    "embed": "嵌入",
    "embed this gist in your website.": "嵌入到您的网页中。",
    "emoji skin tone preference": "表情符号肤色偏好",
    "enable": "启用",
    "enable dependabot alerts": "启用 Dependabot 警报",
    "enable high contrast for light or dark mode (or both) based on your system settings": "根据你的系统设置，为浅色或深色模式（或两者）启用高对比度",
    "enable workflow": "启用工作流程",
    "enabled": "启用",
    "enforce https": "强制执行 HTTPS",
    "enforce quality at merge": "在合并时保证质量",
    "engage your community by having discussions right in your repository, where your community already lives": "通过在您的社区已经存在的仓库中进行讨论来吸引您的社区",
    "enter a new username": "输入一个新用户名",
    "enter a two-factor recovery code": "输入恢复码",
    "enter a username": "输入您的用户名",
    "enter recovery code": "输入恢复码",
    "enter your email": "输入您的邮箱地址",
    "enterprise": "企业",
    "enterprise platform": "企业平台",
    "enterprise solutions": "企业解决方案",
    "enterprise-grade 24/7 support": "企业级 7×24 支持",
    "enterprise-grade ai features": "企业级 AI 功能",
    "enterprise-grade security features": "企业级安全功能",
    "enterprises": "企业",
    "environments": "环境",
    "event": "事件",
    "event trigger.": "事件触发器。",
    "events": "事件",
    "events & webinars": "活动与网络研讨会",
    "everything assigned to you": "所有分配给您的",
    "everything included in the automated kanban template with additional triggers for pull request reviews.": "除了包含自动化看板模板中的所有内容，还有拉取请求审查的额外触发器。",
    "everything mentioning you": "所有提到您的",
    "excellent! this tag will be created from the target when you publish this release.": "优秀! 当您发布这个版本时，这个标签将从目标创建。",
    "existing tag": "现有标签",
    "expiration": "有效期",
    "explore": "探索",
    "explore by topic": "按主题探索",
    "explore by type": "按类型探索",
    "explore more →": "探索更多",
    "explore quick start templates": "探索快速启动模板",
    "explore repositories": "探索仓库",
    "export account data": "导出帐户数据",
    "export all repositories and profile metadata for": "导出所有仓库和配置元数据，自",
    "extend github": "拓展GitHub",
    "extra attention is needed": "需要额外注意",
    "failure": "失败",
    "fallback sms number": "备用手机号码",
    "feature preview": "功能预览",
    "features": "功能",
    "feb": "2月",
    "february": "2月",
    "fetch and merge": "获取并合并",
    "fetch upstream": "获取上游",
    "fewest forks": "最少复刻",
    "fewest issues": "议题最少",
    "fewest stars": "最少星标",
    "file filter": "文件过滤",
    "file successfully deleted.": "文件已成功删除。",
    "filename including extension…": "文件名 (包括扩展名)",
    "files changed": "文件变更",
    "filter": "过滤",
    "filter branches/tags": "过滤分支/标签",
    "filter branches…": "过滤分支…",
    "filter by actor": "按角色过滤",
    "filter by author": "按作者过滤",
    "filter by branch": "按分支过滤",
    "filter by context": "过滤内容",
    "filter by event": "按事件过滤",
    "filter by label": "按标签过滤",
    "filter by milestone": "按里程碑过滤",
    "filter by organization or owner": "按组织或所有者过滤",
    "filter by project": "按项目过滤",
    "filter by reviews": "按审查过滤",
    "filter by status": "按状态过滤",
    "filter by this user": "按此用户筛选",
    "filter by who’s assigned": "过滤受理人",
    "filter changed files": "过滤更改的文件",
    "filter definitions": "过滤定义",
    "filter file types": "过滤文件类型",
    "filter ignores…": "过滤忽略…",
    "filter inbox by…": "过滤收件箱…",
    "filter issues": "过滤议题",
    "filter labels": "过滤标签",
    "filter licenses...": "过滤许可证…",
    "filter milestones": "过滤里程碑",
    "filter notifications": "过滤通知",
    "filter options": "过滤选项",
    "filter organizations": "按组织过滤",
    "filter projects": "过滤项目",
    "filter replies…": "过滤回复",
    "filter repos": "过滤仓库",
    "filter users": "过滤用户",
    "filter viewed files": "过滤已查看文件",
    "filter workflow runs": "过滤工作流程",
    "filters": "过滤",
    "financial services": "金融服务",
    "find a branch": "查找分支",
    "find a repository…": "搜索仓库…",
    "find a status": "查找状态",
    "find a tag": "查找标签",
    "find a user": "查找用户",
    "find an event": "查找事件",
    "find and fix vulnerabilities": "发现并修复漏洞",
    "find or create a branch…": "查找或创建分支…",
    "find or create a new tag": "查找或创建新标签",
    "find tools to improve your workflow": "寻找改进工作流程的工具",
    "finish your review": "完成审查",
    "first we need to verify an email address": "首先，我们需要验证一个电子邮箱地址",
    "flag unsigned commits as unverified": "将未签名的提交标记为未验证",
    "follow": "关注",
    "follow and unfollow users": "关注和取消关注用户",
    "follower": "关注者",
    "followers": "关注者",
    "following": "关注",
    "footer": "页脚",
    "footer navigation": "页脚导航",
    "for more help, read our article \"": "如需更多帮助，请阅读我们的文章\"",
    "for security reasons, you cannot change the visibility of a fork.": "出于安全原因，您无法更改复刻仓库的可见性。",
    "for this commit and start a pull request.": "用于此提交并启动拉取请求。",
    "for this commit. your pull request will be updated automatically.": "对于这次提交。您的拉取请求将被自动更新。",
    "forgot password?": "忘记密码？",
    "fork": "复刻",
    "forked": "复刻",
    "forked from": "复刻自",
    "forks": "复刻",
    "fortune 50": "财富 50 强",
    "free": "免费",
    "friday": "星期五",
    "from these owners": "来自那些所有者",
    "from this location": "位置",
    "full control of enterprises": "完全控制企业",
    "full control of organization hooks": "完全控制组织挂钩",
    "full control of orgs and teams, read and write org projects": "完全控制组织和团队，读写组织项目",
    "full control of private repositories": "完全控制私有仓库",
    "full control of public user gpg keys": "完全控制公共用户 GPG 密钥",
    "full control of repository hooks": "完全控制仓库挂钩",
    "full control of user public keys": "完全控制用户公钥",
    "fund open source developers": "资助开源开发者",
    "further information is requested": "要求提供更多信息",
    "generate a gpg key and add it to your account": "生成 GPG 密钥并将其添加到您的帐户",
    "generate new token": "生成新令牌",
    "generate token": "生成令牌",
    "generating an automated security update": "生成自动安全更新",
    "generating ssh keys": "生成 SSH 密钥",
    "get notified when one of your dependencies has a vulnerability": "当您的一个依赖项存在漏洞时得到通知",
    "get organized with issue templates": "使用议题模板进行组织",
    "get started": "开始",
    "get started with discussions": "开始讨论",
    "get started with github packages": "开始使用 GitHub 包",
    "get the most out of your new inbox by quickly and easily marking all of your previously read notifications as done.": "快速轻松地将所有已阅读的通知标记为已完成，以充分利用新的收件箱。",
    "gist description…": "片段描述",
    "git lfs usage in archives is billed at the same rate as usage with the client.": "归档中的 Git LFS 使用率与客户端的使用率相同。",
    "github advanced security": "GitHub 高级安全",
    "github archive program": "GitHub 存档计划中",
    "github community guidelines": "GitHub 社区准则",
    "github copilot app": "GitHub Copilot 应用",
    "github developer program": "GitHub 开发人员计划",
    "github is built for collaboration. set up an organization to improve the way your team works together, and get access to more features.": "GitHub 是为协作而创建的。 建立组织以改善团队合作的方式，并获得更多功能。",
    "github pages is currently disabled. select a source below to enable github pages for this repository.": "GitHub Pages 目前已被禁用。在下面选择一个源，为该仓库启用 GitHub Pages。",
    "github privacy statement": "GitHub 隐私声明",
    "github skills": "GitHub 技能",
    "github sponsors": "GitHub 赞助",
    "github support will review your request": "GitHub Support 将审查您的请求",
    "github theme will match your system active settings": "GitHub 主题将匹配您的系统设置",
    "github will use your selected theme": "GitHub 将使用您选择的主题",
    "give contributors issue templates that help you cut through the noise and help them push your project forward.": "为贡献者提供议题模板，帮助您消除干扰并帮助他们推进您的项目。",
    "go to definition": "跳转到定义",
    "go to docs": "查看文档",
    "go to file": "文件查找",
    "go to line": "跳转到行",
    "go to your personal profile": "去我的个人资料",
    "good for newcomers": "适合新人",
    "government": "政府",
    "gpg keys": "GPG 密钥",
    "great repository names are short and memorable. need inspiration? how about": "好的仓库名称应该简单且容易记忆。需要灵感吗？这个怎么样：",
    "group by:": "分组:",
    "hang in there while we check the branch’s status.": "请等待，我们正在检查该分支的状态",
    "having problems?": "有问题吗？",
    "head repository:": "头部仓库:",
    "heads up, this will commit to master.": "注意：将提交到 master",
    "healthcare": "医疗健康",
    "help": "帮助",
    "help your community understand how to securely report security vulnerabilities for your project.": "帮助您的社区了解如何安全地报告项目的安全漏洞。",
    "hide": "隐藏",
    "hide all checks": "隐藏所有检查",
    "hide all reviewers": "隐藏所有审查人",
    "hide details": "隐藏细节",
    "hide resolved": "隐藏已解决",
    "hide this repository from the public.": "向公众隐藏这个仓库。",
    "hide thumbnails": "隐藏缩略图",
    "hide viewed files": "隐藏已查看文件",
    "hide whitespace changes": "隐藏空白更改",
    "high severity": "高风险",
    "highlights": "高光时刻",
    "history": "历史",
    "home": "首页",
    "hours ago": "小时前",
    "https provides a layer of encryption that prevents others from snooping on or tampering with traffic to your site.": "HTTPS 提供了一个加密层，防止他人窥探或篡改您站点的流量。",
    "i forgot my password": "我忘记了我的密码",
    "i understand the consequences, archive this repository": "我明白后果，依然存档该仓库",
    "i understand the consequences, delete this repository": "我明白后果，依然删除该仓库",
    "i understand the consequences, unarchive this repository": "我明白后果，依然解除该仓库存档",
    "i understand, change repository visibility.": "我明白了，依然更改该仓库的可见性。",
    "i understand, continue updating master": "我明白了，继续更新 master",
    "i understand, delete this gpg key": "我明白了，依然删除该 GPG 密钥",
    "i understand, delete this token": "我明白了，依然删除该令牌。",
    "i understand, get started": "我知道了，开始吧",
    "i understand, let’s change my username": "我明白了，依然更改我的用户名",
    "i understand, please delete this ssh key": "我明白了，依然删除该 SSH 密钥",
    "i understand, transfer this repository.": "我明白了，依然转让该仓库。",
    "if the tag isn’t meant for production use, add a pre-release version after the version name. some good pre-release versions might be": "如果标签不是用于生产的，就在版本名后面加上预发布版本。一些好的预发布版本可能是",
    "if you can locate your two-factor recovery codes you can skip this recovery process.": "如果您能找到您的双因素恢复码，您可以跳过这个恢复过程。",
    "if you can’t access a verified device or recovery codes you can request a reset of your authentication settings. for security reasons": "如果您无法访问已验证的设备或恢复码，您可以请求重置您的验证设置。出于安全考虑",
    "if you wish, you can also delete this fork of": "如果需要，还可以删除此复刻",
    "if you wish, you can delete this fork of": "如果需要，可以删除此复刻",
    "if you’ve lost or forgotten this token, you can regenerate it, but be aware that any scripts or applications using this token will need to be updated.": "如果您丢失或忘记了此令牌，则可以重新生成它，但请注意，需要更新使用此令牌的任何脚本或应用程序。",
    "ignore": "忽略",
    "ignoring": "忽略",
    "images should be at least 640×320px (1280×640px for best display).": "图片至少应为 640×320 像素（1280×640 像素以获得最佳显示效果）。",
    "import a repository.": "导入仓库",
    "import all the files, including the revision history, from another version control system.": "从其他版本控制系统导入所有文件，包括修订历史记录。",
    "import repository": "导入仓库",
    "import your project to github": "导入您的项目到 GitHub",
    "improvements or additions to documentation": "文档的改进或补充",
    "in github help.": "在 GitHub 帮助中所示。",
    "in progress": "正在进行中",
    "in the": "在",
    "in the state": "状态",
    "in these repositories": "来自那些仓库",
    "in this path": "文件路径",
    "inbox": "收件箱",
    "include git lfs objects in archives": "在档案中包含 Git LFS 对象",
    "include in the home page": "包含在主页中",
    "include private contributions on my profile": "在我的个人资料中显示私人共享",
    "include this code in the": "将此代码包含在",
    "including a number": "包括数字",
    "including forks.": "包括复刻",
    "incorrect username or password.": "用户名或密码不正确。",
    "increase contrast": "提高对比度",
    "indent mode": "缩进模式",
    "indent size": "缩进大小",
    "initialize this repository with:": "使用以下方式初始化此仓库：",
    "insert a quote <ctrl+.>": "插入引用 <ctrl+.>",
    "insert a quote <ctrl+shift+.>": "插入引用 <ctrl+shift+.>",
    "insert a reply": "插入回复",
    "insert a suggestion <ctrl+g>": "插入建议 <ctrl+g>",
    "insert code <ctrl+e>": "插入代码 <ctrl+e>",
    "insights": "洞察",
    "installed github apps": "安装 GitHub 应用",
    "instant dev environments": "即时开发环境",
    "instantly share code, notes, and snippets.": "即时分享您的代码，笔记，片段，以及灵感。",
    "integrate external tools": "集成外部工具",
    "integrations": "集成",
    "interaction limits": "互动限制",
    "into": "到",
    "invalid tag name": "无效的标签名称",
    "invite a collaborator": "邀请协作者",
    "is designed to host your personal, organization, or project pages from a github repository.": "旨在从 GitHub 仓库托管您的个人、组织或项目页面。",
    "issue": "议题",
    "issues": "议题",
    "issues are used to track todos, bugs, feature requests, and more. as issues are created, they’ll appear here in a searchable and filterable list. to get started, you should": "议题用于跟踪待办事项、错误、功能请求等。创建议题后，它们将显示在可搜索和可过滤的列表中。如果要开始，您应该",
    "issues integrate lightweight task tracking into your repository. keep projects on track with issue labels and milestones, and reference them in commit messages.": "议题将轻量级任务跟踪集成到您的仓库中。使用议题标签和里程碑保持项目正常运行，并在提交消息中引用它们。",
    "issues options": "议题选项",
    "issues with no milestone": "没有里程碑的议题",
    "it may take up to an hour for repositories to be displayed here. you can only restore repositories that have no forks or have not been forked.": "仓库可能需要一个小时的时间才能显示在这里。您只能恢复没有复刻或没有被复刻的仓库。",
    "it’s common practice to prefix your version names with the letter": "通常的做法是在版本名称前加上字母",
    "jan": "1月",
    "january": "1月",
    "job queued to delete file.": "正在排队删除文件的作业。",
    "jobs": "作业",
    "jul": "7月",
    "july": "7月",
    "jump right in": "加入",
    "jump to": "跳转到",
    "jump to file": "跳转到文件",
    "jun": "6月",
    "june": "6月",
    "just for now": "仅当前",
    "kanban-style board with built-in triggers to automatically move issues and pull requests across to do, in progress and done columns.": "带有内置触发器的风格看板，可以自动将议题和拉取请求移到待办、进行中和已完成栏目中。",
    "keep my email addresses private": "保持我的电子邮箱地址的私密性",
    "key": "密钥",
    "key is invalid. you must supply a key in openssh public key format": "密钥无效。您必须提供 OpenSSH 公钥格式的密钥",
    "label": "标签",
    "label issues and pull requests for new contributors": "为新贡献者标记议题和拉取请求",
    "labels": "标签",
    "language": "编程语言",
    "language:": "编程语言:",
    "languages": "语言",
    "last accessed on": "最后访问日期：",
    "last active": "最后活动于",
    "last location:": "最后的位置：",
    "last updated": "最近更新",
    "latest": "最新",
    "latest changes": "最近更新",
    "latest commit": "最新提交",
    "latest release": "最新发行版",
    "learn about pull requests": "了解拉取请求",
    "learn about vigilant mode": "了解警戒模式",
    "learn how to": "了解如何",
    "learn how we count contributions": "了解我们如何计算贡献",
    "learn more": "了解更多",
    "learn more about": "了解更多关于",
    "learn more about account successors.": "了解更多关于帐户继任者的信息。",
    "learn more about clone urls": "了解有关克隆地址的更多信息",
    "learn more about default branches.": "了解有关默认分支的更多信息。",
    "learn more about protected branches.": "了解有关受保护分支的更多信息。",
    "learn more about pull requests": "了解有关拉取请求的更多信息",
    "learn more about pull requests.": "了解有关拉取请求的更多信息。",
    "learn more about the types of": "了解更多关于",
    "learn more.": "了解更多。",
    "least commented": "最少评论",
    "least recently created": "最早创建的",
    "least recently updated": "最近最少更新",
    "leave a comment": "发表评论",
    "less": "更少",
    "let’s begin the adventure": "让我们开始探险吧",
    "license": "许可证",
    "license:": "许可证:",
    "light default": "浅色（默认）",
    "light mode": "浅色模式",
    "light theme": "浅色主题",
    "line wrap mode": "换行模式",
    "linked issues": "关联议题",
    "linked pull requests": "关联拉取请求",
    "linked repositories": "关联仓库",
    "linked repositories:": "关联仓库",
    "lists": "列表",
    "loading": "加载中",
    "loading activity...": "加载动态中...",
    "loading preview…": "载入预览…",
    "loading tag information…": "载入标签信息…",
    "loading…": "加载中…",
    "location": "位置",
    "lock conversation": "锁定对话",
    "looking for activity notification controls? check the": "正在寻找活动通知控制？请检查",
    "looking to manage account security settings? you can find them in the": "想管理帐户安全设置？您可以找到它们在",
    "maintainer community": "维护者社区",
    "make private": "转为私有",
    "make public": "转为公开",
    "make secret": "转为私密",
    "make sure it's": "请确保",
    "make sure to copy your personal access token now. you won’t be able to see it again!": "确保立即复制您的个人访问令牌。您将无法再看到它！",
    "make this repository visible to anyone.": "让任何人都能看到这个仓库。",
    "making a note in your readme": "在您的 README 中做个说明",
    "manage": "管理",
    "manage access": "访问管理",
    "manage code changes": "管理代码变更",
    "manage cookies": "管理 Cookie",
    "manage notifications": "管理通知",
    "manifest files": "清单文件",
    "manufacturing": "制造业",
    "mar": "3月",
    "march": "3月",
    "mark as": "标记为",
    "mark as read": "标记为已读",
    "mark as resolved": "标记为已解决",
    "mark as unread": "标记为未读",
    "mark this repository as archived and read-only.": "将此仓库标记为已存档和只读。",
    "mark this repository as unarchived and read-write.": "将此仓库标记为未归档和可读写。",
    "marked pull request as ready for review.": "已将此拉取请求标记为准备审查。",
    "marked this pull request as draft": "标记为草案",
    "marked this pull request as ready for review": "标记为可供审查",
    "marketplace": "市场",
    "marking files as viewed can help keep track of your progress, but will not affect your submitted review": "将文件标记为已查看可以帮助您跟踪进度，但不会纠正您提交的审查",
    "may": "5月",
    "mcp registry": "MCP 注册表",
    "member": "成员",
    "members": "成员",
    "mentioned": "已提及",
    "mentioned this pull request": "提到了此拉取请求",
    "mentioning the users": "提及那些用户",
    "merge": "合并",
    "merge button": "合并按钮",
    "merge pull request": "合并拉取请求",
    "merged": "已合并",
    "merged commit": "已合并提交",
    "merging can be performed automatically.": "可以自动进行合并。",
    "merging is blocked": "合并被阻止",
    "merging…": "合并中…",
    "metadata": "元数据",
    "milestone": "里程碑",
    "milestones": "里程碑",
    "minutes ago": "分钟前",
    "mirrors": "镜像",
    "mit license": "MIT 许可证",
    "moderate severity": "中风险",
    "moderation": "审核",
    "moderation settings": "审查设置",
    "modified": "修改",
    "monday": "星期一",
    "more": "更多",
    "more options": "更多选项",
    "most commented": "最多评论",
    "most forks": "最多复刻",
    "most issues": "议题最多",
    "most reactions": "回复最多",
    "most repository settings are hidden for archived repositories. this repository must be unarchived to change them.": "对于存档的仓库，大多数仓库设置都是隐藏的。 必须解除仓库存档才能更改它们。",
    "most stars": "最多星标",
    "most used topics": "最常用的话题",
    "name": "名字",
    "narrow your search": "缩小搜索范围",
    "navigation menu": "导航菜单",
    "neutral": "中立",
    "never be notified.": "永不接收通知。",
    "new": "新建",
    "new branch": "新分支",
    "new changes since you last viewed": "自您上次查看以来的新变化",
    "new codespace": "新建代码空间",
    "new export": "新建导出",
    "new exports cannot be requested while an export is currently in progress": "当前正在导出中，无法请求新的导出",
    "new feature or request": "新功能或请求",
    "new gist": "新建代码片段",
    "new gpg key": "新建 GPG 密钥",
    "new issue": "新建议题",
    "new label": "新标签",
    "new organization": "新建组织",
    "new owner’s github username or organization name": "新所有者的 GitHub 用户名或组织名称",
    "new password": "新密码",
    "new personal access token": "新的个人访问令牌",
    "new project": "新建项目",
    "new pull request": "新建拉取请求",
    "new repository": "新建仓库",
    "new ssh key": "新建 SSH 密钥",
    "new to github?": "初次接触 GitHub？",
    "new token formats": "新的令牌格式",
    "new workflow": "新建工作流程",
    "newer": "新的",
    "newest": "最新",
    "next": "下一页",
    "night theme": "夜间主题",
    "no branch protection rules defined yet.": "尚未定义分支保护规则。",
    "no changes to display.": "没有任何变化",
    "no commit comments for this range": "在此范围内没有提交评论",
    "no definitions found in this file.": "本文件中没有发现任何定义。",
    "no expiration": "无有效期",
    "no fallback sms number": "未设置备用手机号码",
    "no labels": "无标签",
    "no new commits to fetch. enjoy your day!": "尚无新提交。祝您愉快！",
    "no new commits yet. enjoy your day!": "尚无新提交。祝您愉快！",
    "no one assigned": "未分配",
    "no open projects": "没有任何打开的项目",
    "no packages published": "未发布包",
    "no projects found. sorry about that.": "很抱歉，未找到任何项目。",
    "no projects have been opened yet.": "目前没有被打开的项目。",
    "no recovery tokens": "未设置恢复令牌",
    "no releases published": "无发行版",
    "no results": "无结果",
    "no results matched your search.": "没有与您的搜索相符的结果。",
    "no reviews": "未经审查",
    "no saved replies yet.": "暂时没有快捷回复。",
    "no security keys": "未配置安全密钥",
    "no wrap": "不换行",
    "none": "无",
    "none yet!": "啥也木有！",
    "nonprofits": "非营利组织",
    "not": "不",
    "not configured": "未配置",
    "not reviewed by you": "您未审查",
    "not visible in emails": "在电子邮件中不可见",
    "note": "笔记",
    "note that this will include your existing unsigned commits.": "请注意，这将包括您现有的未签名的提交。",
    "notes": "笔记",
    "nothing to preview": "没有什么可预览",
    "nothing to show": "没有什么可显示",
    "notification center": "通知中心",
    "notification settings": "通知设置",
    "notifications": "通知",
    "notified of all notifications on this repository.": "接收来自此仓库所有通知。",
    "nov": "11月",
    "november": "11月",
    "oct": "10月",
    "october": "10月",
    "of this file size": "文件大小",
    "of this size": "仓库大小",
    "off": "关",
    "okay, you have successfully deleted that key.": "好的，您已成功删除该密钥。",
    "old password": "旧密码",
    "older": "旧的",
    "oldest": "最早",
    "on": "开",
    "once unarchived, the following can be modified and commented on:": "一旦解除存档，就可以对以下内容进行修改和评论：",
    "once you delete a repository, there is no going back. please be certain.": "您一旦删除仓库，将再也无法恢复。请确认。",
    "once you delete your account, there is no going back. please be certain.": "您一旦删除了您的帐户，将再也无法恢复。请确认！",
    "only": "仅",
    "only administrators can delete issues": "只有管理员可以删除议题",
    "only allow primary email": "仅允许主电子邮箱",
    "only receive account related emails, and those i subscribe to.": "仅接收帐户相关的邮件，以及我订阅的邮件。",
    "only receive notifications from this repository when participating or @mentioned.": "仅在参与或 @提及时接收来自此仓库的通知。",
    "only the owner of this repository can see this message.": "仅此仓库的所有者可以看到此消息。",
    "only those with": "只有对此仓库具有",
    "only those with access to this repository can view it.": "只有拥有该仓库访问权的用户才能查看。",
    "open": "打开",
    "open a pull request": "打开一个拉取请求",
    "open a pull request that is ready for review": "打开一个拉取请求，以供审查",
    "open a pull request to contribute your changes upstream.": "打开拉取请求以向上游贡献您的更改。",
    "open a pull request to fetch upstream and review changes or resolve conflicts.": "打开拉取请求去获取上游并查看更改或解决冲突。",
    "open all": "打开全部",
    "open issues and pull requests": "打开的议题和拉取请求",
    "open pull request": "打开拉取请求",
    "open source": "开源项目",
    "open the two-factor authentication app on your device to view your authentication code and verify your identity.": "打开设备上的两因素身份验证程序以查看身份验证码并验证您的身份。",
    "open with github desktop": "用 GitHub 桌面客户端打开",
    "open with visual studio": "用 Visual Studio 打开",
    "open/closed": "打开/关闭",
    "opened": "已打开",
    "opened by the author": "由那些作者打开",
    "opened this issue": "打开了这个",
    "opened this issue on": "打开了这个",
    "opened this pull request": "打开了这个拉取请求",
    "opened this pull request (their first ever)": "打开这个拉取请求（他们的第一个）",
    "options": "选项",
    "or": " 或者",
    "or troubleshoot": "或解决",
    "organization": "组织",
    "organization permissions": "组织权限",
    "organizations": "组织",
    "outdated": "已过时",
    "overview": "概况",
    "overwhelmed by notifications? we've found some repositories that may be causing notifications you don't need.": "通知不知所措？我们发现了一些仓库，这些仓库可能会导致您不需要的通知。",
    "owner": "拥有者",
    "owns this repository": "拥有这个仓库",
    "packages": "包",
    "pages settings now has its own dedicated tab!": "Pages 设置现在有其专用选项卡！",
    "partially verified": "部分验证",
    "participant": "参与者",
    "participants": "参与者",
    "participating and @mentions": "参与和 @提及",
    "partners": "合作伙伴",
    "password": "密码",
    "password and authentication": "密码与身份验证",
    "password is in a list of passwords commonly used on other websites": "密码在其他网站常用的密码列表中",
    "password is strong": "密码很强壮",
    "password is too short": "密码太短",
    "password may be compromised": "密码可能被泄露",
    "password needs a number and lowercase letter": "密码需要有数字和小写字母",
    "pending": "待定中",
    "people": "成员",
    "people who are already subscribed will not be unsubscribed.": "已经订阅的人将不会被取消订阅。",
    "personal access tokens": "个人访问令牌",
    "personal access tokens function like ordinary oauth access tokens. they can be used instead of a password for git over https, or can be used to": "个人访问令牌的功能类似于普通的 OAuth 访问令牌。它们可以用来代替 HTTPS 上 Git 的密码，或者可以用来",
    "pick a branch or recent commit": "选择一个分支或最近的提交",
    "pin issue": "固定议题",
    "pinned": "已置顶",
    "plan and track work": "规划与跟踪工作",
    "platform": "平台",
    "please add a verified email, in addition to your primary email, in order to choose a backup email address.": "请在您的主电子邮箱之外，添加一个经验证的电子邮箱，以便选择一个备用电子邮箱。",
    "please reload this page": "请重新加载此页面",
    "please type": "请键入",
    "popular": "流行",
    "popular repositories": "热门仓库",
    "pre-release": "预发行版",
    "preferred default emoji skin tone": "默认的表情符号肤色",
    "preferred spoken language": "首选语言",
    "premium support": "高级支持",
    "preserve this repository": "保留这个仓库",
    "prev": "上一页",
    "preview": "预览",
    "preview changes": "预览更改",
    "previous": "上一页",
    "pricing": "价格",
    "primary": "主帐户",
    "primary email address": "主电子邮箱",
    "privacy": "隐私",
    "private": "私有",
    "private archive": "私有存档",
    "private repositories only": "仅私有仓库",
    "private repository": "私有仓库",
    "product": "产品",
    "profile": "个人资料",
    "profile picture": "个人头像",
    "profile settings": "个人资料设置",
    "profile settings.": "个人资料设置。",
    "programs": "计划",
    "project board name": "项目板名称",
    "project boards on github help you organize and prioritize your work. you can create project boards for specific feature work, comprehensive roadmaps, or even release checklists.": "GitHub 上的项目板可以帮助您组织和安排工作的优先次序。 您可以为特定功能工作、全面的路线图、甚至发布检查列表来创建项目板。",
    "project template": "项目模板",
    "projects": "项目",
    "propose change": "提出更改",
    "propose changes": "提出更改",
    "protanopia": "红色盲",
    "providing a fallback sms number will allow github to send your two-factor authentication codes to an alternate device if you lose your primary device.": "如果您丢失主要设备，提供备用手机号码将允许 GitHub 将您的双因素身份验证码发送到备用设备。",
    "public": "公开",
    "public archive": "公共存档",
    "public email": "公开邮箱",
    "public gists are visible to everyone.": "公开片段对所有人可见。",
    "public profile": "公开个人资料",
    "public repositories only": "仅公共仓库",
    "public repository": "公共仓库",
    "public wikis will still be readable by everyone.": "公共 wikis 仍然可供所有人阅读。",
    "publish release": "发布发行版",
    "publish your first package": "发布您的第一个包",
    "pull request": "拉取请求",
    "pull request authors can’t approve their own pull request": "拉取请求作者无法批准自己的拉取请求",
    "pull request authors can’t request changes on their own pull request": "拉取请求作者不能在自己的拉取请求上请求更改",
    "pull request closed": "拉取请求已关闭",
    "pull request successfully merged and closed": "拉取请求已成功合并并关闭",
    "pull requests": "拉取请求",
    "pushed": "已推送",
    "pushed to": "推送于何时",
    "queued": "排队",
    "quote reply": "引用回复",
    "raw": "源码",
    "re-request review": "重新请求审查",
    "re-run all jobs": "重新运行所有作业",
    "re-run jobs": "重新运行作业",
    "read all user profile data": "读取所有用户个人资料数据",
    "read and write enterprise billing data": "读写企业计费数据",
    "read and write org and team membership, read and write org projects": "读写组织和团队成员，读写组织项目",
    "read and write security events": "读写安全事件",
    "read and write team discussions": "读写团队讨论",
    "read enterprise profile data": "读取企业个人数据",
    "read more": "阅读更多",
    "read more about oauth scopes.": "了解更多关于 OAuth 作用域的信息。",
    "read org and team membership, read org projects": "读取组织和团队成员，读取组织项目",
    "read public user gpg keys": "读取公共用户 GPG 密钥",
    "read repository hooks": "读取仓库挂钩",
    "read team discussions": "读取团队讨论",
    "read user public keys": "读取用户公钥",
    "read-write.": "可读写。",
    "readme": "自述文件",
    "ready for review": "准备审查",
    "really change your username?": "确定要更改您的用户名？",
    "rebase and merge": "变基与合并",
    "receive all emails, except those i unsubscribe from.": "接收所有的邮件，除了那些我取消订阅的邮件。",
    "receives notifications": "接收通知",
    "recent activity": "最近动态",
    "recent commits": "最近的提交",
    "recent exports": "近期导出",
    "recently created": "最近创建的",
    "recently edited these files": "最近编辑了这些文件",
    "recently updated": "近期更新内容",
    "recommended for you": "为您推荐",
    "recovering your account": "恢复您的帐户",
    "recovery code": "恢复码",
    "recovery code authentication failed.": "恢复码身份验证失败。",
    "recovery codes": "恢复码",
    "recovery codes can be used to access your account in the event you lose access to your device and cannot receive two-factor authentication codes.": "恢复码可用于在您无法访问设备且无法接收双因素身份验证码的情况下访问您的帐户。",
    "recovery options": "恢复选项",
    "recovery tokens": "恢复令牌",
    "reference an issue or pull request": "引用议题或拉取请求",
    "reference an issue, pull request or discussion": "引用议题，拉取请求或讨论",
    "reference in new issue": "引用到新议题",
    "refresh": "刷新",
    "regenerate": "重新生成",
    "regenerate personal access token": "重新生成个人访问令牌",
    "regenerate the token": "重新生成令牌",
    "regenerate token": "重新生成令牌",
    "release": "发行版",
    "release title": "发行版标题",
    "released": "发布",
    "releases": "发行版",
    "reload": "重新加载",
    "remember, contributions to this repository should follow its": "请记住，对该仓库的贡献应遵循",
    "remember, contributions to this repository should follow our": "请记住，对该仓库的贡献应遵循我们的",
    "remind me later": "稍后提醒我",
    "remove": "移除",
    "removed": "移除",
    "rename": "重命名",
    "rename branch": "重命名分支",
    "renaming may take a few minutes to complete.": "重命名可能需要几分钟的时间来完成。",
    "reopen issue": "重新打开议题",
    "reopen pull request": "重新打开拉取请求",
    "reopened this": "重新打开了这个",
    "report": "报告",
    "report abuse": "举报滥用",
    "report content": "举报内容",
    "repositories": "仓库",
    "repositories options": "仓库选项",
    "repository": "仓库",
    "repository default branch": "仓库默认分支",
    "repository name": "仓库名称",
    "repository size in kb": "仓库的大小，单位是KB",
    "repository visibility": "仓库可见性",
    "repository, wiki, issues, comments, packages, secrets, workflow runs, and remove all collaborator associations.": "仓库、Wiki、议题、评论、包、机密、工作流程，并删除所有协作者关联。",
    "request changes": "请求更改",
    "resend email with link": "重新发送带有链接的邮件",
    "resend verification email": "重新发送验证邮件",
    "reset": "重置",
    "resolve conflicts": "解决冲突",
    "resolve conversation": "解决对话",
    "resolved": "已解决",
    "resources": "资源",
    "restore branch": "恢复分支",
    "restrict editing to collaborators only": "仅限协作者进行编辑",
    "return code": "返回代码",
    "return repositories": "返回仓库",
    "reverse alphabetically": "按字母顺序倒序",
    "revert": "还原",
    "review": "审查",
    "review changes": "审查更改",
    "review has been requested on this pull request. it is not required to merge.": "已请求对此拉取请求进行审查。不需要合并。",
    "review requested": "已请求审查",
    "review required": "需要审查",
    "reviewed": "已审查",
    "reviewed by you": "由您审查",
    "reviewers": "审查人",
    "reviews": "审查",
    "revised": "修订",
    "revisions": "修订",
    "revoke all": "全部撤销",
    "revoke session": "撤销会话",
    "run workflow": "运行工作流程",
    "safely publish packages, store your packages alongside your code, and share your packages privately with your team.": "安全地发布包，将包与代码一起存储，并与您的团队共享私有包。",
    "saturday": "星期六",
    "save": "保存",
    "save changes": "保存更改",
    "save draft": "保存草案",
    "save email preferences": "保存邮件首选项",
    "save yourself time with a pre-configured project board template.": "使用预先配置的项目板模板可为您节省时间。",
    "saved": "已保存",
    "saved replies": "已保存的回复",
    "saved replies are re-usable text snippets that you can use throughout github comment fields. saved replies can save you time if you’re often typing similar responses.": "快捷回复是可重复使用的文本片段，您可以在整个 GitHub 评论区使用。如果您经常输入类似的回复，快捷回复可以节省您的时间。",
    "saved reply title": "快捷回复的标题",
    "saved!": "已保存",
    "saving…": "保存中…",
    "scheduled reminders": "定时提醒",
    "scopes define the access for personal tokens.": "作用域定义了个人令牌的访问范围。",
    "search": "搜索",
    "search all labels": "搜索所有标签",
    "search by repository name": "搜索仓库名",
    "search by username, full name, or email address": "搜索用户名、全名、或电子邮箱",
    "search code": "搜索代码",
    "search github": "搜索 GitHub",
    "search issues": "搜索议题",
    "search logs": "搜索日志",
    "search or jump to...": "搜索或跳转到…",
    "search or jump to…": "搜索或跳转到…",
    "search pull requests": "搜索拉取请求",
    "search…": "搜索代码片段…",
    "secret": "私密",
    "secret gists are hidden by search engines but visible to anyone you give the url to.": "私密片段对搜索引擎不可见，对直接访问您分享的 url 可见。",
    "secret protection": "机密保护",
    "secrets": "密钥",
    "secure your code as you build": "在开发过程中保护代码安全",
    "security": "安全",
    "security & analysis": "安全 & 分析",
    "security advisories": "安全公告",
    "security alerts": "安全警报",
    "security and quality": "安全与质量",
    "security features will be unavailable:": "安全功能将无法使用：",
    "security features will become available:": "安全功能将不可用：",
    "security keys": "安全密钥",
    "security keys are hardware devices that can be used as your second factor of authentication.": "安全密钥是硬件设备，可以作为您的第二认证因素。",
    "security lab": "安全实验室",
    "security log": "安全日志",
    "security overview": "安全概述",
    "security policy": "安全政策",
    "see all": "查看全部",
    "see all starred topics": "查看全部标星话题",
    "see dependabot alerts": "查看 Dependabot 警报",
    "see more": "查看更多",
    "see review": "查看审查",
    "select a reply": "选择一个回复",
    "select a theme to publish your site with a jekyll theme using the": "选择一个主题，用 jekyll 主题发布您的站点，使用",
    "select a theme to publish your site with a jekyll theme.": "选择一个主题，用 Jekyll 主题发布您的站点。",
    "select all": "全选",
    "select branch": "选择分支",
    "select commit": "选择提交",
    "select events you want to be notified of in addition to participating and @mentions.": "选择除参与和 @提及之外还要接收通知的事件。",
    "select folder": "选择文件夹",
    "select language": "选择语言",
    "select order": "选择排序",
    "select scopes": "选择作用域",
    "select theme": "选择主题",
    "select type": "选择类型",
    "select workflow": "选择工作流程",
    "self-assigned this": "自行分配了此",
    "self-requested a review": "自己要求的审查",
    "send feedback": "发送反馈",
    "send one-time password": "发送一次性密码",
    "sep": "9月",
    "september": "9月",
    "session details": "会话详情",
    "sessions": "会话",
    "set status": "状态设置",
    "set up a security policy": "制定安全政策",
    "set up code scanning": "设置代码扫描",
    "set up discussions": "建立讨论",
    "set up redirects for pages sites.": "为 Pages 站点设置重定向。",
    "set up redirects for your old profile page.": "为您的旧资料页设置重定向",
    "set up sponsor button": "设置赞助按钮",
    "set up templates": "设置模板",
    "set your email in git": "在 Git 中设置您的电子邮箱",
    "settings": "设置",
    "share": "分享",
    "shop": "商店",
    "show": "显示",
    "show all changes": "显示所有更改",
    "show all checks": "显示所有检查",
    "show all reviewers": "显示所有审查人",
    "show changes since your last review": "显示自您上次评论以来的更改",
    "show comments": "显示评论",
    "show full screen (shift+f)": "全屏显示（Shift+F）",
    "show less": "收起",
    "show more": "展示更多",
    "show more activity": "加载更多动态",
    "show resolved": "显示已解决",
    "show thumbnails": "显示缩略图",
    "show timestamps": "显示时间戳",
    "show:": "显示:",
    "showing runs from all workflows": "显示所有工作流程的运行情况",
    "sign in": "登录",
    "sign in to": "登录",
    "sign in to github": "登录 GitHub",
    "sign in →": "登录 →",
    "sign out": "退出登录",
    "sign up": "注册",
    "sign up for github": "注册 GitHub",
    "signed in as": "登录身份为",
    "signed in:": "登录：",
    "signing in…": "登录中…",
    "single theme": "单一主题",
    "skip this step if you’re importing an existing repository.": "如果您要导入现有仓库，请跳过此步骤。",
    "skip this with recovery codes": "使用恢复码跳过此步骤",
    "skip to content": "跳到内容",
    "skipped": "跳过",
    "small and medium teams": "中小型团队",
    "sms number": "手机号码",
    "social preview": "社交预览",
    "soft wrap": "软换行",
    "software development": "软件开发",
    "solutions": "解决方案",
    "some checks haven’t completed yet": "有些检查还没有完成",
    "some checks were not successful": "有些检查不成功",
    "something isn't working": "某些不能正常工作的问题",
    "something went really wrong, and we can’t process that file.": "确实出了点问题，我们无法处理该文件。",
    "sort": "排序方式",
    "sort by": "排序方式",
    "sort options": "排序选项",
    "sort:": "排序:",
    "source": "来源",
    "sources": "源码",
    "spaces": "空格",
    "split": "分屏",
    "spoken language:": "自然语言",
    "sponsor": "赞助",
    "sponsor this project": "赞助该项目",
    "sponsors": "赞助",
    "sponsorship log": "赞助日志",
    "sponsorships": "赞助",
    "sponsorships help your community know how to financially support this repository.": "赞助可帮助您的社区了解如何在资金上支持此仓库。",
    "squash and merge": "压缩与合并",
    "ssh and gpg keys": "SSH 与 GPG 密钥",
    "ssh keys": "SSH 密钥",
    "stale": "陈旧",
    "star": "星标",
    "stargazers": "追星者",
    "starred": "已加星标",
    "starred gists": "我标星的代码片段",
    "starred repositories": "标星的仓库",
    "starred topics": "标星的话题",
    "stars": "星标",
    "start a codespace from a template and get to developing with the power of a virtual machine in the cloud.": "从模板启动代码空间，并利用云虚拟机的强大功能进行开发。",
    "start a review": "开始审查",
    "start commit": "开始提交",
    "start export": "开始导出",
    "start from scratch with a completely blank project board. you can add columns and configure automation settings yourself.": "从一个完全空白的项目板开始。你可以自己添加栏目并配置自动化设置。",
    "start setup": "开始设置",
    "started a review": "开始评论",
    "startups": "初创公司",
    "status": "状态",
    "step 1": "第一步",
    "step 2": "第二步",
    "step 3": "第三步",
    "still having problems?": "还是有问题？",
    "still in progress?": "仍在进行中吗？",
    "stop ignoring": "取消忽略",
    "stop leaks before they start": "在泄漏发生前阻止它",
    "styling with markdown is supported": "支持使用 Markdown 样式",
    "submit": "提交",
    "submit feedback approving these changes.": "批准，并提出反馈意见。",
    "submit feedback suggesting changes.": "请求更改，并提出更改意见。",
    "submit general feedback without explicit approval.": "未批准，并提出一般性反馈意见。",
    "submit new issue": "提交新议题",
    "submit review": "提交审查",
    "submitting this form will generate a new token. be aware that any scripts or applications using this token will need to be updated.": "提交此表单将产生一个新的令牌。请注意，任何使用该令牌的脚本或应用程序将需要更新。",
    "subscribe": "订阅",
    "subscriptions": "订阅",
    "success": "成功",
    "successfully merging a pull request may close this issue.": "成功合并一个拉取请求可能会关闭此议题。",
    "successfully updated your email preferences.": "成功更新了您的邮件首选项。",
    "successor settings": "设置继任者",
    "sudo mode": "sudo 模式",
    "suggest a security policy": "安全政策建议",
    "suggest how users should report security vulnerabilities for this repository": "建议用户应如何报告此仓库的安全漏洞",
    "suggested change": "更改建议",
    "suggested:": "建议：",
    "summary": "摘要",
    "sunday": "星期天",
    "support & services": "支持与服务",
    "supported vcs.": "支持的版本系统",
    "switch branches/tags": "切换分支/标签",
    "switch to another branch": "切换到另一分支",
    "sync with system": "与系统同步",
    "synchronize": "同步",
    "tab.": "选项页。",
    "table of contents": "目录",
    "tabs": "tab",
    "tag version": "标签版本",
    "tagging suggestions": "标签建议",
    "tags": "标签",
    "target:": "目标:",
    "team": "团队",
    "template repositories let users generate new repositories with the same directory structure and files.": "模板仓库允许用户生成具有相同目录结构和文件的新仓库。",
    "template repository": "模板库",
    "template:": "模板:",
    "template?": "模板吗？",
    "templates": "模板",
    "terms": "服务条款",
    "terms of service": "服务条款",
    "the base branch restricts merging to authorized users.": "基础分支合并仅限于授权用户。",
    "the default branch is considered the “base” branch in your repository, against which all pull requests and code commits are automatically made, unless you specify a different branch.": "默认分支被认为是仓库中的 “基础” 分支，所有的拉取请求和代码提交都是针对该分支进行的，除非您指定一个不同的分支。",
    "the file containing your recovery codes may exist on your computer - check for a file named": "包含恢复码的文件可能存在于您的计算机上——请检查一个名为",
    "the issue was successfully deleted.": "该议题已成功删除。",
    "the logs for this run have expired and are no longer available.": "此运行日志已过期，不再可用。",
    "the most recent revision cannot be deleted. need to delete sensitive information? go to the specific edit where the information was added.": "最近的修订版不能被删除。需要删除敏感信息？请到信息的具体编辑处修改。",
    "the token will never expire!": "此令牌永不过期！",
    "theme chooser": "设置主题",
    "theme mode": "主题模式",
    "theme preferences": "主题偏好",
    "there are no changes to show.": "没有可显示的更改。",
    "there are no gpg keys associated with your account.": "没有与您的帐户关联的 GPG 密钥。",
    "there are no ssh keys associated with your account.": "没有与您的帐户关联的 SSH 密钥。",
    "there aren’t any open pull requests.": "没有任何打开的拉取请求。",
    "there isn’t anything to compare.": "没有什么可比较的。",
    "these branches can be automatically merged.": "这些分支可以自动合并。",
    "these repositories may be causing unnecessary notifications.": "这些仓库可能导致不必要的通知。",
    "this action": "该操作",
    "this branch cannot be rebased due to conflicts": "由于冲突，该分支不能变基",
    "this branch has conflicts that must be resolved": "该分支存在冲突，必须解决",
    "this branch has no conflicts with the base branch": "该分支与基础分支没有冲突",
    "this can take 3-5 business days": "这可能需要 3-5 个工作日",
    "this cannot be undone": "这不能被撤消",
    "this code change can be committed by users with write permissions.": "此处代码修改可以由具有写入权限的用户提交。",
    "this commit does not belong to any branch on this repository, and may belong to a fork outside of the repository.": "这个提交不属于本仓库的任何分支，可能属于仓库以外的分支。",
    "this commit was signed with the committer’s": "此提交已签署使用提交者的",
    "this doesn't seem right": "这似乎不对",
    "this edit’s content will no longer be visible": "此修改的内容将不再可见",
    "this email address is the default used for github notifications, i.e., replies to issues, pull requests, etc.": "该电子邮箱默认用于 GitHub 的通知，即对议题和拉取请求的回复，等等。",
    "this email will be used for account-related notifications and can also be used for password resets.": "该电子邮箱将用于与帐户有关的通知，也可用于密码重置。",
    "this file is empty.": "该文件是空的。",
    "this file is hidden.": "该文件是隐藏的。",
    "this gist": "该片段于",
    "this is a draft and won’t be seen by the public unless it’s published.": "这是一个草案，除非发布，否则不会被公众看到。",
    "this is a list of devices that have logged into your account. revoke any sessions that you do not recognize.": "这是已登录您帐户的设备列表。 撤销任何您不认识的会话。",
    "this is a list of gpg keys associated with your account. remove any keys that you do not recognize.": "这是与您的帐户相关的 GPG 密钥的列表。删除任何您无法识别的密钥。",
    "this is a list of ssh keys associated with your account. remove any keys that you do not recognize.": "这是与您的帐户相关的 SSH 密钥的列表。删除任何您无法识别的密钥。",
    "this is a pre-release": "这是一个预发行版",
    "this is extremely important.": "这是极其重要的。",
    "this is where you can write a long description for your project.": "您可以在此处为您的项目编写详细描述。",
    "this issue or pull request already exists": "此议题或拉取请求已存在",
    "this month": "本月",
    "this pull request is closed, but the": "此拉取请求已关闭，但是",
    "this pull request is still a work in progress": "此拉取请求仍在进行中",
    "this recommendation was created by github staff": "此推荐由 GitHub 员工创建",
    "this repository": "该仓库",
    "this repository has been archived by the owner. it is now read-only.": "此仓库已由所有者存档。它现在是只读的。",
    "this repository is currently private.": "该仓库当前是私有的。",
    "this repository is currently public.": "该仓库当前是公开的。",
    "this repository is public and visible to anyone.": "该仓库是公开的，对任何人都可见。",
    "this repository will become read-only.": "该仓库将设置为只读。",
    "this scheduled workflow is disabled because there hasn't been activity in this repository for at least 60 days.": "此计划工作流程已禁用，因为此仓库至少 60 天没有活动。",
    "this tag already has release notes. would you like to": "这个标签已经有发布说明。 您是否愿意",
    "this theme will be active when your system is set to “dark mode”": "当您的系统设置为“暗夜模式”时，该主题将被激活。",
    "this theme will be active when your system is set to “light mode”": "当您的系统设置为“灯光模式”时，该主题将被激活。",
    "this token has no expiration date": "此令牌未设置有效期",
    "this token has no expiration date. to set a new expiration date, you must": "此令牌未设置有效期。要设置新的有效期，您必须",
    "this token to take advantage of the": "此令牌使用",
    "this week": "本周",
    "this will delete the information for this draft.": "这将会删除该草案的信息。",
    "this will delete the information for this release.": "这将会删除该发行版的信息。",
    "this will include any commit attributed to your account but not signed with your gpg or s/mime key.": "这将包括任何归属于您的帐户但没有用您的 GPG 或 S/MIME 密钥签名的提交。",
    "this will make": "这将使",
    "this will not be worked on": "这将不会被处理",
    "this will not change your billing plan. if you want to downgrade, you can do so in your billing settings.": "这并不会更改您的结算方案。 如果您想降级，可以在结算设置中进行降级。",
    "this will set": "这将设置",
    "this workflow has a": "这个工作流程有一个",
    "this workflow was disabled manually.": "工作流程已被手动禁用。",
    "thursday": "星期四",
    "timed out": "已超时",
    "tip:": "提示:",
    "title": "标题",
    "to a": "为",
    "to confirm.": "进行确定。",
    "to continue to": "继续登录",
    "to link repositories to this project for more accurate suggestions and better search results.": "将仓库关联到此项目，以获得更准确的建议和更好的搜索结果。",
    "to merge this pull request.": "合并此拉取请求。",
    "to this repository can merge pull requests.": "的才可合并拉取请求。",
    "to understand admin access, teams, issue assignments, and redirects after a repository is transferred, see": "要了解仓库转让后的管理员访问、团队、议题分配和重定向，请参阅",
    "to verify, type": "为了验证，请输入",
    "today": "今天",
    "tokens you have generated that can be used to access the": "生成令牌用于访问",
    "top languages": "主要编程语言",
    "topics": "话题",
    "total duration": "总时长",
    "training": "培训",
    "transfer": "转让",
    "transfer issue": "转移议题",
    "transfer ownership": "转让所有权",
    "transfer repository": "转让仓库",
    "transfer this repository to another user or to an organization where you have the ability to create repositories.": "将此仓库转让给另一位用户或您可以创建仓库的组织。",
    "transferring a repository": "转让仓库",
    "transferring may be delayed until the new owner approves the transfer.": "在新所有者批准接受转让之前，转让可能会延迟。",
    "trending": "趋势",
    "trending repository": "热门仓库",
    "trending settings": "趋势设置",
    "triage and prioritize bugs with columns for to do, high priority, low priority, and closed.": "使用待办事项、高优先级、低优先级和已关闭的栏目对错误进行分类和优先级排序。",
    "triggered via issues": "通过议题触发",
    "tritanopia": "蓝色盲",
    "trust center": "信任中心",
    "try a different file.": "请尝试不同的文件。",
    "try again": "请重试，",
    "try again.": "请重试。",
    "try another file.": "请尝试另一个文件。",
    "try broadening your search filters.": "尝试扩大您的搜索过滤器。",
    "tuesday": "星期二",
    "twitter username": "Twitter 用户名",
    "two-factor authentication": "双因素身份验证",
    "two-factor authentication adds an additional layer of security to your account by requiring more than just a password to sign in.": "双因素身份验证不仅仅要求密码登录，还为您的帐户增加了一层额外的安全性。",
    "two-factor authentication failed.": "双因素身份验证失败。",
    "two-factor methods": "双因素验证方式",
    "two-factor recovery": "双因素验证恢复",
    "type": "类型",
    "type \"y\" for yes or \"n\" for no": "输入 \"y\" 表示愿意，输入 \"n\" 表示不愿意。",
    "type:": "类型:",
    "unable to load this preview, sorry.": "抱歉，无法加载此预览。",
    "unarchive repository": "解除仓库存档",
    "unarchive this repository": "解除仓库存档",
    "unexpected bad things will happen if you don’t read this!": "如果您不阅读此说明，将会发生意想不到的事情！",
    "unfollow": "取消关注",
    "unfork": "取消复刻",
    "unified": "同屏",
    "unintended side effects": "意外的副作用",
    "unlabeled": "未标记",
    "unread": "未读",
    "unresolve conversation": "未解决对话",
    "unstar": "取消星标",
    "unsubscribe": "退订",
    "unverified": "未验证",
    "unwatch": "取消关注",
    "unwatch all": "全部取消关注",
    "unwatch suggestions": "取消关注建议",
    "update": "更新",
    "update all user data": " 更新所有用户数据",
    "update comment": "更新评论",
    "update github action workflows": "更新 GitHub 操作工作流程",
    "update password": "更新密码",
    "update profile": "更新个人资料",
    "update public gist": "更新公开片段",
    "update release": "更新发行版",
    "update saved reply": "更新快捷回复",
    "update secret gist": "更新私密片段",
    "update token": "更新令牌",
    "update watching settings": "更新关注设置",
    "updated": "已更新",
    "updated before the date": "更新于何时",
    "updating": "更新中",
    "updating any repository settings": "更新仓库设置",
    "upgrade": "升级",
    "upload": "上传",
    "upload an image to customize your repository’s social media preview.": "上传图像以自定义仓库的社交媒体预览。",
    "upload files": "上传文件",
    "upload packages to github package registry": "将包上传到 GitHub 包注册",
    "uploading your files…": "正在上传您的文件...",
    "uploading your release now…": "正在上传您的发行版...",
    "use a password-protected ssh key.": "使用受密码保护的 SSH 密钥。",
    "use git or checkout with svn using the web url.": "使用 Git 或 SVN 通过该网址检出。",
    "use https": "使用 HTTPS",
    "use ssh": "使用 SSH",
    "use this template": "使用此模板",
    "use workflow from": "使用工作流程来自：",
    "used by": "使用者",
    "username may only contain alphanumeric characters or single hyphens, and cannot begin or end with a hyphen.": "用户名只能包含字母数字字符或单个连字符，并且不能以连字符开头或结尾。",
    "username or email address": "用户名或电子邮箱",
    "username or organization name": "用户名或组织名称",
    "users": "用户",
    "users options": "用户选项",
    "verified": "已验证",
    "verified signature": "已验证签名",
    "verify": "验证",
    "verify a device, ssh key or personal access token.": "验证一个设备、SSH 密钥或个人访问令牌。",
    "verify an email associated with this account.": "验证与该帐户相关的电子邮箱。",
    "verify your account": "验证您的帐户",
    "verifying": "验证中",
    "verifying…": "验证中…",
    "view": "查看",
    "view advanced search syntax": "查看高级搜索语法",
    "view all": "查看全部",
    "view all branches": "查看所有分支",
    "view all features": "查看全部功能",
    "view all industries": "查看全部行业",
    "view all repositories": "查看所有仓库",
    "view all resources": "查看全部资源",
    "view all sessions": "查看所有会话",
    "view all solutions": "查看全部解决方案",
    "view all tags": "查看所有标签",
    "view all topics": "查看全部主题",
    "view all use cases": "查看全部使用场景",
    "view changes": "查看更改",
    "view commit details": "查看提交详情",
    "view dependabot alerts": "查看 Dependabot 警报",
    "view deployment": "查看部署",
    "view details": "查看细节",
    "view file": "查看文件",
    "view fork": "浏览复刻",
    "view full activity log": "查看完整的活动记录",
    "view git blame": "浏览 Git Blame",
    "view github profile": "查看 GitHub 个人资料",
    "view license": "查看 License",
    "view or disclose security advisories for this repository": "查看或公开此仓库的安全公告",
    "view pull request": "查看拉取请求",
    "view raw logs": "查看原始日志",
    "view runs": "查看工作流程",
    "view security advisories": "查看安全公告",
    "view security advisories for this repository": "查看此仓库的安全公告",
    "view workflow file": "查看工作流程文件",
    "view workflow runs": "查看工作流程运行",
    "view your gists": "查看您的所有片段",
    "viewed": "已查看",
    "vigilant mode": "警戒模式",
    "visibility": "可见性",
    "vulnerability details": "漏洞详情",
    "waiting": "等待中",
    "waits for merge requirements to be met and then merges automatically.": "等待满足合并要求，然后自动合并。",
    "want to use a": "想使用",
    "warning: this is a potentially destructive action.": "警告：这是一个潜在的破坏性操作。",
    "was closed": "已关闭",
    "was merged": "已合并",
    "watch": "关注",
    "watched repositories": "关注的仓库",
    "watching": "关注",
    "we": "我们",
    "we can’t create a tag with this name. take a look at the suggestions in the sidebar for example tag names.": "我们不能用这个名字创建标签。看看侧边栏的建议，看看标签名称的例子。",
    "we couldn’t find anything!": "这里空空如也！",
    "we don’t support that file type.": "我们不支持该文件类型。",
    "we don’t support that file type. try zipping it.": "我们不支持该文件类型，请尝试压缩它。",
    "we found potential security vulnerabilities in your dependencies.": "我们在您的依赖项中发现了潜在的安全漏洞。",
    "we got an error doing that.": "我们在这样做时出错了。",
    "we will": "我们将",
    "we're preparing your export! we'll send you an email when it's finished.": "我们正在为您准备导出！我们完成后会发一封电子邮件。",
    "website": "网站",
    "wednesday": "星期三",
    "welcome to github!": "欢迎来到 GitHub!",
    "welcome to issues!": "欢迎关注议题！",
    "we’ll occasionally contact you with the latest news and happenings from the github universe.": "我们会不定期地联系您，告诉您来自 GitHub 宇宙的最新消息和发生的事情。",
    "we’ll only send you legal or administrative emails, and any emails you’re specifically subscribed to.": "我们仅向您发送法律或行政邮件，以及您特别订阅的任何邮件。",
    "we’ll point out that this release is identified as non-production ready.": "我们需要指出的是，这个版本被认定为非生产准备。",
    "we’ll remove your public profile email and use": "我们将删除您的公开个人资料中的电子邮箱，并使用",
    "what would you like to do?": "您想做什么？",
    "what’s this token for?": "这个令牌有什么用？",
    "what’s this?": "这是什么？",
    "when creating source code archives, you can choose to include files stored using git lfs in the archive.": "创建源代码存档时，您可以选择在存档中包含使用 Git LFS 存储的文件。",
    "when https is enforced, your site will only be served over https.": "当 HTTPS 被强制执行时，您的站点将只通过 HTTPS 提供服务。",
    "when merging pull requests, you can allow any combination of merge commits, squashing, or rebasing. at least one option must be enabled. if you have linear history requirement enabled on any protected branch, you must enable squashing or rebasing.": "合并拉取请求时，您可以允许合并提交、压缩或变基的任意组合。必须至少启用一个选项。如果您在任何受保护分支上启用了线性历史要求，则必须启用压缩或变基。",
    "when performing web-based git operations (e.g. edits and merges) and sending email on your behalf. if you want command line git operations to use your private email you must": "执行基于 Web 的 Git 操作（例如编辑和合并）并以您的名义发送电子邮件。如果您想在命令行 Git 操作中使用您的私人电子邮箱，您必须",
    "when you push to github, we’ll check the most recent commit. if the author email on that commit is a private email on your github account, we will block the push and warn you about exposing your private email.": "当您推送到 GitHub 时，我们会检查最近的提交。如果该提交的作者电子邮箱是您 GitHub 帐户上的私人电子邮箱，我们会阻止推送并警告您不要暴露您的私人电子邮箱。",
    "who has access": "谁有权访问",
    "why github": "为什么选择 GitHub",
    "why github?": "为何选择 GitHub？",
    "wiki": "Wiki",
    "wiki options": "Wiki 选项",
    "will": "会",
    "will be deleted": "将被删除",
    "will be used for account-related notifications as well as password resets.": "将用于与帐户相关的通知以及密码重置。",
    "will be used for web-based git operations, e.g., edits and merges.": "将用于基于 Web 的 Git 操作，例如编辑和合并。",
    "will not": "不会",
    "with a file smaller than 2gb.": "使用一个小于 2GB 的文件。",
    "with a file that’s not empty.": "使用一个非空的文件。",
    "with a gif, jpeg, jpg, mov, mp4 or png.": "使用后缀名为 GIF, JPEG, JPG, MOV, MP4 或 PNG的文件。",
    "with a gif, jpeg, jpg, mov, mp4, png, csv, docx, fodg, fodp, fods, fodt, gz, log, md, odf, odg, odp, ods, odt, pdf, pptx, txt, xls, xlsx or zip.": "使用后缀名为 GIF, JPEG, JPG, MOV, MP4, PNG, CSV, DOCX, FODG, FODP, FODS, FODT, GZ, LOG, MD, ODF, ODG, ODP, ODS, ODT, PDF, PPTX, TXT, XLS, XLSX 或 ZIP的文件。",
    "with another file.": "使用另一个文件。",
    "with the labels": "带有那些标签",
    "with this extension": "文件后缀名",
    "with this file name": "文件名称",
    "with this full name": "全名",
    "with this license": "用何种许可证",
    "with this many comments": "有多少评论",
    "with this many followers": "有多少粉丝",
    "with this many forks": "有多少复刻",
    "with this many public repositories": "有多少公共仓库",
    "with this many stars": "有多少星标",
    "within 3-5 business days": "在 3-5 个工作日内",
    "work fast with our official cli.": "使用我们的官方 CLI 快速工作。",
    "workflow enabled successfully.": "工作流程已成功启用。",
    "workflow file": "工作流程文件",
    "workflow run was successfully requested.": "工作流程已成功请求运行。",
    "workflows": "工作流程",
    "working in this language": "工作于何种语言",
    "working with a team?": "与团队合作？",
    "would you like to receive product updates and announcements via email?": "您是否愿意通过电子邮件接收产品更新和公告？",
    "write": "撰写",
    "write access": "写入访问权限",
    "write better code with ai": "用 AI 写出更好的代码",
    "write public user gpg keys": "写入公共用户 GPG 密钥",
    "write repository hooks": "写入仓库挂钩",
    "write user public keys": "写入用户公钥",
    "written in this language": "用何种语言编写",
    "wrkflow disabled successfully.": "工作流程已成功禁用。",
    "yep, commit updates to the": "是的，提交更新到",
    "yes， update my notification email": "是的，更新我的通知电子邮箱",
    "you are entering": "您正在进入",
    "you can allow setting pull requests to merge automatically once all required reviews and status checks have passed.": "一旦所有必需的审查和状态检查都通过，您可以允许设置拉取请求自动合并。",
    "you can change how you receive notifications from your account settings.": "您可以更改通过帐户设置接收通知的方式。",
    "you can enter one of your recovery codes in case you lost access to your mobile device.": "如果您无法访问移动设备，则可以输入恢复码。",
    "you cannot change the visibility of a fork. please": "您无法更改复刻仓库的可见性。请",
    "you choose who can see and commit to this repository.": "您可以选择谁可以看和提交到该仓库。",
    "you choose who can see and make changes to this project.": "您可以选择谁可以查看此项目并对其进行更改。",
    "you could try an": "您可以尝试",
    "you don't have any public ssh keys in your github account. you can": "您的 GitHub 帐户中没有任何公共 SSH 密钥。您可以",
    "you don't have any starred gists yet.": "您还没有标星任何片段。",
    "you have no unread notifications": "您没有未读通知",
    "you have not designated a successor.": "您还没有指定继任者。",
    "you have unread notifications": "您有未读通知",
    "you haven't invited any collaborators yet": "您尚未邀请任何协作者",
    "you haven‘t reviewed this pull requeste": "您尚未审查过此请求请求",
    "you must change the existing code in this line in order to create a valid suggestion.": "您必须修改此行的现有代码，以便创建有效的建议。",
    "you will no longer be billed, and your username will be available to anyone on github.": "您将不再被收取费用，并且您的用户名将被 GitHub 上的任何人使用。",
    "you will still be able to fork the repository and unarchive it at any time.": "您仍然可以随时访问复刻仓库并取消存档。",
    "you've reached the limit of 25 linked repositories.": "你已经达到了 25 个关联仓库的上限。",
    "your": "您的",
    "your backup github email address will be used as an additional destination for security-relevant account notifications and can also be used for password resets.": "您的备用 GitHub 电子邮箱将额外的用作安全相关帐户通知，也可以用于密码重置。",
    "your codespaces": "我的代码空间",
    "your current session": "您当前的会话",
    "your discussions": "我的讨论",
    "your email was verified.": "您的电子邮箱已被验证。",
    "your enterprises": "你的企业",
    "your gists": "你的代码片段",
    "your github pages site is currently being built from the": "您的 GitHub Pages 站点，目前正建立于",
    "your github profile": "我的 GitHub 个人资料",
    "your issues": "您的议题",
    "your new repository details": "您的新仓库详情",
    "your old repository’s clone url": "您旧仓库的克隆地址",
    "your organizations": "你的组织",
    "your personal account": "我的个人帐户",
    "your primary email address is now private. if you previously made your email public, we’ve removed it from your profile.": "您的主电子邮箱现在是私密的。如果您以前公开了您的电子邮箱，我们已经从您的个人资料中删除了它。",
    "your primary email address is now public. to select which email to display on your profile, visit": "您的主电子邮箱现在是公开的。要选择在您的个人资料上显示的电子邮箱，请访问",
    "your primary email was changed to": "您的主电子邮箱已更改为",
    "your profile": "你的个人资料",
    "your projects": "你的项目",
    "your pull requests": "您的拉取请求",
    "your repositories": "你的仓库",
    "your repository details have been saved.": "您的仓库详细信息已保存。",
    "your saved reply was created successfully.": "您的快捷回复已成功创建。",
    "your saved reply was updated successfully.": "您的快捷回复已成功更新。",
    "your site is published at": "您的站点发布在",
    "your sponsors": "你的赞助者",
    "your stars": "你的星标",
    "your username or email:": "您的用户名或电子邮箱:",
    "you’re all set—the": "一切就绪 —",
    "you’re not": "您无",
    "yowza, that’s a big file.": "哟，这可是个大文件。",
    "— forked from": "— 复刻自",
    "✋ mentioned": "✋ 提及",
    "🎯 assigned": "🎯 已分配",
    "👀 review requested": "👀 审查请求",
    "💬 participating": "💬 参与",
    "🙌 team mentioned": "🙌 提到的团队"
  };
  const BUILTIN_PATTERNS = [
  {
    "re": "^([\\d,]+) commits? to (.+)$",
    "out": "$1 次提交到 $2"
  },
  {
    "re": "^([\\d,]+) commits?$",
    "out": "$1 次提交"
  },
  {
    "re": "^([\\d,]+) branches?$",
    "out": "$1 个分支"
  },
  {
    "re": "^([\\d,]+) tags?$",
    "out": "$1 个标签"
  },
  {
    "re": "^([\\d,]+) contributors?$",
    "out": "$1 位贡献者"
  },
  {
    "re": "^([\\d,]+) releases?$",
    "out": "$1 个发行版"
  },
  {
    "re": "^([\\d,]+) issues?$",
    "out": "$1 个议题"
  },
  {
    "re": "^([\\d,]+) pull requests?$",
    "out": "$1 个拉取请求"
  },
  {
    "re": "^([\\d,]+) files? changed$",
    "out": "$1 个文件变更"
  },
  {
    "re": "^([\\d,]+) commit(?:s)?? this (?:week|month|year)$",
    "out": "$1 次提交（本周/本月/今年）"
  }
];
  const CSS_RULES = [
  {
    "selector": "a[aria-label='Pull requests you created']",
    "key": "!html",
    "replacement": "你创建的拉取请求"
  }
];
  const VERSION = "1.0.4";

  /* ======================================================================
   * 常量与配置
   * ==================================================================== */
  const CFG_KEY = 'gh-i18n:cfg';
  const CACHE_KEY = 'gh-i18n:cache';
  const CACHE_LIMIT = 3000;
  // data-content 是 GitHub 在 SPA/Turbo 恢复时用来回填元素文本的属性，必须一起翻译，
  // 否则恢复后已译文会被覆盖回英文（仓库页标签行丢汉化就是这个原因）。
  const ATTRS = ['aria-label', 'title', 'placeholder', 'data-confirm', 'data-content'];
  const MAX_TEXT_LEN = 200; // 超过该长度的单文本节点视为正文，不翻译
  const MAX_WORDS = 5; // 词典未命中时，超过该词数不猜
  const BATCH_NODES = 300; // 单次空闲回调处理的根节点上限
  const BODY_BTN_CLASS = 'gh-i18n-bodybtn';

  const DEFAULTS = {
    enabled: true,
    translateAttrs: true,
    translateTime: true,
    remoteDict: true,
    bodyButton: true,
    service: 'google',
    fabPos: null,
    panelPos: null,
  };

  /* ---------------- GM API 包装（缺失时安全降级） ---------------- */
  const gm = {
    get(k, d) {
      try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : undefined; } catch { return undefined; }
    },
    set(k, v) {
      try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch { /* ignore */ }
    },
    del(k) {
      try { if (typeof GM_deleteValue === 'function') GM_deleteValue(k); } catch { /* ignore */ }
    },
    resource(name) {
      try { return typeof GM_getResourceText === 'function' ? GM_getResourceText(name) : null; } catch { return null; }
    },
    style(css) {
      try { if (typeof GM_addStyle === 'function') GM_addStyle(css); } catch { /* ignore */ }
    },
    menu(label, fn) {
      try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn); } catch { /* ignore */ }
    },
  };

  /* ---------------- 配置读写 ---------------- */
  let cfg = loadCfg();

  function loadCfg() {
    const raw = gm.get(CFG_KEY, '{}');
    let obj = {};
    try {
      obj = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    } catch { obj = {}; }
    return Object.assign({}, DEFAULTS, obj || {});
  }

  function saveCfg(patch) {
    cfg = Object.assign({}, cfg, patch);
    gm.set(CFG_KEY, JSON.stringify(cfg));
    return cfg;
  }

  /* ======================================================================
   * 词典：内嵌为主，@resource 远程词典兜底
   * ==================================================================== */
  const dict = Object.assign({}, BUILTIN_DICT);
  const patterns = compilePatterns(BUILTIN_PATTERNS);
  let remoteDict = null;
  let remoteTried = false;

  function loadRemoteDict() {
    if (remoteTried) return;
    remoteTried = true;
    const txt = gm.resource('zh-CN-upstream');
    if (!txt) { warn('远程词典不可用'); return; }
    try {
      const parsed = JSON.parse(txt);
      const src = (parsed && parsed.dict) || parsed || {};
      const out = {};
      let n = 0;
      for (const k of Object.keys(src)) {
        if (k.startsWith('__comments')) continue; // 上游把注释混在 dict 里
        const v = src[k];
        if (typeof v !== 'string' || !v) continue;
        const nk = normKey(k);
        if (!nk) continue;
        out[nk] = v;
        n += 1;
      }
      remoteDict = out;
      warn('远程词典已加载', n);
    } catch (e) {
      remoteDict = null;
      warn('远程词典解析失败', e);
    }
  }

  /**
   * 查询译文：形状剪枝 → 本地词典/模板 → 远程词典（可选）。
   * @returns {string|null}
   */
  function lookup(body) {
    if (skipReason(body, { maxLen: MAX_TEXT_LEN })) return null;
    const local = matchLocal(body, dict, patterns);
    if (local != null) return local;
    if (wordCount(body) > MAX_WORDS) return null;
    if (cfg.remoteDict) {
      loadRemoteDict();
      if (remoteDict) {
        const k = normKey(body);
        const v = remoteDict[k];
        if (typeof v === 'string' && v && v !== k) return v;
      }
    }
    return null;
  }

  /* ======================================================================
   * 剪枝：哪些元素整棵子树都不翻译
   * ==================================================================== */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'TEMPLATE', 'IFRAME', 'OBJECT',
    'IMG', 'SVG', 'PATH', 'CANVAS', 'VIDEO', 'AUDIO', 'MAP',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'TABLE',
  ]);
  const SKIP_CLASS = [
    'CodeMirror', 'cm-editor', 'react-code-lines', 'blob-code', 'blob-wrapper', 'highlight',
    'PRIVATE_TreeView-item', 'js-path-segment', 'final-path', 'react-tree-show-tree-items',
    'js-navigation-container', 'markdown-body', 'readme', 'topic-tag',
    'search-input-container', 'search-match', 'GlobalNav',
  ];
  const SKIP_IDS = ['readme', 'file-name-editor-breadcrumb', 'StickyHeader', 'sticky-file-name-id', 'sticky-breadcrumb'];
  const SKIP_ITEMPROP = ['name'];

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id && SKIP_IDS.indexOf(el.id) !== -1) return true;
    const cl = el.classList;
    if (cl && cl.length) {
      for (let i = 0; i < SKIP_CLASS.length; i += 1) if (cl.contains(SKIP_CLASS[i])) return true;
    }
    const ip = el.getAttribute && el.getAttribute('itemprop');
    if (ip) {
      const parts = ip.split(/\s+/);
      for (let i = 0; i < parts.length; i += 1) if (SKIP_ITEMPROP.indexOf(parts[i]) !== -1) return true;
    }
    return false;
  }

  /* ======================================================================
   * 遍历与翻译
   * ==================================================================== */
  const processedText = new WeakSet();
  const processedTime = new WeakSet();
  const processedCss = new WeakSet();
  const stats = { text: 0, attr: 0, time: 0, skipped: 0, refixed: 0 };

  // 已翻译节点 → 我写入的值。用于对抗「翻译后被页面脚本改回英文」：
  // React hydration 或 Turbo 恢复可能一次性重写文本，MutationObserver 有时来不及/不触发，
  // 由这个表在巡检时修回。
  const translatedNodes = new Map();
  const MAX_REFIX = 3; // 同一节点反复被改回时的纠错上限，避免与页面脚本无休止拉锯

  function translateTextNode(node) {
    if (!node || processedText.has(node)) return;
    const raw = node.nodeValue;
    if (!raw) return;
    const parts = splitEdges(raw);
    if (!parts.body) return;
    const hit = lookup(parts.body);
    processedText.add(node);
    if (hit == null) { stats.skipped += 1; return; }
    const next = parts.lead + hit + parts.trail;
    if (next !== raw) {
      node.nodeValue = next;
      translatedNodes.set(node, { text: next, fixes: 0 });
      stats.text += 1;
    }
  }

  function translateAttrs(el) {
    if (!cfg.translateAttrs || !el || el.nodeType !== 1) return;
    for (let i = 0; i < ATTRS.length; i += 1) {
      const a = ATTRS[i];
      const v = el.getAttribute(a);
      if (!v) continue;
      const hit = lookup(v.trim());
      if (hit && hit !== v) {
        el.setAttribute(a, hit);
        stats.attr += 1;
      }
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit')) {
      const v = el.value;
      if (v) {
        const hit = lookup(String(v).trim());
        if (hit) { el.value = hit; stats.attr += 1; }
      }
    }
  }

  function translateTimes(root) {
    if (!cfg.translateTime || !root || typeof root.querySelectorAll !== 'function') return;
    let list;
    try { list = root.querySelectorAll('relative-time'); } catch { return; }
    for (let i = 0; i < list.length; i += 1) {
      const el = list[i];
      if (processedTime.has(el)) continue;
      processedTime.add(el);
      const txt = formatRelativeTime(el.getAttribute('datetime'));
      if (!txt) continue;
      try {
        if (el.shadowRoot) el.shadowRoot.textContent = txt;
        else el.textContent = txt;
        stats.time += 1;
      } catch { /* ignore */ }
    }
  }

  /**
   * 翻译一棵子树：元素属性 + 文本节点 + Shadow DOM + 相对时间。
   */
  function translateSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && shouldSkipElement(root)) return;

    if (root.nodeType === 1) translateAttrs(root);

    const doc = root.ownerDocument || document;
    const shadowRoots = [];
    let walker;
    try {
      walker = doc.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
        acceptNode(node) {
          if (node.nodeType === 1) {
            return shouldSkipElement(node) ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */;
          }
          const p = node.parentElement;
          if (!p || shouldSkipElement(p)) return 2;
          return 1;
        },
      });
    } catch (e) {
      warn('createTreeWalker 失败', e);
      return;
    }

    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === 1) {
        if (cfg.translateAttrs) translateAttrs(node);
        if (node.shadowRoot) shadowRoots.push(node.shadowRoot);
      } else {
        translateTextNode(node);
      }
      node = walker.nextNode();
    }

    while (shadowRoots.length) translateSubtree(shadowRoots.shift());
    translateTimes(root);
  }

  /* ---------------- CSS 选择器规则 ---------------- */
  function applyCssRules(root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    for (let i = 0; i < CSS_RULES.length; i += 1) {
      const rule = CSS_RULES[i];
      if (!rule || !rule.selector || typeof rule.replacement !== 'string') continue;
      let list;
      try { list = scope.querySelectorAll(rule.selector); } catch { continue; }
      for (let j = 0; j < list.length; j += 1) {
        const el = list[j];
        if (processedCss.has(el)) continue;
        processedCss.add(el);
        try {
          if (rule.key === '!html') el.innerHTML = rule.replacement;
          else el.setAttribute(rule.key, rule.replacement);
        } catch { /* ignore */ }
      }
    }
  }

  /* ======================================================================
   * 增量处理：MutationObserver + 空闲分片
   * ==================================================================== */
  let observer = null;
  let pendingRoots = [];
  let scheduled = false;

  const idle = typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback.bind(window)
    : (cb) => window.setTimeout(() => cb({ timeRemaining: () => 8 }), 16);

  function schedule(nodes) {
    for (let i = 0; i < nodes.length; i += 1) if (nodes[i]) pendingRoots.push(nodes[i]);
    if (scheduled || !pendingRoots.length) return;
    scheduled = true;
    idle(runPending);
  }

  function runPending() {
    scheduled = false;
    if (!cfg.enabled) { pendingRoots = []; return; }
    const list = pendingRoots;
    pendingRoots = [];
    const slice = list.slice(0, BATCH_NODES);
    const rest = list.slice(BATCH_NODES);
    for (let i = 0; i < slice.length; i += 1) {
      try { translateSubtree(slice[i]); } catch (e) { warn(e); }
    }
    if (rest.length) schedule(rest);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      if (!cfg.enabled) return;
      const roots = [];
      for (let i = 0; i < muts.length; i += 1) {
        const m = muts[i];
        if (m.type === 'childList') {
          for (let j = 0; j < m.addedNodes.length; j += 1) {
            const n = m.addedNodes[j];
            if (n.nodeType === 1 || n.nodeType === 3) roots.push(n);
          }
        } else if (m.type === 'characterData') {
          processedText.delete(m.target); // 允许重新翻译被框架改写的文本
          roots.push(m.target);
        } else {
          roots.push(m.target);
        }
      }
      if (roots.length) schedule(roots);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS.concat(['value', 'datetime']),
    });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function fullTranslate() {
    if (!cfg.enabled || !document.body) return;
    translateSubtree(document.body);
    applyCssRules(document);
  }

  /**
   * 巡检：把被页面脚本改回英文的已译文本修回来；顺便清理已离开文档的节点。
   * @returns {{fixed:number, tracked:number}}
   */
  function verifyTranslated(limit) {
    const max = limit || 200;
    let fixed = 0;
    const stale = [];
    translatedNodes.forEach((rec, node) => {
      if (!node.isConnected) { stale.push(node); return; }
      if (node.nodeValue === rec.text) return;
      if (rec.fixes >= MAX_REFIX) { stale.push(node); return; }
      const parts = splitEdges(node.nodeValue);
      const hit = parts.body ? lookup(parts.body) : null;
      if (!hit) { stale.push(node); return; }
      if (fixed >= max) return;
      const next = parts.lead + hit + parts.trail;
      node.nodeValue = next;
      rec.text = next;
      rec.fixes += 1;
      stats.refixed += 1;
      fixed += 1;
    });
    for (let i = 0; i < stale.length; i += 1) translatedNodes.delete(stale[i]);
    if (fixed) warn('巡检修回', fixed, '处');
    return { fixed, tracked: translatedNodes.size };
  }

  /* ---------------- SPA 路由切换 ---------------- */
  let lastHref = location.href;
  function watchRoute() {
    const onNav = (e) => {
      lastHref = location.href;
      // 导航/恢复后立刻重扫一次（Turbo 会用 data-content 回填，故重扫必须够快）
      if (cfg.enabled) window.setTimeout(fullTranslate, 50);
      if (e && e.type === 'popstate' && cfg.enabled) window.setTimeout(fullTranslate, 300);
    };
    try {
      document.addEventListener('turbo:load', onNav, true);
      document.addEventListener('pjax:end', onNav, true);
      window.addEventListener('popstate', onNav, true);
    } catch { /* ignore */ }
    window.setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      if (cfg.enabled) window.setTimeout(fullTranslate, 300);
    }, 1000);
  }

  /* ======================================================================
   * 正文按需翻译
   * ==================================================================== */
  const BODY_CACHE = (() => {
    try {
      const raw = gm.get(CACHE_KEY, '{}');
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  })();
  let cacheDirty = false;

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  function cachePut(seg, val) {
    BODY_CACHE[fnv1a(seg)] = val;
    cacheDirty = true;
    const keys = Object.keys(BODY_CACHE);
    if (keys.length > CACHE_LIMIT) {
      for (let i = 0; i < keys.length - CACHE_LIMIT; i += 1) delete BODY_CACHE[keys[i]];
    }
  }

  function cacheFlush() {
    if (!cacheDirty) return;
    cacheDirty = false;
    gm.set(CACHE_KEY, JSON.stringify(BODY_CACHE));
  }

  function cacheClear() {
    for (const k of Object.keys(BODY_CACHE)) delete BODY_CACHE[k];
    gm.del(CACHE_KEY);
  }

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest 不可用')); return; }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) resolve(r.responseText);
          else reject(new Error('HTTP ' + r.status));
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  function callGoogle(text) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
    return httpGet(url).then((txt) => {
      const data = JSON.parse(txt);
      const segs = (data && data[0]) || [];
      return segs.map((s) => (s && s[0]) || '').join('');
    });
  }

  function callGitcn(text) {
    let repoId = '0';
    try {
      const meta = document.querySelector('meta[name=octolytics-dimension-repository_id]');
      if (meta && meta.content) repoId = meta.content;
    } catch { /* ignore */ }
    const url = 'https://gitcn.org/translate?i=' + encodeURIComponent(repoId) + '&q=' + encodeURIComponent(text);
    return httpGet(url).then((html) => {
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      return (doc.body && doc.body.textContent || '').trim();
    });
  }

  function callTranslate(text) {
    return cfg.service === 'gitcn' ? callGitcn(text) : callGoogle(text);
  }

  /** 把返回的整段文本按行拆回各段；对不上时只认第一条，避免错位。 */
  function splitResult(text, n) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return new Array(n).fill(null);
    if (n === 1) return [s];
    const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length === n) return lines;
    const out = new Array(n).fill(null);
    out[0] = s;
    return out;
  }

  /**
   * 批量翻译若干段文本：先查缓存，未命中再按批次请求。
   * @returns {Promise<(string|null)[]>} 与输入等长、按序对应
   */
  async function translateSegments(segs) {
    const results = new Array(segs.length).fill(null);
    const need = [];
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      if (!s) continue;
      const hit = BODY_CACHE[fnv1a(s)];
      if (typeof hit === 'string' && hit) results[i] = hit;
      else need.push({ s, i });
    }
    if (!need.length) return results;

    const batches = [];
    let cur = [];
    let len = 0;
    for (const it of need) {
      if (cur.length && (len + it.s.length > 1500 || cur.length >= 20)) { batches.push(cur); cur = []; len = 0; }
      cur.push(it);
      len += it.s.length + 1;
    }
    if (cur.length) batches.push(cur);

    for (const batch of batches) {
      const joined = batch.map((x) => x.s).join('\n');
      let raw;
      try {
        raw = await callTranslate(joined);
      } catch (e) {
        warn('翻译请求失败', e);
        throw e;
      }
      const parts = splitResult(raw, batch.length);
      for (let k = 0; k < batch.length; k += 1) {
        const val = parts[k];
        if (val) {
          results[batch[k].i] = val;
          cachePut(batch[k].s, val);
        }
      }
    }
    cacheFlush();
    return results;
  }

  /** 收集容器内可译文本节点（跳过代码、脚本、按钮自身） */
  function collectBodyNodes(container) {
    const out = [];
    let walker;
    try {
      walker = document.createTreeWalker(container, 4 /* SHOW_TEXT */, {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return 2;
          if (p.closest('code, pre, script, style, svg, textarea, .' + BODY_BTN_CLASS)) return 2;
          if (!node.nodeValue || !node.nodeValue.trim()) return 2;
          return 1;
        },
      });
    } catch { return out; }
    let n = walker.nextNode();
    while (n && out.length < 400) { out.push(n); n = walker.nextNode(); }
    return out;
  }

  async function onBodyButton(container, btn) {
    if (btn.dataset.state === 'translated') {
      const saved = container.__ghI18nOriginals;
      if (saved && saved.nodes) {
        for (let i = 0; i < saved.nodes.length; i += 1) {
          const n = saved.nodes[i];
          if (n && n.isConnected) n.nodeValue = saved.texts[i];
        }
      }
      btn.dataset.state = '';
      btn.textContent = '译';
      btn.title = '机器翻译这段内容（再点一次显示原文）';
      return;
    }
    btn.disabled = true;
    btn.textContent = '翻译中…';
    try {
      const nodes = collectBodyNodes(container);
      const texts = nodes.map((n) => n.nodeValue);
      const segs = texts.map((s) => s.trim());
      const results = await translateSegments(segs);
      let done = 0;
      for (let i = 0; i < nodes.length; i += 1) {
        const r = results[i];
        if (!r || !segs[i]) continue;
        nodes[i].nodeValue = nodes[i].nodeValue.replace(segs[i], r);
        done += 1;
        processedText.delete(nodes[i]);
      }
      container.__ghI18nOriginals = { nodes, texts };
      btn.dataset.state = 'translated';
      btn.disabled = false;
      btn.textContent = '原文';
      btn.title = '显示原文';
      if (!done) btn.title = '没有可翻译的内容';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '翻译失败';
      btn.title = '翻译失败：' + (e && e.message ? e.message : e) + '（可在设置里切换翻译服务）';
    }
  }

  const BODY_SELECTORS = [
    '.markdown-body',
    '[data-testid="repository-about"]',
    'p.f4.my-3',
  ];

  function injectBodyButtons() {
    if (!cfg.enabled || !cfg.bodyButton) return;
    for (const sel of BODY_SELECTORS) {
      let list;
      try { list = document.querySelectorAll(sel); } catch { continue; }
      for (let i = 0; i < list.length; i += 1) {
        const container = list[i];
        if (!container || container.dataset.ghI18nBtn === '1') continue;
        if (container.closest('#gh-i18n-panel, #gh-i18n-fab')) continue;
        container.dataset.ghI18nBtn = '1';
        const btn = h('button', { class: BODY_BTN_CLASS, type: 'button', title: '机器翻译这段内容（再点一次显示原文）' }, ['译']);
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onBodyButton(container, btn);
        });
        container.insertBefore(btn, container.firstChild);
      }
    }
  }

  function removeBodyButtons() {
    const list = document.querySelectorAll('.' + BODY_BTN_CLASS);
    for (let i = 0; i < list.length; i += 1) {
      const btn = list[i];
      if (btn.parentElement) {
        if (btn.parentElement.dataset) delete btn.parentElement.dataset.ghI18nBtn;
        btn.parentElement.removeChild(btn);
      }
    }
  }

  /* ======================================================================
   * UI：悬浮入口 + 设置面板
   * ==================================================================== */
  const STYLE = `
.gh-i18n-hidden{display:none !important}
#gh-i18n-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;
  justify-content:center;height:28px;padding:0 12px;border-radius:999px;background:#1f6feb;color:#fff;
  font:600 12px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;user-select:none;
  border:1px solid rgba(255,255,255,.15);box-shadow:0 4px 12px rgba(0,0,0,.35);color-scheme:dark;touch-action:none}
#gh-i18n-fab:hover{background:#388bfd}
#gh-i18n-fab.gh-i18n-dragging,#gh-i18n-panel.gh-i18n-dragging{cursor:grabbing;opacity:.9}
#gh-i18n-panel{position:fixed;right:18px;bottom:58px;z-index:2147483001;width:274px;background:#161b22;
  color:#e6edf3;border:1px solid #30363d;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.5);
  font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color-scheme:dark;overflow:hidden}
.gh-i18n-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;
  background:#21262d;cursor:move;font-weight:600;touch-action:none}
.gh-i18n-close{background:none;border:0;color:#8b949e;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px}
.gh-i18n-close:hover{color:#e6edf3}
.gh-i18n-body{padding:6px 10px 10px;max-height:62vh;overflow:auto}
.gh-i18n-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;cursor:pointer}
.gh-i18n-row:hover{color:#fff}
.gh-i18n-knob{position:relative;flex:0 0 auto;width:34px;height:18px;border-radius:999px;background:#30363d;
  transition:background .15s}
.gh-i18n-knob::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:#8b949e;transition:left .15s,background .15s}
.gh-i18n-knob.on{background:#1f6feb}
.gh-i18n-knob.on::after{left:18px;background:#fff}
.gh-i18n-dot{flex:0 0 auto;width:14px;height:14px;border-radius:50%;border:1px solid #30363d;box-sizing:border-box}
.gh-i18n-dot.on{border-color:#1f6feb;background:radial-gradient(circle at center,#1f6feb 0 4px,transparent 5px)}
.gh-i18n-group{padding:8px 0 2px;color:#8b949e;font-size:11px;border-top:1px solid #21262d;margin-top:6px}
.gh-i18n-btn{width:100%;margin-top:6px;padding:6px 8px;border-radius:6px;background:#21262d;color:#e6edf3;
  border:1px solid #30363d;cursor:pointer;font:inherit}
.gh-i18n-btn:hover{background:#30363d}
.gh-i18n-tip{margin-top:8px;color:#8b949e;font-size:11px}
.gh-i18n-tip a{color:#58a6ff;text-decoration:none}
.${BODY_BTN_CLASS}{float:right;margin:0 0 8px 8px;padding:2px 8px;border-radius:999px;background:#1f6feb;
  color:#fff;border:0;cursor:pointer;font:600 11px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:.85}
.${BODY_BTN_CLASS}:hover{opacity:1}
.${BODY_BTN_CLASS}:disabled{opacity:.5;cursor:default}
`;

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (k === 'class') el.className = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'disabled') el.disabled = !!v;
        else if (k === 'selected') el.selected = !!v;
        else if (k === 'text') el.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
    }
    if (children) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return el;
  }

  function applyPos(el, pos) {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    const w = el.offsetWidth || 0;
    const hh = el.offsetHeight || 0;
    const maxX = w ? Math.max(0, window.innerWidth - w) : window.innerWidth;
    const maxY = hh ? Math.max(0, window.innerHeight - hh) : window.innerHeight;
    const x = Math.min(Math.max(0, pos.x), maxX);
    const y = Math.min(Math.max(0, pos.y), maxY);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function makeDraggable(el, handle, onDrop) {
    const target = handle || el;
    let dragging = false;
    let moved = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    let pid = null;

    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      dragging = true;
      moved = false;
      pid = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      try { target.setPointerCapture(pid); } catch { /* ignore */ }
    });

    target.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.sqrt(dx * dx + dy * dy) > 3) {
        moved = true;
        el.classList.add('gh-i18n-dragging');
      }
      if (!moved) return;
      applyPos(el, { x: ox + dx, y: oy + dy });
      e.preventDefault();
    });

    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('gh-i18n-dragging');
      try { target.releasePointerCapture(pid); } catch { /* ignore */ }
      if (moved && onDrop) {
        const r = el.getBoundingClientRect();
        onDrop({ x: Math.round(r.left), y: Math.round(r.top) });
      }
      window.setTimeout(() => { moved = false; }, 0);
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    // 拖动后紧跟的 click 忽略掉
    el.addEventListener('click', (e) => {
      if (moved) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  let fab = null;
  let panel = null;

  function buildFab() {
    if (fab) return fab;
    fab = h('div', { id: 'gh-i18n-fab', title: 'GitHub汉化插件：点击打开设置' }, ['译']);
    fab.addEventListener('click', () => togglePanel());
    makeDraggable(fab, fab, (pos) => saveCfg({ fabPos: pos }));
    document.body.appendChild(fab);
    applyPos(fab, cfg.fabPos);
    return fab;
  }

  function switchRow(label, key) {
    const knob = h('div', { class: 'gh-i18n-knob' });
    const row = h('div', { class: 'gh-i18n-row' }, [h('span', {}, [label]), knob]);
    const sync = () => { knob.classList.toggle('on', !!cfg[key]); };
    row.addEventListener('click', () => {
      saveCfg({ [key]: !cfg[key] });
      sync();
      onCfgChanged(key);
    });
    sync();
    return row;
  }

  function radioRow(label, value) {
    const dot = h('div', { class: 'gh-i18n-dot' });
    const row = h('div', { class: 'gh-i18n-row' }, [h('span', {}, [label]), dot]);
    const sync = () => { dot.classList.toggle('on', cfg.service === value); };
    row.addEventListener('click', () => {
      saveCfg({ service: value });
      refreshPanel();
    });
    sync();
    row.__sync = sync;
    return row;
  }

  function refreshPanel() {
    if (!panel) return;
    const rows = panel.querySelectorAll('.gh-i18n-row');
    for (let i = 0; i < rows.length; i += 1) {
      if (typeof rows[i].__sync === 'function') rows[i].__sync();
    }
  }

  function onCfgChanged(key) {
    if (key === 'enabled') {
      if (cfg.enabled) { startObserver(); fullTranslate(); injectBodyButtons(); }
      else stopObserver();
    } else if (key === 'bodyButton') {
      if (cfg.bodyButton) injectBodyButtons();
      else removeBodyButtons();
    } else if (key === 'translateAttrs' || key === 'translateTime') {
      if (cfg.enabled) fullTranslate();
    } else if (key === 'remoteDict') {
      if (cfg.remoteDict) loadRemoteDict();
    }
  }

  function buildPanel() {
    if (panel) return panel;
    const serviceRows = [radioRow('Google 翻译', 'google'), radioRow('gitcn.org', 'gitcn')];
    const clearBtn = h('button', { class: 'gh-i18n-btn', type: 'button' }, ['清除正文翻译缓存']);
    clearBtn.addEventListener('click', () => {
      cacheClear();
      clearBtn.textContent = '已清除';
      window.setTimeout(() => { clearBtn.textContent = '清除正文翻译缓存'; }, 1200);
    });
    const closeBtn = h('button', { class: 'gh-i18n-close', type: 'button', title: '关闭' }, ['✕']);
    closeBtn.addEventListener('click', () => hidePanel());
    const title = h('div', { class: 'gh-i18n-title' }, [h('span', {}, ['GitHub汉化插件 v' + VERSION]), closeBtn]);
    const body = h('div', { class: 'gh-i18n-body' }, [
      switchRow('启用汉化', 'enabled'),
      switchRow('翻译属性文本', 'translateAttrs'),
      switchRow('相对时间中文化', 'translateTime'),
      switchRow('远程词典兜底', 'remoteDict'),
      switchRow('正文「译」按钮', 'bodyButton'),
      h('div', { class: 'gh-i18n-group' }, ['正文翻译服务']),
      ...serviceRows,
      clearBtn,
      h('div', { class: 'gh-i18n-tip' }, [
        '词条译名遵循 GitHub 官方词汇表',
        h('a', { href: 'https://docs.github.com/zh/get-started/learning-about-github/github-glossary', target: '_blank', rel: 'noreferrer' }, [' 中文译本']),
        '。拖标题栏可移动本面板。',
      ]),
    ]);
    panel = h('div', { id: 'gh-i18n-panel', class: 'gh-i18n-hidden' }, [title, body]);
    makeDraggable(panel, title, (pos) => saveCfg({ panelPos: pos }));
    document.body.appendChild(panel);
    applyPos(panel, cfg.panelPos);
    return panel;
  }

  function openPanel() {
    buildPanel();
    panel.classList.remove('gh-i18n-hidden');
  }

  function hidePanel() {
    if (panel) panel.classList.add('gh-i18n-hidden');
  }

  function togglePanel() {
    if (!panel || panel.classList.contains('gh-i18n-hidden')) openPanel();
    else hidePanel();
  }

  /* ======================================================================
   * 诊断工具（手测用）：
   *   window.__ghI18n.diagnose('Pull requests')  查看某文本为何被/未被翻译
   *   window.__ghI18n.collect()                  列出「像 UI 名称但词典未命中」的英文
   * ==================================================================== */
  function diagnose(text) {
    const needle = String(text == null ? '' : text).trim();
    const zh = dict[normKey(needle)];
    const result = { query: needle, version: VERSION, 期望译文: zh || null, found: false, nodes: 0,
      ancestors: [], nodeValue: null, nodeTranslated: null, thisTextNextTranslation: null,
      跟踪表大小: translatedNodes.size, tracked: null };
    if (!needle || !document.body) return result;
    const walker = document.createTreeWalker(document.body, 4, null);
    let n = walker.nextNode();
    while (n) {
      const v = (n.nodeValue || '').trim();
      if (v === needle || (zh && v === zh)) {
        result.nodes += 1;
        if (!result.found) {
          result.found = true;
          result.nodeValue = n.nodeValue;
          result.nodeTranslated = !!(zh && v === zh);
          result.skipReason = skipReason(v, { maxLen: MAX_TEXT_LEN });
          result.lookupResult = lookup(v);
          result.thisTextNextTranslation = lookup(needle);
          const rec = translatedNodes.get(n);
          result.tracked = rec ? { expected: rec.text, fixes: rec.fixes } : null;
          let el = n.parentElement;
          while (el && el !== document.documentElement) {
            const cls = typeof el.className === 'string' ? el.className : '';
            result.ancestors.push({ tag: el.tagName, id: el.id || '', cls: cls.slice(0, 140), skipped: shouldSkipElement(el) });
            el = el.parentElement;
          }
        }
      }
      n = walker.nextNode();
    }
    console.log('[gh-i18n] diagnose 结果：', JSON.stringify(result, null, 2));
    return result;
  }

  function collect(limit) {
    const max = limit || 300;
    const found = new Map();
    if (!document.body) return [];
    const walker = document.createTreeWalker(document.body, 4, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || shouldSkipElement(p)) return 2;
        return 1;
      },
    });
    let n = walker.nextNode();
    while (n && found.size < max) {
      const raw = n.nodeValue;
      if (raw) {
        const body = splitEdges(raw).body;
        if (body && body.length <= 60 && /^[A-Za-z]/.test(body) && !/[\u4e00-\u9fff]/.test(body)
          && !/[.!?:]$/.test(body) && wordCount(body) <= 6
          && skipReason(body, { maxLen: MAX_TEXT_LEN }) === null && lookup(body) == null) {
          found.set(body, (found.get(body) || 0) + 1);
        }
      }
      n = walker.nextNode();
    }
    const arr = [...found.keys()].sort();
    console.log('[gh-i18n] 词典未命中的候选 UI 文本 ' + arr.length + ' 条（可整段复制给维护者补词条）：\n' + arr.join('\n'));
    return arr;
  }

  /* ======================================================================
   * 初始化
   * ==================================================================== */
  function init() {
    gm.style(STYLE);
    buildFab();
    if (cfg.remoteDict) loadRemoteDict();
    if (cfg.enabled) {
      fullTranslate();
      startObserver();
      injectBodyButtons();
    }
    watchRoute();
    window.setInterval(() => {
      if (cfg.enabled && cfg.bodyButton) injectBodyButtons();
    }, 2500);
    // 抗覆盖巡检：页面脚本把已译文本改回英文时修回来
    window.setInterval(() => {
      if (!cfg.enabled || !document.body) return;
      idle(() => { try { verifyTranslated(200); } catch (e) { warn(e); } });
    }, 2000);
    gm.menu('GitHub汉化插件：打开设置', () => openPanel());

    // 调试/测试入口
    window.__ghI18n = {
      diagnose,
      collect,
      verifyTranslated,
      version: VERSION,
      dict,
      patterns,
      cssRules: CSS_RULES,
      cfg: () => Object.assign({}, cfg),
      lookup,
      stats,
      translate: fullTranslate,
      injectBodyButtons,
      translateSegments,
    };
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
