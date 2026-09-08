# Pi Data Governance（数据治理专家）

多国 StarRocks 数仓**僵尸表（零访问表）扫描**、**四层（ods/dwd/dws/ads）备份表识别**、**导出 CSV/Excel**、**DROP SQL 草稿**的独立 Pi Package。

支持国家：中国(cn) / 印尼(ine) / 墨西哥(mx) / 菲律宾(ph) / 巴基斯坦(pk) / 泰国(th)。

## 能力

| 工具 | 说明 | 只读 |
|---|---|---|
| `gov_zombie_scan` | 触发零访问(僵尸)表扫描（可限定层） | 写后端结果表 |
| `gov_bak_scan` | 备份表识别扫描（表名匹配 `_bak/_backup/_back/_old/_his/_copy`） | 写后端结果表 |
| `gov_query` | 查询已落库的零访问表/备份表（含 n8n 执行记录 fallback） | ✅ |
| `gov_bucket_check` | 分桶合理性检测（HASH 分桶≤10 但每桶行数巨大） | ✅ |
| `gov_export` | 导出 CSV / Excel(每国一个 sheet) / DROP SQL | ✅ |
| `gov_drop_sql` | 生成 DROP SQL 草稿文件 | ✅（仅写文件，永不执行） |
| `gov_countries` | 列出支持的国家 | ✅ |

## 目录结构

```
pi-data-governance/
├── package.json            # Pi Package 定义 + CLI bin
├── config/
│   └── data-governance.config.json   # 多国配置、网关、排除规则、输出
├── lib/
│   ├── config.mjs          # 配置加载 + 国家归一化
│   ├── gateway.mjs         # n8n 网关调用 + 执行记录读取
│   ├── exporters.mjs       # CSV / Excel / DROP SQL 导出
│   └── index.mjs           # 统一入口
├── tools/
│   ├── gov-tools.mjs       # 工具实现（Pi 自定义工具 / CLI / ZNZB 复用）
│   └── definitions.mjs     # Pi 工具 schema 元数据
├── skills/
│   └── data-governance-expert/SKILL.md  # 数据治理专家技能说明
└── scripts/
    └── gov-cli.mjs         # 命令行入口（node scripts/gov-cli.mjs ...）
```

## 环境变量

| 变量 | 说明 | 必填 |
|---|---|---|
| `DS_API_TOKEN_<CN/INE/MX/PH/PK/TH>` | 各国 DS 网关 token | 扫描/查询需要 |
| `N8N_URL` | n8n API 地址（用于读执行记录） | 查询结果推荐 |
| `N8N_API_KEY` | n8n API key | 查询结果推荐 |
| `FUXI_SR_GATEWAY_URL` | SR 网关地址 | 默认即可 |
| `GOV_OUTPUT_DIR` | 导出目录（默认 `./output`） | 否 |
| `GOV_CONFIG_PATH` | 配置文件路径 | 否 |
| `GOV_PI_PACKAGE_PATH` | Pi 包路径覆盖（ZNZB 接入用） | 否 |

## CLI 用法

```bash
# 列出国家
node scripts/gov-cli.mjs countries

# 触发巴基斯坦零访问扫描（四层）
node scripts/gov-cli.mjs zombie --country pk --layers ods,dwd,dws,ads

# 备份表识别
node scripts/gov-cli.mjs bak --country pk --layers ods,dwd,dws,ads

# 查询已落库结果（自动从 n8n 执行记录读取）
node scripts/gov-cli.mjs query --country pk

# 导出 Excel / CSV
node scripts/gov-cli.mjs export --format xlsx --name 四层备份表 --rows-json '[...]'
node scripts/gov-cli.mjs export --format csv --name 零访问表 --rows-json '[...]'

# 生成 DROP 草稿（不执行）
node scripts/gov-cli.mjs drop --country pk --name 零访问表 --rows-json '[...]'

# 分桶合理性检测（HASH 分桶≤10 且每桶行数≥1000万）
node scripts/gov-cli.mjs bucket --country pk
# 调阈值：--max-bucket 16 --min-rows-per-bucket 5000000 --limit 100
```

## 作为 Pi Package 安装

Pi（终端编码 Agent 外壳）支持从 git/npm 安装包：

```bash
pi install git:/path/to/pi-data-governance
# 或
pi install npm:@your-scope/pi-data-governance   # 发布后
```

安装后 Pi 会自动注册 `tools/definitions.mjs` 中的自定义工具与 `skills/data-governance-expert` 技能，agent 即可调用 `gov_*` 工具执行数据治理。

## 安全约定

- **永不执行 DROP**：`gov_drop_sql` 只生成 `.sql` 草稿文件供人审阅。
- **零访问 = 严格定义**：窗口内任何账号（含 `e_*`/`u_*` 调度）访问过即不算僵尸。
- **超大备份表先复核**：如巴基斯坦 `dwd_w_feature_action_ask_loan_bak`(365GB) 建议确认无恢复需求再删。

## 已知限制

- n8n webhook「返回结果」节点有序列化问题：HTTP 200 但响应体空。本包已通过「从 n8n 执行记录读取」绕过，需配置 `N8N_URL`/`N8N_API_KEY`。
- 完整扫描为异步（后端 n8n 执行），印尼/巴基斯坦约 2-4 分钟。
