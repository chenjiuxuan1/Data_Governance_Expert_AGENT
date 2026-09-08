#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据治理专家 · Qwen LLM 问答模块
================================
参考 n8n「异常sql优化通知」工作流的模型调用方式：
- API:  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
- 模型: qwen3.7-plus
- 认证: Bearer token（OpenAI chat/completions 兼容格式）

用法：
    from gov_llm import ask_qwen
    answer = ask_qwen(system_prompt, user_prompt)
"""

import json
import os
import urllib.request

# ============ 配置（生产建议用环境变量，勿硬编码） ============
QWEN_URL = os.environ.get(
    "QWEN_URL",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
)
QWEN_API_KEY = os.environ.get(
    "QWEN_API_KEY",
    "CHANGE_ME_QWEN_API_KEY",  # 测试用；生产换环境变量
)
QWEN_MODEL = os.environ.get("QWEN_MODEL", "qwen3.7-plus")
QWEN_TIMEOUT = int(os.environ.get("QWEN_TIMEOUT", "60"))
# ==========================================================


def ask_qwen(user_prompt, system_prompt=None, max_tokens=None):
    """调用 Qwen 模型，返回回答文本；失败返回 None"""
    if system_prompt is None:
        system_prompt = (
            "你是数据治理专家，负责数仓僵尸表识别、数据质量、血缘分析。"
            "回答用简洁中文，结合给定的数据事实，不要编造数据。"
        )
    body = {
        "model": QWEN_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
    }
    if max_tokens:
        body["max_tokens"] = max_tokens

    req = urllib.request.Request(
        QWEN_URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {QWEN_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=QWEN_TIMEOUT) as resp:
            d = json.loads(resp.read().decode())
            if "choices" in d:
                return d["choices"][0]["message"]["content"]
            return None
    except Exception as e:
        print(f"[gov_llm] Qwen 调用失败: {str(e)[:200]}")
        return None


if __name__ == "__main__":
    import sys
    q = sys.argv[1] if len(sys.argv) > 1 else "你好"
    ans = ask_qwen(q)
    print(ans)
