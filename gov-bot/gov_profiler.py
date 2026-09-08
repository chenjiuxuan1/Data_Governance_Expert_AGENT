#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据治理专家 · 表画像查询模块
==============================
给定表名，返回该表的数据治理画像（延迟/停更/调用者/源库），
供 gov-bot 收到自由问题时自动组织回答。

数据来源（预置快照）：
- /tmp/th-delay-list.json        延迟登记（最新时间/延迟天数/级别）
- /tmp/th-final-catalog.json     源库 vs ods MAX（停更判定）
- /tmp/th-owners-full.json       真实调用者（审计）
- /tmp/th-ods-tables.json        ods 表配置

用法：
    from gov_profiler import profile_table
    profile_table("ods_app_hold_apply")  # -> dict
"""

import json
import os

# 预置数据文件路径（可在环境变量覆盖）
DATA_DIR = os.environ.get("GOV_DATA_DIR", "/tmp")


def _load(name):
    path = os.path.join(DATA_DIR, name)
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _norm(tbl):
    return str(tbl or "").strip().lower()


def profile_table(table_name):
    """返回表的数据治理画像 dict；表不存在返回 None"""
    tbl = _norm(table_name)
    if not tbl:
        return None

    delay_list = _load("th-delay-list.json") or []
    final_cat = _load("th-final-catalog.json") or []
    owners = _load("th-owners-full.json") or []
    ods_tables = _load("th-ods-tables.json") or []

    result = {"table": table_name, "found": False}

    # 1. 是否在延迟名单
    for r in delay_list:
        if _norm(r.get("表名")) == tbl:
            result["in_delay_list"] = True
            result["latest_time"] = r.get("最新数据时间")
            result["delay_days"] = r.get("延迟天数")
            result["level"] = r.get("级别")
            break
    else:
        result["in_delay_list"] = False

    # 2. 源库 vs ods 停更判定
    for r in final_cat:
        if _norm(r.get("tbl")) == tbl:
            src = r.get("src_max")
            ods = r.get("ods_max")
            result["src_max"] = src
            result["ods_max"] = ods
            if src and ods and "ERR" not in str(src):
                same = str(src)[:10] == str(ods)[:10]
                result["stale_source"] = same  # True=源库也停更（非同步故障）
            else:
                result["stale_source"] = None
            break

    # 3. 真实调用者
    for r in owners:
        if _norm(r.get("table")) == tbl:
            result["callers"] = r.get("users", [])
            break
    else:
        result["callers"] = []

    # 4. ods 配置信息（th-ods-tables.json 是响应包装，跳过；若为列表才解析）
    if isinstance(ods_tables, list):
        for r in ods_tables:
            if isinstance(r, dict) and _norm(r.get("dest_tbl") or r.get("table")) == tbl:
                result["increment_field"] = r.get("increment_field")
                result["increment_type"] = r.get("increment_field_type")
                result["src_tbl"] = r.get("src_tbl")
                break

    result["found"] = True
    return result


def format_profile(profile):
    """把画像 dict 格式化成 KN Chat HTML 回答"""
    if not profile or not profile.get("found"):
        return None
    t = profile["table"]
    lines = [f"<b>📋 数据治理专家 · {t} 画像</b>", ""]

    # 延迟
    if profile.get("in_delay_list"):
        lines.append(f"<b>1️⃣ 数据情况</b>")
        lines.append(f"• 最新数据: {profile.get('latest_time')}")
        lines.append(f"• 延迟: <b>{profile.get('delay_days')} 天</b>（{profile.get('level')}）")
        src = profile.get("src_max")
        ods = profile.get("ods_max")
        if profile.get("stale_source") is True:
            lines.append(f"• 已核验: <b>源库也停在 {str(ods)[:10]}</b> → 非同步故障，是源业务数据停更")
        elif profile.get("stale_source") is False:
            lines.append(f"• ⚠️ 源库有数据（{str(src)[:10]}）但 ods 旧（{str(ods)[:10]}）→ 同步延迟！")
        else:
            lines.append(f"• 源库 MAX: {src} / ods MAX: {ods}")
    else:
        lines.append("<b>1️⃣ 数据情况</b>")
        lines.append(f"• 不在当前延迟名单（数据正常或未扫描）")

    # 调用者
    callers = profile.get("callers", [])
    if callers:
        lines.append("")
        lines.append("<b>2️⃣ 谁在用</b>")
        for c in callers[:5]:
            lines.append(f"• <code>{c.get('user')}</code>（{c.get('n')}次，最近 {str(c.get('last_ts'))[:10]}）")
    else:
        lines.append("")
        lines.append("<b>2️⃣ 谁在用</b>")
        lines.append("• 近90天无真实业务调用（疑似僵尸表）")

    # 增量/源
    if profile.get("src_tbl"):
        lines.append("")
        lines.append(f"<b>3️⃣ 配置</b>")
        lines.append(f"• 源表: <code>{profile.get('src_tbl')}</code>")
        if profile.get("increment_field"):
            lines.append(f"• 增量字段: <code>{profile.get('increment_field')}</code>")

    lines.append("")
    lines.append("可回复 <code>/保留 表名</code> / <code>/归档 表名</code> / <code>/下线 表名</code>")
    return "\n".join(lines)


def extract_table_from_question(text):
    """从自由问题文本中提取表名（ods_ 开头，字母数字下划线）"""
    import re
    m = re.search(r"(ods|dwd|dws|ads)_[a-z0-9_]+", text, re.IGNORECASE)
    if m:
        return m.group(0)
    # 试试 "表 xxx" 模式
    m2 = re.search(r"(?:表|表格|table)\s*[`'\"\s]*([a-z][a-z0-9_]{2,})", text, re.IGNORECASE)
    if m2:
        return m2.group(1)
    return None


if __name__ == "__main__":
    import sys
    tbl = sys.argv[1] if len(sys.argv) > 1 else "ods_app_hold_apply"
    p = profile_table(tbl)
    if p:
        print(format_profile(p))
    else:
        print(f"表 {tbl} 未找到画像数据")
