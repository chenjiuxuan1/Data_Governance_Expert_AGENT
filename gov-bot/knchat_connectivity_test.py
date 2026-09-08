#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据治理专家 · KN Chat 连通性测试脚本（只测不常驻）
====================================================
用途：在目标服务器（或任意机器）上验证能否访问 bot.kn.chat，
      判断「数据治理专家」交互守护是否能部署在这台机器。

用法：
    python3 knchat_connectivity_test.py

输出：DNS / TCP 443 / HTTPS API 三项目连通结果，全部 OK 即可部署。

作者：数据治理专家 Pi 包
日期：2026-09
"""

import json
import socket
import ssl
import sys
import urllib.request
import urllib.parse
import time

# ============ 配置（可改） ============
BOT_TOKEN = "CHANGE_ME_BOT_TOKEN"  # 测试 bot token（异常sql告警机器人）
API_HOST = "bot.kn.chat"
API_BASE = f"https://{API_HOST}"
TEST_EMAIL = "CHANGE_ME_EMAIL"  # 测试用邮箱（解析 user_id）
# =====================================


def banner(text):
    print("=" * 60)
    print(text)
    print("=" * 60)


def test_dns():
    banner("1. DNS 解析")
    try:
        infos = socket.getaddrinfo(API_HOST, 443, proto=socket.IPPROTO_TCP)
        addrs = sorted({info[4][0] for info in infos})
        for a in addrs:
            print(f"  ✅ {API_HOST} -> {a}")
        return True
    except Exception as e:
        print(f"  ❌ DNS 解析失败: {e}")
        return False


def test_tcp():
    banner("2. TCP 443 连通")
    try:
        with socket.create_connection((API_HOST, 443), timeout=8):
            print(f"  ✅ TCP 443 连接成功 ({API_HOST})")
        return True
    except Exception as e:
        print(f"  ❌ TCP 443 连接失败: {e}")
        return False


def test_https():
    banner("3. HTTPS Bot API (getMe)")
    url = f"{API_BASE}/bot{BOT_TOKEN}/getMe"
    t0 = time.time()
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode())
            cost = time.time() - t0
            if body.get("ok"):
                bot = body["result"]
                print(f"  ✅ getMe 成功 ({cost:.2f}s)")
                print(f"     bot: {bot.get('first_name')} (@{bot.get('username')})")
                return True
            else:
                print(f"  ❌ getMe 返回异常: {body}")
                return False
    except Exception as e:
        print(f"  ❌ HTTPS 请求失败: {e}")
        return False


def test_resolve_user():
    banner("4. resolveUserId（按邮箱解析用户）")
    url = f"{API_BASE}/bot{BOT_TOKEN}/resolveUserId?email={urllib.parse.quote(TEST_EMAIL)}"
    t0 = time.time()
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode())
            cost = time.time() - t0
            if body.get("ok"):
                print(f"  ✅ resolveUserId 成功 ({cost:.2f}s)")
                print(f"     {TEST_EMAIL} -> user_id: {body['result']['user_id']}")
                return True
            else:
                print(f"  ❌ resolveUserId 失败: {body.get('description')}")
                return False
    except Exception as e:
        print(f"  ❌ 请求失败: {e}")
        return False


def test_long_poll():
    banner("5. getUpdates 长轮询（挂起 8 秒验证实时通道）")
    url = f"{API_BASE}/bot{BOT_TOKEN}/getUpdates?limit=1&timeout=8"
    t0 = time.time()
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode())
            cost = time.time() - t0
            if body.get("ok"):
                n = len(body.get("result", []))
                print(f"  ✅ getUpdates 长轮询可用 ({cost:.1f}s 挂起, 返回 {n} 条)")
                return True
            else:
                desc = body.get("description", "")
                if "Conflict" in desc or "other getUpdates" in desc:
                    # 网络是通的，只是有别的实例在 poll（共享 bot 的正常现象）
                    print(f"  ⚠️ 长轮询被占用（Conflict）——网络通，但该 bot 已有其他实例在 poll")
                    print(f"     （共享测试 bot 的正常现象；部署专属 bot 后无此问题）")
                    print(f"     网络连通性判定：✅ 通过")
                    return True
                print(f"  ❌ getUpdates 失败: {desc}")
                return False
    except Exception as e:
        print(f"  ❌ 请求失败: {e}")
        return False


def main():
    print()
    banner("数据治理专家 · KN Chat 连通性测试")
    print(f"目标: {API_BASE}")
    print(f"时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print()

    results = {}
    results["dns"] = test_dns()
    results["tcp"] = test_tcp()
    results["https"] = test_https()
    results["resolve"] = test_resolve_user()
    results["poll"] = test_long_poll()

    print()
    banner("测试结果汇总")
    ok = sum(1 for v in results.values() if v)
    for k, v in results.items():
        print(f"  {'✅' if v else '❌'} {k}: {'通过' if v else '失败'}")
    print()
    if ok == len(results):
        print("🎉 全部通过！本机可以部署「数据治理专家」交互守护进程。")
        print("    下一步: 运行 python3 gov-bot.py 启动交互守护")
        sys.exit(0)
    else:
        print("⚠️ 部分失败。若 DNS/TCP/HTTPS 失败，说明本机无法访问公网 bot.kn.chat，")
        print("    需要换一台公网可达的机器部署（如 n8n 服务器、阿里云 ECS 等）。")
        sys.exit(1)


if __name__ == "__main__":
    main()
