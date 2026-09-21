/**
 * 纯函数层：文本归一化、词典/模板匹配、剪枝判定、相对时间格式化。
 *
 * 设计约束：这一层**不触碰 DOM**，因此可以被单元测试直接 import。
 * 构建时由 build.mjs 去掉 `export ` 前缀，内联进 GitHub汉化插件.user.js。
 */

/** 归一化词典键：NBSP → 空格、压缩连续空白、去首尾空白、转小写 */
export function normKey(s) {
  return String(s == null ? '' : s)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 拆出首尾空白，便于只替换中间内容、不破坏行内布局 */
export function splitEdges(raw) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(raw == null ? '' : raw));
  return { lead: m[1], body: m[2], trail: m[3] };
}

/** 词数（按空白分词） */
export function wordCount(s) {
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
export function isStructuralText(body) {
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
export function isIdentifierLike(body) {
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
export function skipReason(body, options) {
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
export function compilePatterns(patterns) {
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
export function matchLocal(body, dict, patterns) {
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
export function formatRelativeTime(date, now, locale) {
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
