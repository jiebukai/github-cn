/**
 * 运行时冒烟测试：用自研的最小 DOM stub 在 Node 里真跑一遍构建产物，
 * 验证「脚本能加载 → init 不抛错 → window.__ghI18n 就位 → 真的把 UI 文本翻成中文」。
 *
 * 为什么需要：浏览器行为无法自动化，但「脚本在真实 DOM 上会不会一上来就崩」
 * 以及「剪枝/属性翻译有没有真的生效」完全可以在 Node 里验。
 * 这里只依赖 node:vm 与 node:test，保持零第三方依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = join(ROOT, 'GitHub汉化插件.user.js');

/* ---------------------------------- DOM stub ---------------------------------- */
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

class TextNode {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = null;
  }
  get isConnected() { return true; }
}

class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this._attrs = new Map();
    this._classes = new Set();
    this.childNodes = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.shadowRoot = null;
    this.value = '';
    this.offsetWidth = 120;
    this.offsetHeight = 30;
  }
  get classList() {
    const set = this._classes;
    return {
      get length() { return set.size; },
      contains: (c) => set.has(c),
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (on ? set.add(c) : set.delete(c))),
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) {
    this._attrs.set(k, String(v));
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  removeAttribute(k) { this._attrs.delete(k); }
  get id() { return this.getAttribute('id') || ''; }
  appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) {
    c.parentElement = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    return c;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join('');
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentElement = null;
    this.childNodes = [new TextNode(String(v))];
    this.childNodes[0].parentElement = this;
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { this.textContent = String(v).replace(/<[^>]*>/g, ''); }
  addEventListener() {}
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight }; }
  closest(selector) {
    let el = this;
    while (el) {
      if (matches(el, selector)) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      for (const c of el.childNodes) {
        if (c.nodeType !== 1) continue;
        if (matches(c, selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

/** 极简选择器匹配：支持 tag、.class、[attr="v"]、tag.class[attr='v'] 与逗号分组 */
function matches(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  return String(selector).split(',').some((part) => {
    const sel = part.trim();
    if (!sel) return false;
    if (sel === '*') return true;
    const attrRe = /\[([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\]/g;
    let m;
    let rest = sel;
    const attrs = [];
    while ((m = attrRe.exec(sel))) attrs.push([m[1], m[2] !== undefined ? m[2] : m[3]]);
    rest = sel.replace(attrRe, '');
    const classParts = (rest.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
    const tag = rest.replace(/\.[\w-]+/g, '').trim();
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    for (const c of classParts) if (!el._classes.has(c)) return false;
    for (const [k, v] of attrs) if (el.getAttribute(k) !== v) return false;
    return true;
  });
}

function createTreeWalker(root, _whatToShow, filter) {
  const nodes = [];
  (function walk(el) {
    for (const child of el.childNodes) {
      const verdict = filter && filter.acceptNode ? filter.acceptNode(child) : FILTER_ACCEPT;
      if (verdict === FILTER_REJECT) continue; // 跳过该节点及其整棵子树
      if (verdict === FILTER_ACCEPT) nodes.push(child);
      if (child.nodeType === 1) walk(child);
    }
  })(root);
  let i = 0;
  return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
}

/* --------------------------------- 文档构造 --------------------------------- */
function h(tag, attrs, children) {
  const el = new Element(tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const c of children || []) el.appendChild(typeof c === 'string' ? new TextNode(c) : c);
  return el;
}

function buildDocument() {
  const html = new Element('html');
  const body = new Element('body');
  html.appendChild(body);

  // 1) 仓库页导航：span 带 data-content，文本节点应该被翻译
  const nav = h('nav', { class: 'js-repo-nav UnderlineNav' }, [
    h('ul', { class: 'UnderlineNav-body list-style-none' }, [
      h('li', { class: 'd-inline-flex' }, [
        h('a', { id: 'pull-requests-tab', class: 'UnderlineNav-item no-wrap', 'aria-label': 'Pull requests' }, [
          h('span', { 'data-content': 'Pull requests' }, ['Pull requests']),
        ]),
      ]),
    ]),
  ]);
  body.appendChild(nav);

  // 2) README 正文（markdown-body）必须整棵跳过
  const readme = h('div', { class: 'markdown-body' }, [
    h('p', {}, ['Pull requests should stay untouched inside readme']),
  ]);
  body.appendChild(readme);

  // 3) 代码块必须跳过
  body.appendChild(h('code', {}, ['Pull requests in code']));

  // 4) 标识符（owner/repo）不该被翻
  body.appendChild(h('a', { href: '/jiebukai/github-cn' }, ['owner/repo']));

  // 5) itemprop=name（仓库名）不该被翻
  body.appendChild(h('span', { itemprop: 'name' }, ['Issues']));

  // 6) 普通按钮文本应该被翻
  body.appendChild(h('button', {}, ['Issues']));

  // 7) 相对时间
  body.appendChild(h('relative-time', { datetime: '2026-06-21T12:00:00Z' }, ['Jun 21, 2026']));

  // 8) 普通英文长句（>5 词且词典未命中）不该被猜翻
  body.appendChild(h('p', {}, ['this sentence is long and should not be guessed']));

  return { html, body };
}

function runUserscript() {
  const code = readFileSync(ARTIFACT, 'utf8');
  const { html, body } = buildDocument();
  const doc = {
    body,
    documentElement: html,
    readyState: 'complete',
    createElement: (tag) => new Element(tag),
    createTextNode: (v) => new TextNode(String(v)),
    createDocumentFragment: () => new Element('#fragment'),
    createTreeWalker,
    querySelector: (sel) => (matches(body, sel) ? body : (body.querySelectorAll(sel)[0] || null)),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAllWithin: () => [],
  };
  doc.head = new Element('head');

  const store = new Map();
  const sandbox = {
    console: { log() {}, debug() {}, warn() {}, error() {} },
    document: doc,
    NodeFilter: { FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP: 3, SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} takeRecords() { return []; } },
    // 定时器：setTimeout 立即执行（脚本内只有短延迟重扫），setInterval 不执行（避免测试挂住）
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    requestIdleCallback: (cb) => { cb({ timeRemaining: () => 8 }); return 1; },
    cancelIdleCallback: () => {},
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => { store.set(k, v); },
    GM_deleteValue: (k) => { store.delete(k); },
    GM_getResourceText: () => null,
    GM_addStyle: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {},
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'https://github.com/jiebukai/github-cn', pathname: '/jiebukai/github-cn' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'GitHub汉化插件.user.js' });
  return { sandbox, body, doc, store };
}

/* ----------------------------------- 断言 ----------------------------------- */
test('产物能在 DOM 上加载并完成初始化（window.__ghI18n 就位）', () => {
  const { sandbox } = runUserscript();
  assert.ok(sandbox.__ghI18n, 'window.__ghI18n 未设置 —— init 可能抛错或未执行');
  assert.match(String(sandbox.__ghI18n.version), /^\d+\.\d+\.\d+$/);
});

test('仓库页导航标签被翻译（文本节点 + data-content 属性）', () => {
  const { body } = runUserscript();
  const span = body.querySelectorAll('span')[0];
  assert.equal(span.textContent, '拉取请求', '文本节点未被翻译');
  assert.equal(span.getAttribute('data-content'), '拉取请求', 'data-content 未被翻译');
  assert.equal(span.parentElement.getAttribute('aria-label'), '拉取请求', 'aria-label 未被翻译');
});

test('剪枝生效：README 正文、代码块、标识符、仓库名都不翻译', () => {
  const { body } = runUserscript();
  // README 容器里只会多出脚本注入的「译」按钮，正文本身必须原样
  assert.match(
    body.querySelectorAll('.markdown-body')[0].textContent,
    /Pull requests should stay untouched inside readme/,
    'README 正文被翻译了',
  );
  assert.equal(body.querySelectorAll('code')[0].textContent, 'Pull requests in code', '代码块被翻译了');
  assert.ok(body.textContent.includes('owner/repo'), '标识符 owner/repo 被改动了');
  const nameSpan = body.querySelectorAll('[itemprop="name"]')[0];
  assert.equal(nameSpan.textContent, 'Issues', 'itemprop=name 不应被翻译');
});

test('普通按钮文本被翻译，长句不被瞎猜', () => {
  const { body } = runUserscript();
  const texts = body.querySelectorAll('button').map((b) => b.textContent);
  assert.ok(texts.includes('议题'), '按钮文本未被翻译，实际：' + JSON.stringify(texts));
  assert.ok(
    body.textContent.includes('this sentence is long and should not be guessed'),
    '无明显词典命中的长句被误翻',
  );
});

test('相对时间中文化', () => {
  const { body } = runUserscript();
  const rt = body.querySelectorAll('relative-time')[0];
  assert.match(rt.textContent, /前$|个月前|年前/, 'relative-time 未中文化：' + rt.textContent);
});

test('巡检函数可被调用且不抛错', () => {
  const { sandbox } = runUserscript();
  assert.equal(typeof sandbox.__ghI18n.verifyTranslated, 'function');
  const r = sandbox.__ghI18n.verifyTranslated(10);
  assert.equal(typeof r.fixed, 'number');
  assert.equal(typeof r.tracked, 'number');
});

test('diagnose/collect 可被调用且不抛错', () => {
  const { sandbox } = runUserscript();
  const d = sandbox.__ghI18n.diagnose('Pull requests');
  assert.equal(d.found, true, 'diagnose 未找到文本');
  assert.equal(typeof d.version, 'string');
  const c = sandbox.__ghI18n.collect(20);
  assert.ok(Array.isArray(c));
});
