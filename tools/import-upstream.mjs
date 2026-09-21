#!/usr/bin/env node
/**
 * 从上游 k1995/github-i18n-plugin 拉取词条，清洗后合并进 locales/zh-CN.json。
 * 只使用其「英文 → 中文」对照数据，不复制其脚本代码（见 NOTICE）。
 *
 * 用法：
 *   node tools/import-upstream.mjs                      # 默认从 jsDelivr 拉取
 *   node tools/import-upstream.mjs --from <文件或URL>
 *   node tools/import-upstream.mjs --overwrite           # 用上游值覆盖本地同键
 *
 * 合并策略：默认【本地优先】—— 本地已有该键时保留本地译文（便于持续修正），
 * 只新增上游独有的条目；加 --overwrite 才用上游覆盖。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normKey } from '../src/engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL =
  'https://cdn.jsdelivr.net/gh/k1995/github-i18n-plugin@refs/heads/master/locales/zh-CN.json';

const args = process.argv.slice(2);
const overwrite = args.includes('--overwrite');
const fromIdx = args.indexOf('--from');
const from = fromIdx >= 0 ? args[fromIdx + 1] : DEFAULT_URL;
if (!from) {
  console.error('[import-upstream] --from 需要一个文件路径或 URL');
  process.exit(1);
}

async function loadSource() {
  if (/^https?:\/\//i.test(from)) {
    const res = await fetch(from);
    if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status} ${from}`);
    return res.text();
  }
  return readFileSync(from, 'utf8');
}

const upstream = JSON.parse(await loadSource());
const upDict = (upstream && upstream.dict) || {};

const localPath = join(ROOT, 'locales', 'zh-CN.json');
const local = JSON.parse(readFileSync(localPath, 'utf8'));
const dict = { ...(local.dict || {}) };

let added = 0;
let kept = 0;
let overwritten = 0;
for (const [k, v] of Object.entries(upDict)) {
  if (k.startsWith('__comments')) continue; // 上游把注释混在 dict 里
  if (typeof v !== 'string' || !v.trim()) continue;
  const nk = normKey(k);
  if (!nk) continue;
  if (Object.prototype.hasOwnProperty.call(dict, nk)) {
    if (overwrite && dict[nk] !== v) {
      dict[nk] = v;
      overwritten += 1;
    } else {
      kept += 1;
    }
    continue;
  }
  dict[nk] = v;
  added += 1;
}

const sorted = {};
for (const k of Object.keys(dict).sort()) sorted[k] = dict[k];

const out = {
  meta: {
    ...(local.meta || {}),
    lang: 'zh-CN',
    updated: new Date().toISOString().slice(0, 10),
  },
  dict: sorted,
  patterns: local.patterns || [],
  css: local.css || [],
};
writeFileSync(localPath, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`[import-upstream] 来源：${from}`);
console.log(
  `[import-upstream] 新增 ${added} 条、保留本地 ${kept} 条、覆盖 ${overwritten} 条；现有 ${Object.keys(sorted).length} 条`,
);
console.log('[import-upstream] 下一步：node build.mjs && npm run lint:dict && npm test');
