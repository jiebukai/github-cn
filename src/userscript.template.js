// ==UserScript==
// @name         GitHub汉化插件
// @namespace    https://github.com/jiebukai/github-cn/
// @version      /*__VERSION__*/
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
  /*__ENGINE__*/

  /* ======================================================================
   * 内联：词典与规则（构建期注入 locales/*.json）
   * ==================================================================== */
  const BUILTIN_DICT = {
    /*__DICT__*/
  };
  const BUILTIN_PATTERNS = /*__PATTERNS__*/;
  const CSS_RULES = /*__CSS__*/;
  const VERSION = /*__VERSION_JSON__*/;

  /* ======================================================================
   * 常量与配置
   * ==================================================================== */
  const CFG_KEY = 'gh-i18n:cfg';
  const CACHE_KEY = 'gh-i18n:cache';
  const CACHE_LIMIT = 3000;
  const ATTRS = ['aria-label', 'title', 'placeholder', 'data-confirm'];
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
  const stats = { text: 0, attr: 0, time: 0, skipped: 0 };

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

  /* ---------------- SPA 路由切换 ---------------- */
  let lastHref = location.href;
  function watchRoute() {
    const onNav = () => { lastHref = ''; };
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
    gm.menu('GitHub汉化插件：打开设置', () => openPanel());

    // 调试/测试入口
    window.__ghI18n = {
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
