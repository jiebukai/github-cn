#!/usr/bin/env node
/**
 * 构建：把 locales/*.json 与 src/engine.mjs 内联进 src/userscript.template.js，
 * 生成可安装的 GitHub汉化插件.user.js（LF、UTF-8）。
 *
 * 用法：
 *   node build.mjs           写出产物
 *   node build.mjs --check   只比对，不写；有差异则退出码 1
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_NAME = 'GitHub汉化插件.user.js';
const CHECK = process.argv.includes('--check');

function fail(msg) {
  console.error('[build] ' + msg);
  process.exit(1);
}

function mustRead(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) fail('缺少必需文件：' + rel);
  return readFileSync(p, 'utf8');
}

const pkg = JSON.parse(mustRead('package.json'));
const dictSrc = JSON.parse(mustRead('locales/zh-CN.json'));
const patternsSrc = JSON.parse(mustRead('locales/patterns.json'));
const cssSrc = JSON.parse(mustRead('locales/css-rules.json'));

const dict = { ...(dictSrc.dict || {}) };
const patterns = [...(patternsSrc.patterns || []), ...(dictSrc.patterns || [])];
const css = [...(cssSrc.css || []), ...(dictSrc.css || [])];

// 词典按字母序输出，便于 diff 与人工查找
const dictKeys = Object.keys(dict).sort();
const dictLines = dictKeys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(dict[k])}`);

const engine = mustRead('src/engine.mjs').replace(/^export /gm, '').trimEnd();
const tpl = mustRead('src/userscript.template.js');

const out = tpl
  .replace('/*__VERSION__*/', () => pkg.version)
  .replace('/*__VERSION_JSON__*/', () => JSON.stringify(pkg.version))
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__DICT__*/', () => dictLines.join(',\n    '))
  .replace('/*__PATTERNS__*/', () => JSON.stringify(patterns, null, 2))
  .replace('/*__CSS__*/', () => JSON.stringify(css, null, 2))
  .replace(/\r\n/g, '\n');

if (!out.includes('==UserScript==')) fail('产物缺少 UserScript 头');
const leftover = out.match(/\/\*__[A-Z_]+__\*\//);
if (leftover) fail('产物中仍有未替换的占位符：' + leftover[0]);

const outPath = join(ROOT, OUT_NAME);
const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
const stats = `dict ${dictKeys.length} 条、patterns ${patterns.length} 条、css ${css.length} 条`;

if (CHECK) {
  const cur = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
  if (cur === out) {
    console.log(`[build] 产物已是最新（${kb} KB，${stats}）`);
  } else {
    console.error(`[build] 产物与源不一致，请运行：node build.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(outPath, out, 'utf8');
  console.log(`[build] 已写出 ${OUT_NAME}：${kb} KB（${stats}）`);
}
