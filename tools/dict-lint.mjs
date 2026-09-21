#!/usr/bin/env node
/**
 * 词典体检：键归一化、空译文、未翻译、残留英文、patterns 正则与捕获组、css 规则完整性、重复键。
 * 有 error → 退出码 1；warning 仅提示。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normKey } from '../src/engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

/** 允许在译文中保留的英文术语（专有名词/缩写） */
const ALLOW_EN = new Set([
  'wiki', 'ssh', 'gpg', 'url', 'urls', 'api', 'apis', 'git', 'github', 'gist', 'markdown', 'json', 'yaml', 'yml',
  'oauth', 'saml', 'sso', 'totp', 'cli', 'ci', 'cd', 'pr', 'pdf', 'csv', 'utf', 'rest', 'graphql', 'sql',
  'ai', 'ui', 'ux', 'os', 'mac', 'macos', 'ios', 'android', 'windows', 'linux', 'vscode', 'npm', 'pnpm', 'yarn',
  'docker', 'kubernetes', 'k8s', 'php', 'python', 'ruby', 'node', 'eslint', 'webhook', 'webhooks', 'token',
  'tokens', 'key', 'keys', 'ide', 'dns', 'tls', 'ssl', 'http', 'https', 'html', 'css', 'js', 'ts', 'web', 'sponsors',
  'lfs', 'pages',
]);

const readJSON = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const readRaw = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 取出从 fromIndex 处开始的那个 JSON 对象字面量文本（用于检测重复键） */
function extractObject(text, fromIndex) {
  const open = text.indexOf('{', fromIndex);
  if (open < 0) return '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

const dictFile = readJSON('locales/zh-CN.json');
const patternsFile = readJSON('locales/patterns.json');
const cssFile = readJSON('locales/css-rules.json');

// 1) 重复键（JSON.parse 会静默丢重复，必须扫原文）
const raw = readRaw('locales/zh-CN.json');
const dictRegion = extractObject(raw, raw.indexOf('"dict"'));
const keyHits = dictRegion.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm) || [];
const seen = new Map();
for (const hit of keyHits) {
  const k = JSON.parse(hit.trim().replace(/:$/, ''));
  seen.set(k, (seen.get(k) || 0) + 1);
}
for (const [k, c] of seen) if (c > 1) errors.push(`dict 重复键 ${JSON.stringify(k)} ×${c}`);

// 2) 逐条体检
const dict = dictFile.dict || {};
for (const [k, v] of Object.entries(dict)) {
  if (k !== normKey(k)) errors.push(`键未归一化：${JSON.stringify(k)} → ${JSON.stringify(normKey(k))}`);
  if (typeof v !== 'string' || !v.trim()) {
    errors.push(`空译文：${JSON.stringify(k)}`);
    continue;
  }
  if (v === k) {
    warnings.push(`译名与键相同（疑未翻译）：${JSON.stringify(k)}`);
    continue;
  }
  const phrases = v.match(/[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*)+/g) || [];
  for (const phrase of phrases) {
    const words = phrase.split(/\s+/).map((w) => w.toLowerCase());
    if (words.every((w) => ALLOW_EN.has(w))) continue;
    warnings.push(`译文疑残留英文：${JSON.stringify(k)} → ${JSON.stringify(v)}（${phrase}）`);
  }
}

// 3) patterns
const pats = [...(patternsFile.patterns || []), ...(dictFile.patterns || [])];
pats.forEach((p, i) => {
  if (!p || typeof p.re !== 'string') { errors.push(`patterns[${i}] 缺少 re`); return; }
  if (typeof p.out !== 'string') { errors.push(`patterns[${i}] 缺少 out`); return; }
  try {
    new RegExp(p.re, p.flags || '');
  } catch (e) {
    errors.push(`patterns[${i}] 正则非法：${e.message}`);
    return;
  }
  const groups = (p.re.match(/\((?!\?)/g) || []).length;
  const refs = [...p.out.matchAll(/\$(\d)/g)].map((m) => Number(m[1]));
  for (const r of refs) if (r > groups) errors.push(`patterns[${i}] out 引用不存在的捕获组 $${r}`);
});

// 4) css
const css = [...(cssFile.css || []), ...(dictFile.css || [])];
css.forEach((r, i) => {
  if (!r || typeof r.selector !== 'string' || !r.selector) errors.push(`css[${i}] 缺少 selector`);
  if (!r || typeof r.key !== 'string' || !r.key) errors.push(`css[${i}] 缺少 key`);
  if (!r || typeof r.replacement !== 'string') errors.push(`css[${i}] 缺少 replacement`);
});

console.log(`[dict-lint] dict ${Object.keys(dict).length} 条、patterns ${pats.length} 条、css ${css.length} 条`);
for (const w of warnings) console.log('  warn  ' + w);
for (const e of errors) console.error('  error ' + e);
if (errors.length) {
  console.error(`[dict-lint] 失败：${errors.length} 个错误、${warnings.length} 个警告`);
  process.exit(1);
}
console.log(`[dict-lint] 通过（${warnings.length} 个警告）`);
