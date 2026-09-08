# 部署指南：Pi 数据治理 → 本地 + ZNZB

本指南说明如何把 `pi-data-governance` 包在本地和 ZNZB 服务器上部署运行，并接入 ZNZB 前端页面。

## 一、本地使用（已跑通）

```bash
cd pi-data-governance

# 1. 准备环境变量（可从 ZNZB .env 或自行配置）
export DS_API_TOKEN_CN=xxx DS_API_TOKEN_INE=xxx ... # 各国 token
export N8N_URL=https://sql-cn.kuainiujinke.com
export N8N_API_KEY=xxx

# 2. 扫描 + 查询
node scripts/gov-cli.mjs zombie --country pk --layers ods,dwd,dws,ads
node scripts/gov-cli.mjs query --country pk

# 3. 导出（结果先存到变量再导出）
node scripts/gov-cli.mjs export --format xlsx --name 四层备份表 --rows-json '[...]'
```

本地核心链路已验证：query(23 行 pk) → export(csv/xlsx) → drop 均成功。

## 二、接入 ZNZB（已完成代码，需部署）

ZNZB 项目已新增：

| 文件 | 作用 |
|---|---|
| `src/data-governance.mjs` | 数据治理后端代理（复用 Pi 包工具） |
| `src/server.mjs`（修改） | 新增 `/api/data-governance/*` 端点 |
| `web/src/views/data-governance.js` | 数据治理前端页面 |
| `web/src/app.js`（修改） | 注册 `/data-governance` 路由（导航「数据治理」） |

### 部署步骤（在 ZNZB 服务器上）

```bash
cd /path/to/ZNZB

# 1. 确保 Pi 包可被找到（默认路径是源码同级；或显式指定）
#    源码默认查找: ../deepseek harness/pi-data-governance
#    推荐在 .env 里设置显式路径（避免依赖相对位置）:
echo 'GOV_PI_PACKAGE_PATH=/opt/pi-data-governance' >> .env

# 2. 把 Pi 包放到服务器
scp -r pi-data-governance user@znzb-server:/opt/

# 3. 确认 .env 有 token 与 n8n 配置（ZNZB 已有 DS_API_TOKEN_*）
#    需补充 N8N_URL / N8N_API_KEY 用于查询结果

# 4. 安装依赖并启动
npm install
npm run platform   # 启动 server（默认 127.0.0.1:8787）
```

### 前端页面访问

启动后浏览器打开 `http://<server>:8787/#/data-governance`，或在侧边栏点「数据治理」。

页面功能：
- 选国家 + 扫描类型（零访问/备份表）+ 层 → 触发扫描
- 「查询结果」读取已落库表
- 「导出 Excel / CSV」生成文件
- 「生成 DROP 草稿」（仅写文件，有二次确认）

## 三、ZNZB 后端端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/data-governance/health` | GET | Pi 包健康检查 |
| `/api/data-governance/countries` | GET | 国家列表 |
| `/api/data-governance/scan` | POST | 触发扫描 `{country, type, layers, lookback_days, bak}` |
| `/api/data-governance/query` | POST | 查询结果 `{country, layers, bak}` |
| `/api/data-governance/export` | POST | 导出 `{rows, format, country, name}` |
| `/api/data-governance/drop` | POST | DROP 草稿 `{rows, country}` |

## 四、迁移到其他机器 / ZNZB

Pi 包设计为自包含：
1. 拷 `pi-data-governance/` 目录到目标机
2. 配置环境变量（token / N8N / 输出目录）
3. `node scripts/gov-cli.mjs ...` 直接可用；或 `pi install` 装入 Pi 外壳

依赖：Node.js ≥18（建议 20+）、python3 + openpyxl（仅 xlsx 导出需要）。

## 五、注意事项

- 完整扫描是**异步**的：触发后等 n8n 执行（印尼/巴基斯坦 2-4 分钟），再查询结果。
- 若服务器无法访问外网 n8n 地址，确认 ZNZB 的 n8n 网关（`DS_SCHEDULER_WEBHOOK_URL`）可达；本包走 `sql-cn.kuainiujinke.com` 或可改 `config/data-governance.config.json` 的 `gateway.n8nUrl`。
