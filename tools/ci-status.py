#!/usr/bin/env python3
"""查指定仓库的 GitHub Actions 运行结果（本地自查用）。

本机访问 api.github.com 需要经 SOCKS5 代理 127.0.0.1:10808（与 git 用的同一代理）。

用法：
    python tools/ci-status.py                          # 最近 3 次运行
    python tools/ci-status.py --wait 180               # 最多等 180 秒直到跑完
    python tools/ci-status.py --repo owner/name --no-proxy

环境变量：GITHUB_TOKEN（细粒度 PAT，只读 Actions 权限即可）。
"""
import argparse
import json
import os
import socket
import ssl
import sys
import time

PROXY = ('127.0.0.1', 10808)


def socks_get(host, path, token, use_proxy=True, timeout=25):
    if use_proxy:
        s = socket.create_connection(PROXY, timeout=timeout)
        s.sendall(b'\x05\x01\x00')
        if s.recv(2) != b'\x05\x00':
            raise RuntimeError('SOCKS5 握手失败（代理没开？）')
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
        'GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: ci-status\r\n'
        'Accept: application/vnd.github+json\r\nAuthorization: Bearer %s\r\n'
        'Accept-Encoding: identity\r\nConnection: close\r\n\r\n' % (path, host, token)
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
    return raw[:i].decode('latin1'), raw[i + 4:].decode('utf-8', 'replace')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='jiebukai/github-cn', help='owner/name')
    ap.add_argument('--wait', type=int, default=0, help='最多等待多少秒直到跑完')
    ap.add_argument('--no-proxy', action='store_true')
    args = ap.parse_args()

    token = os.environ.get('GITHUB_TOKEN', '')
    if not token:
        print('缺少环境变量 GITHUB_TOKEN', file=sys.stderr)
        return 2

    path = '/repos/%s/actions/runs?per_page=3' % args.repo
    deadline = time.time() + args.wait
    while True:
        head, body = socks_get('api.github.com', path, token, not args.no_proxy)
        status_line = head.split('\r\n')[0]
        try:
            data = json.loads(body)
        except Exception as e:  # noqa: BLE001
            print('响应解析失败：%s\n%s' % (e, body[:400]))
            return 1
        if 'workflow_runs' not in data:
            print(status_line)
            print(json.dumps(data, ensure_ascii=False)[:400])
            return 1
        runs = data['workflow_runs']
        print('%s，运行记录 %d 条' % (status_line, len(runs)))
        if not runs:
            print('尚无运行记录')
            return 0
        pending = False
        for r in runs:
            concl = r.get('conclusion')
            print('  %-10s %-12s %s  %s' % (r['status'], concl or '-', r['head_sha'][:7], r['name']))
            if r['status'] != 'completed':
                pending = True
        if not pending or time.time() >= deadline:
            return 0
        print('仍在运行，等 20 秒再查…')
        time.sleep(20)


if __name__ == '__main__':
    raise SystemExit(main())
