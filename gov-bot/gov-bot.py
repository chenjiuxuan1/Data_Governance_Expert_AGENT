#!/usr/bin/env python3
"""
数据治理专家 · KN Chat 交互守护进程（测试版）
- 长轮询 getUpdates，实时接收用户命令
- 解析 /保留 /下线 /归档 /不在我 /help /my
- 落库（MySQL 台账，测试阶段先记录到本地 JSON）
- sendMessage 回复
- 测试阶段：仅应答 jiangchuanchen（CHANGE_ME_USER_ID），其他人消息忽略
"""
import json, time, urllib.request, urllib.parse, re, os, sys
from datetime import datetime

# 自由问题自动回答（数据画像）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gov_profiler import profile_table, format_profile, extract_table_from_question

BOT_TOKEN = os.environ.get("KN_CHAT_BOT_TOKEN", "")
API_BASE = "https://bot.kn.chat"
# 允许应答的用户（测试阶段白名单；逗号分隔多个 user_id，如 "1571267276,123456789"）
# 留空 = 应答所有用户（正式上线放开）
_ALLOWED_STR = os.environ.get("ALLOWED_USER_IDS", "").strip()
ALLOWED_USER_IDS = {int(x) for x in _ALLOWED_STR.split(",") if x.strip().isdigit()} if _ALLOWED_STR else None
LOG_DIR = "/tmp/gov-bot"
OFFSET_FILE = f"{LOG_DIR}/offset.json"
LEDGER_FILE = f"{LOG_DIR}/ledger.json"
# 记录群（数据治理专家记录群），未配置则跳过留痕
_RECORD_STR = os.environ.get("RECORD_GROUP_CHAT_ID", "").strip()
RECORD_GROUP_ID = int(_RECORD_STR) if _RECORD_STR.lstrip("-").isdigit() else None

os.makedirs(LOG_DIR, exist_ok=True)

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def api(method, params=None, body=None):
    """调用 KN Chat Bot API"""
    url = f"{API_BASE}/bot{BOT_TOKEN}/{method}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="POST" if body else "GET")
    if body:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        log(f"API {method} 错误: {str(e)[:120]}")
        return None

def load_offset():
    try:
        return json.load(open(OFFSET_FILE)).get("offset", 0)
    except Exception:
        return 0

def save_offset(offset):
    json.dump({"offset": offset, "updated_at": datetime.now().isoformat()},
              open(OFFSET_FILE, "w"))

def load_ledger():
    try:
        return json.load(open(LEDGER_FILE))
    except Exception:
        return []

def save_ledger(entries):
    json.dump(entries, open(LEDGER_FILE, "w"), ensure_ascii=False, indent=1)

def record_action(entry):
    """落库：记录处理动作（测试阶段写本地 JSON，生产换 MySQL）"""
    ledger = load_ledger()
    entry["created_at"] = datetime.now().isoformat()
    ledger.append(entry)
    save_ledger(ledger)
    log(f"台账落库: {entry}")

def to_record_group(text):
    """转发到记录群（如已配置）"""
    if not RECORD_GROUP_ID:
        return
    resp = api("sendMessage", body={"chat_id": RECORD_GROUP_ID, "text": text})
    if resp and resp.get("ok"):
        log(f"记录群转发 OK (msg_id={resp['result'].get('message_id')})")
    else:
        log(f"记录群转发失败: {resp}")

def INTRO_TEXT():
    """完整自我介绍（/start /help /你是谁 时返回）"""
    return (
        "🤖 <b>数据治理专家</b>\n\n"
        "我是数仓数据治理的 AI 助手，负责<b>僵尸表识别、数据质量监控、表生命周期治理</b>。"
        "我持续扫描各国数仓，找出长期无人使用、数据停更、分桶不合理的表，并帮你确认每张表的处置方案。\n\n"
        "──────────\n"
        "<b>📊 我能做什么</b>\n"
        "• <b>表画像查询</b>：直接问某张表的情况，我自动查数据返回\n"
        "  例：「查一下 ods_app_hold_apply 什么情况」\n"
        "• <b>僵尸表识别</b>：告诉你是停更、零访问还是无人认领\n"
        "• <b>数据延迟检测</b>：对比源库判断是真延迟还是业务停更\n"
        "• <b>调用者定位</b>：查这张表最近谁在用、谁是负责人\n"
        "• <b>治理处置</b>：确认保留 / 申请下线 / 归档\n\n"
        "──────────\n"
        "<b>📋 治理命令</b>\n"
        "<code>/保留 表名</code> - 确认保留，不再提示\n"
        "<code>/下线 表名</code> - 申请下线（生成DROP草稿）\n"
        "<code>/归档 表名</code> - 申请归档\n"
        "<code>/不在我 表名</code> - 拒绝归属\n"
        "<code>/my</code> - 我的问题表\n"
        "<code>/status</code> - 服务状态\n\n"
        "──────────\n"
        "<b>💬 怎么用</b>\n"
        "直接<b>私聊我</b>，用自然语言问表的情况，或用上面的命令处理。"
        "所有通知和你的回复都会同步到「数据治理专家记录群」留痕。\n\n"
        "支持国家：泰国（首批）· 更多国家陆续接入"
    )

def handle_command(cmd, table, user_id, username):
    """处理治理命令"""
    if cmd == "保留":
        msg = (f"✅ 已记录：<b>{table}</b> 状态=保留\n"
               f"操作人: {username}\n\n"
               f"该表将保留在数仓，不再提示。")
        record_action({"action": "KEEP", "table": table, "user_id": user_id, "username": username})
    elif cmd == "下线":
        msg = (f"🗑 已记录：<b>{table}</b> 申请下线（待审批）\n"
               f"操作人: {username}\n\n"
               f"将生成 DROP 草稿，审批通过后执行。")
        record_action({"action": "DROP", "table": table, "user_id": user_id, "username": username})
    elif cmd == "归档":
        msg = (f"📦 已记录：<b>{table}</b> 申请归档\n"
               f"操作人: {username}\n\n"
               f"该表将进入归档流程。")
        record_action({"action": "ARCHIVE", "table": table, "user_id": user_id, "username": username})
    elif cmd == "不在我":
        msg = (f"👋 已记录：<b>{table}</b> 归属拒绝\n"
               f"操作人: {username}\n\n"
               f"将不再向您发送该表通知。")
        record_action({"action": "REJECT", "table": table, "user_id": user_id, "username": username})
    else:
        msg = f"❓ 未知命令: {cmd} {table}"
    return msg

def process_message(m):
    """处理一条用户消息"""
    user_id = m.get("from", {}).get("id")
    username = m.get("from", {}).get("username", "")
    text = m.get("text", "")
    # 白名单：None=应答所有用户；否则只应答名单内用户
    if ALLOWED_USER_IDS is not None and user_id not in ALLOWED_USER_IDS:
        log(f"忽略非白名单用户 {user_id} 的消息: {text[:50]}")
        return
    log(f"收到 {username}: {text!r}")
    # 记录群留痕（入站）
    to_record_group(f"[IN] {username}: {text}")

    # 解析命令
    if text.startswith("/"):
        parts = text.split(maxsplit=1)
        cmd_full = parts[0][1:].lower()
        arg = parts[1] if len(parts) > 1 else ""
        # 简单命令
        if cmd_full in ("start", "help"):
            reply = INTRO_TEXT()
        elif cmd_full in ("status",):
            reply = ("🟢 <b>数据治理专家 · 服务状态</b>\n"
                     "• 运行状态: <b>正常</b>\n"
                     "• bot: @Data_Governance_Expert_bot\n"
                     "• 模型: qwen3.7-plus\n"
                     "• 覆盖: 泰国问题表 80 张\n"
                     "• 记录群: 数据治理专家记录群 ✅")
        elif cmd_full == "my":
            reply = "📋 您的问题表清单（测试阶段）：\n- ods_app_hold_apply（已保留）"
        elif cmd_full in ("保留", "下线", "归档", "不在我"):
            if not arg:
                reply = f"⚠️ 用法: /{cmd_full} 表名"
            else:
                reply = handle_command(cmd_full, arg.strip(), user_id, username)
        else:
            reply = f"❓ 未知命令 /{cmd_full}，发送 /help 查看帮助"
    else:
        # 自我介绍类问题（你是谁/有什么能力/能干什么/介绍）
        intro_keywords = ["你是谁", "你是什么", "自我介绍", "介绍一下你", "有哪些能力", "什么能力",
                          "你能做什么", "能干什么", "会做什么", "介绍下你", "你叫", "你的功能",
                          "help", "功能", "介绍", "能力", "who are you", "what can you do",
                          "你的职责", "是干嘛的", "干什么的", "有什么用"]
        if any(k in text.lower() for k in intro_keywords):
            reply = INTRO_TEXT()
            log(f"识别为自我介绍类问题: {text!r}")
            api("sendMessage", body={
                "chat_id": user_id,
                "text": reply,
                "parse_mode": "HTML",
            })
            to_record_group(f"[OUT] 自我介绍")
            return

        # 自由问题：提取表名 → 查画像 → Qwen 组织回答
        tbl = extract_table_from_question(text)
        if tbl:
            prof = profile_table(tbl)
            if prof and prof.get("found"):
                # 用 Qwen 把画像数据组织成自然语言回答
                try:
                    from gov_llm import ask_qwen
                    profile_summary = format_profile(prof)  # 已有结构化画像
                    user_prompt = (
                        f"用户问：{text}\n\n"
                        f"以下是数据治理画像数据：\n{profile_summary}\n\n"
                        "请基于以上数据事实回答用户的问题。要求：简洁、条理清晰、"
                        "标注关键数字（延迟天数、调用者），不要编造画像之外的数据，"
                        "结尾给出治理建议（保留/归档/下线）。"
                    )
                    qwen_ans = ask_qwen(user_prompt)
                    if qwen_ans:
                        reply = qwen_ans
                    else:
                        reply = format_profile(prof)  # LLM 失败回退到模板
                except Exception:
                    reply = format_profile(prof)
            else:
                reply = (f"🤔 我在泰国问题表清单里没找到 <code>{tbl}</code> 的画像数据。\n"
                         f"可尝试: <code>/保留 表名</code> / <code>/归档 表名</code> / <code>/下线 表名</code>")
        else:
            reply = ("🤖 我是数据治理专家。\n\n"
                     "你可以：\n"
                     "• 直接问某张表情况，如「查一下 ods_app_hold_apply 什么情况」\n"
                     "• 发命令: <code>/help</code> 查看全部命令")

    # 回复用户
    api("sendMessage", body={
        "chat_id": user_id,
        "text": reply,
        "parse_mode": "HTML",
    })
    # 记录群留痕（出站）
    to_record_group(f"[OUT] {reply}")
    log(f"已回复 {username}")

def main():
    log("数据治理专家 · KN Chat 交互守护启动")
    log(f"允许用户: {ALLOWED_USER_IDS}")
    offset = load_offset()
    log(f"初始 offset: {offset}")
    while True:
        try:
            result = api("getUpdates", params={
                "offset": offset,
                "limit": 20,
                "timeout": 30,
            })
            if not result or not result.get("ok"):
                time.sleep(2)
                continue
            updates = result.get("result", [])
            for u in updates:
                m = u.get("message")
                if m:
                    process_message(m)
                # 处理 callback_query（如将来按钮可用）
                cq = u.get("callback_query")
                if cq:
                    log(f"收到 callback_query: {json.dumps(cq, ensure_ascii=False)[:200]}")
                # 推进 offset
                offset = u["update_id"] + 1
            if updates:
                save_offset(offset)
                log(f"offset 推进到 {offset}")
        except KeyboardInterrupt:
            log("退出")
            break
        except Exception as e:
            log(f"主循环错误: {str(e)[:150]}")
            time.sleep(3)

if __name__ == "__main__":
    main()
