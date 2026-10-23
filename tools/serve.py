#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地静态测试服务器（纯 Python 3 标准库，无需安装任何第三方依赖）。

用途
----
在开发机上跑一个静态文件服务器，方便局域网内的手机访问电脑上的页面做联调
（比如让手机打开 /phone.html 连到电脑上的 /pc.html）。

重要提醒
--------
1. 本服务器走的是普通 HTTP，而手机浏览器只在 HTTPS 页面里才允许读取陀螺仪
   （deviceorientation）。所以在 HTTP 下：
     - 电脑端页面（/pc.html）可以用，适合本地调试 3D 场景和录制；
     - 手机端只能使用「触摸方向键」这种备用操作方式。
   正式使用请部署到 GitHub Pages（它自带 HTTPS）。
2. 本服务器只监听局域网，请勿暴露到公网。

用法
----
    python tools/serve.py                 # 默认端口 8000
    python tools/serve.py --port 8765     # 指定端口
    python tools/serve.py --host 127.0.0.1  # 只允许本机访问
"""

import argparse
import http.server
import os
import socket
import socketserver
from pathlib import Path

# 仓库根目录：本脚本位于 tools/ 下，所以根目录是它的上一级。
ROOT = Path(__file__).resolve().parent.parent


def get_local_ip():
    """尽力获取本机的局域网 IP，用来拼出手机可以直接输入的地址。

    思路：开一个 UDP socket 连到外网地址（不会真的发包），
    这样内核会帮我们选好本机的出口网卡，再取该 socket 的本地地址即可。
    任何异常都兜底返回 127.0.0.1。
    """
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        if s is not None:
            s.close()


class SafeHandler(http.server.SimpleHTTPRequestHandler):
    """在默认的静态文件处理器上加两点改造：

    1. 安全：把解析后的真实路径和仓库根目录比对，防止目录穿越。
       使用 realpath 会一并解析符号链接，所以软链接也逃不出根目录。
    2. 禁用缓存：每次请求都返回 no-store，改完代码刷新页面就能看到最新效果。
    """

    def __init__(self, *args, **kwargs):
        # 统一以仓库根目录为服务目录
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        # 先交给父类做常规解析（它会过滤掉 URL 里的 "." 和 ".." 片段）
        raw = super().translate_path(path)
        real = os.path.realpath(raw)
        root = os.path.realpath(str(ROOT))

        # 真实路径必须落在根目录之内：等于根目录本身，或者以「根目录 + 分隔符」开头。
        # 不满足说明请求跑到根目录外面了，返回一个不存在的路径，让服务器回 404。
        if real != root and not real.startswith(root + os.sep):
            return os.path.join(root, "__path_out_of_root__")

        return real

    def end_headers(self):
        # 禁用缓存，方便调试
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 保留默认的访问日志格式，前缀加上时间戳
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


class SafeServer(socketserver.ThreadingTCPServer):
    # 允许端口刚释放就立刻复用，避免反复重启时提示端口被占用
    allow_reuse_address = True
    # 每个请求用独立线程处理，静态文件互不阻塞
    daemon_threads = True


def print_banner(host, port):
    """启动时打印访问地址，方便手机直接输入。"""
    local_ip = get_local_ip()
    line = "=" * 56
    print(line)
    print("本地静态服务器已启动，正在从仓库根目录提供文件：")
    print("  %s" % ROOT)
    print("")
    print("本机访问：")
    print("  http://localhost:%d/" % port)
    print("局域网内手机访问（需和电脑连同一个 Wi-Fi）：")
    print("  http://%s:%d/" % (local_ip, port))
    print("")
    print("页面入口：")
    print("  电脑端 3D 视口：  http://%s:%d/pc.html" % (local_ip, port))
    print("  手机端遥控器：     http://%s:%d/phone.html" % (local_ip, port))
    print("")
    print("注意：HTTP 下手机浏览器不允许读取陀螺仪，手机端只能用触摸方向键；")
    print("      正式使用请走 GitHub Pages 的 HTTPS。按 Ctrl+C 停止服务器。")
    print(line)


def main():
    parser = argparse.ArgumentParser(
        description="本项目的本地静态测试服务器（纯 Python 标准库实现，无第三方依赖）"
    )
    parser.add_argument(
        "--port", type=int, default=8000, help="监听端口，默认 8000"
    )
    parser.add_argument(
        "--host", default="0.0.0.0",
        help="监听地址，默认 0.0.0.0（局域网可访问），只允许本机请用 127.0.0.1",
    )
    args = parser.parse_args()

    # 切到仓库根目录，保证相对路径都基于根目录
    os.chdir(ROOT)

    print_banner(args.host, args.port)

    with SafeServer((args.host, args.port), SafeHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止服务器。")


if __name__ == "__main__":
    main()