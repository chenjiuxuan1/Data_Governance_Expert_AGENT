# 数据治理专家 Data Governance Expert (AGENT)

> 数仓数据治理智能体：僵尸表识别、数据质量监控、表生命周期治理，通过 KN Chat 与负责人实时交互。

---

## 项目背景

数仓中存在大量僵尸表 / 问题表（长期无人使用、数据停更、分桶不合理），需要：

1. **识别问题表**：扫描各国数仓，找出延迟 / 零访问 / 分桶不合理的表
2. **定位负责人**：通过审计日志找最近真实调用者（按账号搜 employee 表）
3. **主动通知**：通过 KN Chat 把问题表推给负责人
4. **实时交互**：负责人通过 KN Chat 回复处置意见（保留 / 下线 / 归档 / 不在我）
5. **全程留痕**：所有通知与回答同步到记录群，回答落 MySQL 台账

首批覆盖国家：**泰国**（80 张问题表已扫描）。

---

## 目录结构

```
Data_Governance_Expert_AGENT/
├── docs/                      # 文档（方案 / 开发 / 部署）
│   ├── 01-交互方案.md
│   ├── 02-开发文档.md
│   └── 03-部署操作清单.md
├── gov-bot/                   # KN Chat 交互守护（Python）
│   ├── gov-bot.py             # 守护进程入口（长轮询 getUpdates）
│   ├── gov_profiler.py        # 表画像查询
│   ├── gov_llm.py             # Qwen 模型调用（qwen3.7-plus）
│   ├── knchat_connectivity_test.py  # 连通性测试
│   ├── requirements.txt
│   ├── README.md
│   └── data/                  # 画像数据快照（泰国）
│       ├── th-delay-list.json     # 延迟名单
│       ├── th-final-catalog.json  # 源库对照
│       └── th-owners-full.json    # 调用者
└── pi-data-governance/        # Pi 包（扫描/导出/DROP 草稿）
    ├── lib/                   # 核心逻辑
    ├── tools/                 # 工具定义
    ├── scripts/               # CLI
    ├── skills/                # 技能
    ├── config/                # 配置
    ├── package.json
    ├── README.md
    └── DEPLOY.md
```

---

## 架构

```
用户 KN Chat 发消息
  → gov-bot 守护（长轮询 getUpdates，实时收）
  → 消息分类
       ├─ 治理命令(/保留 /下线 /归档) → 直接处理
       └─ 自由问题("这表为什么延迟") → 查画像 → Qwen 回答
  → sendMessage 回复用户
  → 记录群留痕 + MySQL 台账落库
```

数据来源：
- **SR 审计日志**：谁访问过 / 零访问（识别僵尸表、定位调用者）
- **employee 表**：账号 → 姓名 / 邮箱（负责人）
- **源库 catalog**：源库 vs ods MAX（判断真延迟还是业务停更）
- **KN Chat Bot API**：`bot.kn.chat`（sendMessage / getUpdates / resolveUserId）

---

## 快速开始

### 1. 连通性测试（在目标机器上）

```bash
cd gov-bot
python3 knchat_connectivity_test.py   # 5 项检查，验证能否访问 bot.kn.chat
```

### 2. 配置环境变量

```bash
# gov-bot/.env
KN_CHAT_BOT_TOKEN=<你的专属bot_token>
RECORD_GROUP_CHAT_ID=<记录群chat_id>
QWEN_API_KEY=<你的QWEN_API_KEY>
QWEN_MODEL=qwen3.7-plus
GOV_DATA_DIR=./data
```

### 3. 启动守护进程

```bash
python3 gov-bot.py
```

私聊 bot 发 `/start` 或问「查一下 ods_app_hold_apply 什么情况」测试。

### 4. Pi 包（扫描 / 导出 / DROP 草稿）

```bash
cd pi-data-governance
export DS_API_TOKEN_CN=xxx DS_API_TOKEN_TH=xxx ...  # 各国 token
node scripts/gov-cli.mjs zombie --country th
node scripts/gov-cli.mjs query --country th
```

---

## 模型调用

参考 n8n「异常sql优化通知」工作流：Qwen3.7-plus（DashScope 国际版，OpenAI 兼容）

```python
from gov_llm import ask_qwen
answer = ask_qwen("查一下 ods_app_hold_apply 什么情况")
```

---

## 安全说明

- 所有 token / key 通过**环境变量**注入，代码内为占位符
- DROP 只生成草稿，不自动执行
- 只读查询，不写生产数据
- 守护进程**单实例**运行（同一 bot 只能一个消费者）

---

## 文档索引

| 文档 | 说明 |
|---|---|
| [01-交互方案.md](docs/01-交互方案.md) | 整体方案设计 |
| [02-开发文档.md](docs/02-开发文档.md) | 技术实现 |
| [03-部署操作清单.md](docs/03-部署操作清单.md) | 部署到 n8n 服务器步骤 |
