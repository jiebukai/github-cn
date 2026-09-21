#!/usr/bin/env python3
"""覆盖率审计：用真实 GitHub 页面 HTML 离线跑一遍脚本的剪枝与词典规则，
量化「可译文本命中词典的比例」，并列出「像 UI 名称但词典未命中」的候选。

为什么要这个：脚本体在浏览器里跑，维护者没有浏览器自动化能力；
抓 SSR HTML + 复用与脚本同一份规则（直接从 src/userscript.template.js 解析），
可以在本地把"漏翻清单"和"剪枝是否过宽"量化出来，作为补词条的依据。

用法：
    python tools/audit-coverage.py                     # 默认页面集
    python tools/audit-coverage.py --pages URL1 URL2
    python tools/audit-coverage.py --min-count 1 --limit 300
    python tools/audit-coverage.py --no-proxy          # 直连（不走本地 SOCKS5）

注意：只抓公开页面；需要登录的页面（/settings 等）抓不到，那部分仍需人工反馈。
"""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import socket
import ssl
import sys
import tempfile
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROXY = ('127.0.0.1', 10808)
# 抓到的 HTML 缓存在系统临时目录：同一页面重复审计不再请求 GitHub（匿名抓取有 429 限流）
CACHE_DIR = pathlib.Path(tempfile.gettempdir()) / 'github-cn-audit-cache'


def cache_file(url):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / (hashlib.sha1(url.encode('utf-8')).hexdigest() + '.html')


def fetch(url, use_proxy=True, timeout=25, refresh=False):
    """优先读本地缓存；--refresh 时强制重新抓取。"""
    cp = cache_file(url)
    if cp.exists() and not refresh:
        return 200, cp.read_text(encoding='utf-8')
    status, text = fetch_net(url, use_proxy, timeout)
    if status == 200:
        cp.write_text(text, encoding='utf-8')
    return status, text

DEFAULT_PAGES = [
    'https://github.com/microsoft/vscode',
    'https://github.com/microsoft/vscode/issues',
    'https://github.com/microsoft/vscode/pulls',
    'https://github.com/microsoft/vscode/actions',
    'https://github.com/microsoft/vscode/wiki',
    'https://github.com/explore',
    'https://github.com/topics/javascript',
    'https://github.com/search?q=react&type=repositories',
]

VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
             'link', 'meta', 'param', 'source', 'track', 'wbr'}


# ---------------------------------------------------------------- 规则提取
def load_rules():
    """从模板源码里解析规则，保证审计用的就是脚本运行时的那一份。"""
    tpl = (ROOT / 'src' / 'userscript.template.js').read_text(encoding='utf-8')

    def str_list(pattern):
        m = re.search(pattern, tpl, re.S)
        if not m:
            raise SystemExit('无法从模板解析规则：%s' % pattern)
        return re.findall(r"'([^']*)'", m.group(1))

    rules = {
        'SKIP_TAGS': set(t.upper() for t in str_list(r'SKIP_TAGS = new Set\(\[(.*?)\]\)')),
        'SKIP_CLASS': str_list(r'SKIP_CLASS = \[(.*?)\]'),
        'SKIP_IDS': str_list(r'SKIP_IDS = \[(.*?)\]'),
        'ATTRS': str_list(r'ATTRS = \[(.*?)\]'),
        'MAX_TEXT_LEN': int(re.search(r'MAX_TEXT_LEN = (\d+)', tpl).group(1)),
        'MAX_WORDS': int(re.search(r'MAX_WORDS = (\d+)', tpl).group(1)),
    }
    dic = json.loads((ROOT / 'locales' / 'zh-CN.json').read_text(encoding='utf-8'))['dict']
    pats = json.loads((ROOT / 'locales' / 'patterns.json').read_text(encoding='utf-8'))['patterns']
    compiled = []
    for p in pats:
        try:
            compiled.append((re.compile(p['re'], re.I), p['out']))
        except re.error:
            pass
    rules['dict'] = dic
    rules['patterns'] = compiled
    return rules


# ------------------------------------------------------- 规则复刻（同 JS 侧）
NUMERIC_RE = re.compile(r'^[\d\s.,:%+\-/()°]+$')
HEX_RE = re.compile(r'^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$', re.I)
EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')
URL_RE = re.compile(r'(?:^|\s)(?:https?://|www\.)\S+', re.I)
CODE_EXT_RE = re.compile(
    r'\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|sh|ps1|bat|cmd|yml|yaml|json|json5|'
    r'toml|ini|cfg|md|markdown|txt|css|scss|less|sass|html|htm|xml|svg|sql|kt|kts|swift|dart|lua|pl|pm|'
    r'r|vue|svelte|lock|env)$', re.I)
PASCAL_RE = re.compile(r'^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$')
CAMEL_RE = re.compile(r'^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+$')
CONST_RE = re.compile(r'^[A-Z0-9]+(?:_[A-Z0-9]+)+$')


def norm_key(s):
    return re.sub(r'\s+', ' ', s.replace('\u00a0', ' ')).strip().lower()


def is_structural(t):
    return bool(NUMERIC_RE.match(t) or HEX_RE.match(t) or EMAIL_RE.match(t) or URL_RE.search(t))


def is_identifier_like(t):
    if not t or re.search(r'\s', t):
        return False
    if CODE_EXT_RE.search(t):
        return True
    if re.search(r'[-_./@:#=+~^]', t):
        return True
    if re.match(r'^[A-Za-z]*\d+[A-Za-z0-9]*$', t):
        return True
    if PASCAL_RE.match(t) or CAMEL_RE.match(t) or CONST_RE.match(t):
        return True
    return False


def skip_reason(body, max_len):
    t = body.strip()
    if not t:
        return 'empty'
    if len(t) > max_len:
        return 'too-long'
    if is_structural(t):
        return 'structural'
    if is_identifier_like(t):
        return 'identifier'
    return None


def lookup(body, rules):
    if skip_reason(body, rules['MAX_TEXT_LEN']):
        return None
    key = norm_key(body)
    d = rules['dict']
    if key in d and d[key] != key:
        return d[key]
    for rex, out in rules['patterns']:
        if rex.search(body):
            return rex.sub(out, body)
    if len(body.split()) > rules['MAX_WORDS']:
        return None
    return None


# ------------------------------------------------------------------ 抓取
def fetch_net(url, use_proxy=True, timeout=25):
    m = re.match(r'https://([^/]+)(/.*)?$', url)
    if not m:
        raise ValueError('只支持 https URL: %s' % url)
    host, path = m.group(1), m.group(2) or '/'
    if use_proxy:
        s = socket.create_connection(PROXY, timeout=timeout)
        s.sendall(b'\x05\x01\x00')
        if s.recv(2) != b'\x05\x00':
            raise RuntimeError('SOCKS5 握手失败，代理没开？')
        h = host.encode()
        s.sendall(b'\x05\x01\x00\x03' + bytes([len(h)]) + h + b'\x01\xbb')
        r = s.recv(4)
        if r[1] != 0:
            raise RuntimeError('SOCKS5 连接失败: %r' % r)
        if r[3] == 1:
            s.recv(4)
        elif r[3] == 3:
            s.recv(s.recv(1)[0])
        elif r[3] == 4:
            s.recv(16)
        s.recv(2)
    else:
        s = socket.create_connection((host, 443), timeout=timeout)
    ss = ssl.create_default_context().wrap_socket(s, server_hostname=host)
    ss.sendall((
        'GET %s HTTP/1.1\r\nHost: %s\r\n'
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36\r\n'
        'Accept: text/html,application/xhtml+xml\r\nAccept-Language: en-US,en;q=0.9\r\n'
        'Accept-Encoding: identity\r\nConnection: close\r\n\r\n' % (path, host)
    ).encode())
    buf = []
    while True:
        d = ss.recv(65536)
        if not d:
            break
        buf.append(d)
    ss.close()
    raw = b''.join(buf)
    i = raw.find(b'\r\n\r\n')
    head, body = raw[:i].decode('latin1'), raw[i + 4:]
    status = int(head.split(' ')[1])
    if 'chunked' in head.lower():
        body = dechunk(body)
    return status, body.decode('utf-8', 'replace')


def dechunk(data):
    out = b''
    while data:
        j = data.find(b'\r\n')
        if j < 0:
            break
        try:
            size = int(data[:j].split(b';')[0], 16)
        except ValueError:
            break
        if size == 0:
            break
        out += data[j + 2: j + 2 + size]
        data = data[j + 2 + size + 2:]
    return out


# ------------------------------------------------------------------ 解析
class Collector(HTMLParser):
    def __init__(self, rules):
        super().__init__(convert_charrefs=True)
        self.rules = rules
        self.stack = []
        self.texts = []
        self.pruned = collections.Counter()

    def _skip(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get('class') or '').split()
        if tag.upper() in self.rules['SKIP_TAGS']:
            return 'tag:' + tag.upper()
        if a.get('id') and a['id'] in self.rules['SKIP_IDS']:
            return 'id:' + a['id']
        for c in cls:
            if c in self.rules['SKIP_CLASS']:
                return 'class:' + c
        if 'name' in (a.get('itemprop') or '').split():
            return 'itemprop:name'
        return None

    def handle_starttag(self, tag, attrs):
        parent_open = self.stack[-1]['open'] if self.stack else True
        why = self._skip(tag, attrs)
        if why:
            self.pruned[why] += 1
        self.stack.append({'tag': tag, 'open': parent_open and not why})
        if tag in VOID_TAGS:
            self.stack.pop()

    def handle_startendtag(self, tag, attrs):
        why = self._skip(tag, attrs)
        if why:
            self.pruned[why] += 1

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]['tag'] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if not self.stack or not self.stack[-1]['open']:
            return
        t = data.strip()
        if t:
            self.texts.append(t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pages', nargs='*', default=None)
    ap.add_argument('--min-count', type=int, default=2)
    ap.add_argument('--limit', type=int, default=250)
    ap.add_argument('--no-proxy', action='store_true')
    ap.add_argument('--refresh', action='store_true', help='忽略本地缓存，重新抓取')
    args = ap.parse_args()

    rules = load_rules()
    pages = args.pages or DEFAULT_PAGES
    use_proxy = not args.no_proxy

    hit = miss = 0
    candidates = collections.Counter()
    pruned = collections.Counter()
    failed = []

    for url in pages:
        try:
            status, html = fetch(url, use_proxy, refresh=args.refresh)
        except Exception as e:  # noqa: BLE001 - 审计工具，失败就跳过并报告
            failed.append('%s -> %s' % (url, e))
            continue
        if status != 200:
            failed.append('%s -> HTTP %s' % (url, status))
            continue
        c = Collector(rules)
        c.feed(html)
        pruned.update(c.pruned)
        for t in c.texts:
            if lookup(t, rules):
                hit += 1
            else:
                miss += 1
                body = t.strip()
                if (len(body) <= 60 and re.match(r'^[A-Za-z]', body)
                        and not re.search(r'[\u4e00-\u9fff]', body)
                        and not re.search(r'[.!?]$', body)
                        and len(body.split()) <= 8
                        and skip_reason(body, rules['MAX_TEXT_LEN']) is None):
                    candidates[body] += 1
        print('  已解析 %-60s 文本节点 %d' % (url, len(c.texts)), file=sys.stderr)

    total = hit + miss
    print('\n=== 覆盖率审计（%d 页）===' % (len(pages) - len(failed)))
    print('可译文本节点：%d' % total)
    if total:
        print('  命中词典：%d（%.1f%%）' % (hit, 100.0 * hit / total))
        print('  未命中：%d' % miss)
    if failed:
        print('抓取失败：')
        for f in failed:
            print('  ' + f)

    if pruned:
        print('\n=== 被剪枝的元素（top 15，用于检查剪枝是否过宽）===')
        for why, n in pruned.most_common(15):
            print('  %-28s %d' % (why, n))

    rows = [(t, n) for t, n in candidates.items() if n >= args.min_count]
    rows.sort(key=lambda x: (-x[1], x[0]))
    print('\n=== 未命中候选（出现 ≥%d 次，共 %d 条，显示前 %d）==='
          % (args.min_count, len(rows), args.limit))
    print('可直接把下面这段贴给维护者补词条：\n')
    for t, n in rows[:args.limit]:
        print('%4d × %s' % (n, t))


if __name__ == '__main__':
    main()
