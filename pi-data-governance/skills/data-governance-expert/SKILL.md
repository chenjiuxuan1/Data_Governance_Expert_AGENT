---
name: data-governance-expert
description: 数据治理专家：多国(中国/印尼/墨西哥/菲律宾/巴基斯坦/泰国)数仓僵尸表(零访问表)扫描、四层(ods/dwd/dws/ads)备份表识别、僵尸表导出(CSV/Excel)、DROP SQL 草稿生成。所有操作默认只读；DROP 仅生成草稿文件，永不自动执行。
---

# 数据治理专家（data-governance-expert）

面向 StarRocks 多国数仓的数据治理能力。核心手段是**基于审计访问日志判定"零访问表"（僵尸表）**——在回看窗口（默认 30 天）内没有任何账号（含调度 `e_*`/`u_*`/root）访问过的表。

## 能力清单

| 工具 | 说明 |
|---|---|
| `gov_zombie_scan` | 触发零访问(僵尸)表扫描，可限定层 ods/dwd/dws/ads |
| `gov_bak_scan` | 备份表识别（按表名匹配 `_bak/_backup/_back/_old/_his/_copy` 等） |
| `gov_query` | 查询已落库的零访问表/备份表 |
| `gov_bucket_check` | 分桶合理性检测（HASH 分桶≤10 但每桶行数巨大，如 ≥1000万行/桶） |
| `gov_export` | 导出 CSV / Excel(每国一个 sheet) / DROP SQL 草稿 |
| `gov_drop_sql` | 生成 DROP SQL 草稿文件（不执行） |
| `gov_countries` | 列出支持的国家 |

## 国家与网关

| 代码 | 国家 | 网关 country |
|---|---|---|
| cn | 中国 | cn |
| ine | 印尼 | id |
| mx | 墨西哥 | mx |
| ph | 菲律宾 | ph |
| pk | 巴基斯坦 | pk |
| th | 泰国 | th |

别名：`id/indonesia→ine`、`china→cn`、`mexico→mx`、`pakistan→pk`、`philippines→ph`、`thailand→th`。

## 工作原理

1. **零访问扫描**：n8n 工作流「全库零访问扫描」从 `starrocks_audit_db__.starrocks_audit_tbl__` 读取回看窗口内的访问记录（`state NOT IN ('ERR','err')`、`stmt`/`user` 非空），**不排除任何账号**（调度账号也算访问）；被访问表写入 refs 表；目标表 = information_schema 表 LEFT JOIN refs IS NULL。
2. **分层**：`layers` 参数限定 `ods/dwd/dws/ads`；不传则全库（排除 information_schema/_statistics_/sys/starrocks_audit_db__/testdb/governance/mysql）。
3. **大数据量处理**：印尼等审计量大的国家，refs 用 6 段各 5 天的 INSERT 分片写入，规避查询 CPU 上限。
4. **备份表识别**：按表名正则匹配 `_bak|_backup|_back|_old|_his|_copy|_tmpbak|backup|bak_`。

## 安全边界（必须遵守）

- **永不执行 DROP**：`gov_drop_sql` 只写 `.sql` 草稿文件，供人审阅。DROP 不可逆。
- **只读查询**：`gov_query` 只查已落库结果，不写库。
- **零访问是严格定义**：窗口内任何账号（含 `e_*` 调度）访问过即视为"已访问"，不算僵尸。
- **备份表先复核**：超大备份表（如巴基斯坦 `dwd_w_feature_action_ask_loan_bak` 365GB）建议先确认无恢复/回滚需求再删。

## 典型流程

```
1. gov_zombie_scan {country: pk, layers: [ods,dwd,dws,ads]}   # 触发扫描（后端异步，数据落库）
2. gov_query {country: pk}                                    # 读零访问表（若 webhook 返回空，改用 CLI export 或 n8n 执行记录）
3. gov_export {format: xlsx, rows}                            # 生成每国一个 sheet 的 Excel
4. gov_drop_sql {rows, country: pk}                           # 生成 DROP 草稿供审查
```

## 分桶合理性检查

检测 HASH 分桶数过少（≤10）但行数巨大（每桶行数 ≥ 默认 1000万）的表，这类表查询/导入性能差，建议调大 `DISTRIBUTE_BUCKET`。

```
1. gov_bucket_check {country: pk}                             # 检测分桶不合理表（同步返回，无需等落库）
2. gov_export {format: xlsx/csv, rows}                        # 导出分桶清单（行已标准化为 table_schema/table_name）
3. 对 ROWS_PER_BUCKET 最大的表建议调大分桶数（如 48~96，使每桶 ≤1000万行）
```

- `max_bucket`（默认10）：分桶数上限；`min_rows_per_bucket`（默认1000万）：每桶行数阈值；`limit`（默认50）。
- 分桶检查是**同步**查询（走 n8n 通用查询 webhook `gov-generic-query`），无需触发扫描落库。
- 该能力依赖 n8n 工作流「临时通用SQL查询-勿删」(OMyOypZaqWT4KQjD，webhook `gov-generic-query`)，部署时需一并创建。

## 已知限制

- n8n webhook「返回结果」节点有已知序列化问题：**HTTP 200 但响应体为空**。数据已落库，需用 `gov_query` 或 n8n 执行记录（「查询零访问表统计」节点的 `data.rows`）读取结果。
- 触发完整扫描后需等待 n8n 执行完成（印尼约 2-4 分钟，因 6 段 refs 分片）。
- webhook 触发后到生成新执行有 15-20 秒缓存延迟。
