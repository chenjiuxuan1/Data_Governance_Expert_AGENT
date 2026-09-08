# 数据治理专家 · KN Chat 交互守护（测试包）

通过 KN Chat 与「数据治理专家」实时交互的守护进程。用户发命令（`/保留` `/下线` `/归档`），守护进程实时接收、落库、回复。

## 文件说明

| 文件 | 作用 |
|---|---|
| `knchat_connectivity_test.py` | **连通性测试**：验证本机能否访问 bot.kn.chat（5 项检查，3 秒出结果） |
| `gov-bot.py` | **交互守护进程**：长轮询 getUpdates，收命令/问题→处理→回复（测试版只应答 jiangchuanchen） |
| `gov_profiler.py` | **表画像查询**：查延迟/停更/调用者/配置 |
| `gov_llm.py` | **Qwen 模型调用**（qwen3.7-plus，参考 n8n 异常sql优化通知） |
| `requirements.txt` | 依赖（纯标准库，无第三方依赖） |
| `README.md` | 本说明 |

## 快速开始

### 第一步：连通性测试（必做）

在**目标部署机器**上运行：

```bash
python3 knchat_connectivity_test.py
```

5 项检查全 ✅ = 这台机器可以部署。若 DNS/TCP/HTTPS 失败 = 该机器访问不了公网 `bot.kn.chat`，需换公网可达的机器。

### 第二步：启动交互守护

```bash
python3 gov-bot.py
```

启动后挂起等待消息，收到命令自动处理回复。测试阶段只应答 `jiangchuanchen`（user_id CHANGE_ME_USER_ID）。

### 第三步：验证

用 KN Chat 给机器人发消息：

```
/help
/保留 ods_app_hold_apply
```

应收到自动回复。台账记录写入 `/tmp/gov-bot/ledger.json`。

## 生产部署（systemd）

```bash
sudo tee /etc/systemd/system/gov-bot.service > /dev/null <<'EOF'
[Unit]
Description=Data Governance Bot (KN Chat)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/gov-bot
ExecStart=/usr/bin/python3 /opt/gov-bot/gov-bot.py
Restart=always
RestartSec=5
Environment=KN_CHAT_BOT_TOKEN=你的专属bot_token
Environment=RECORD_GROUP_CHAT_ID=记录群chat_id
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gov-bot
sudo systemctl start gov-bot
journalctl -u gov-bot -f   # 看日志
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `KN_CHAT_BOT_TOKEN` | 测试 token | 正式用专属 bot token |
| `RECORD_GROUP_CHAT_ID` | 空 | 记录群 chat_id（每条通知/回答转发到群留痕） |

## 安全提醒

- 测试 token 是「异常sql告警机器人」，**正式上线前请换成「数据治理专家」专属 bot token**
- 守护进程**只能跑一个实例**（同一 bot 多个消费者会抢消息）
- `/tmp/gov-bot/` 存放 offset 和台账，服务器上确认可写
