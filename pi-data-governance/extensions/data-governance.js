/**
 * 数据治理专家 — Pi 扩展
 * 注册 gov_* 自定义工具，供 Pi agent 调用（通过火山方舟/DeepSeek 模型驱动）。
 *
 * 工具核心逻辑复用 tools/gov-tools.mjs；本文件仅做 Pi 适配（registerTool）。
 */
import { govZombieScan, govBakScan, govQuery, govExport, govDropSql, govCountries, govBucketCheck } from "../tools/gov-tools.mjs";
import { resolveCountry } from "../lib/config.mjs";
import { loadConfig } from "../lib/config.mjs";

const COUNTRY_ENUM = ["cn", "ine", "mx", "ph", "pk", "th"];
const LAYER_ENUM = ["ods", "dwd", "dws", "ads"];

function textResponse(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function rowsToText(rows) {
  if (!rows || !rows.length) return "（无结果）";
  const lines = rows.map((r) => `- ${r.table_schema}.${r.table_name}  ${r.size_gb}GB  rows=${r.table_rows}  ${String(r.create_time || "").slice(0, 10)}`);
  return `共 ${rows.length} 张表：\n${lines.join("\n")}`;
}

export default function dataGovernanceExtension(pi) {
  // 国家 → 网关 country（供内部校验）
  function gatewayCountry(code) {
    const cfg = loadConfig();
    return cfg.countries?.[code]?.gatewayCountry || code;
  }

  pi.registerTool({
    name: "gov_zombie_scan",
    label: "零访问(僵尸)表扫描",
    description: "触发全库或分层(ods/dwd/dws/ads)零访问表扫描（后端 n8n 异步执行，数据落库后可用 gov_query 读取）。多国可用。",
    promptSnippet: "触发多国数仓零访问(僵尸)表扫描，可限定层",
    promptGuidelines: [
      "Use gov_zombie_scan when the user wants to find zombie (zero-access) tables; it triggers an async backend scan.",
      "After gov_zombie_scan, tell the user to run gov_query to read the landed results (scan is asynchronous).",
    ],
    parameters: {
      type: "object",
      properties: {
        country: { type: "string", enum: COUNTRY_ENUM, description: "国家 cn/ine/mx/ph/pk/th" },
        layers: { type: "array", items: { type: "string", enum: LAYER_ENUM }, description: "限定层，不传则全库" },
        lookback_days: { type: "number", description: "回看窗口天数，默认30" },
      },
      required: ["country"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResponse("已取消");
      onUpdate?.({ content: [{ type: "text", text: "正在触发扫描（后端 n8n 异步执行）…" }], details: {} });
      const r = await govZombieScan({ ...params, layers: params.layers || undefined });
      return textResponse(`扫描已受理：${r.country} / 层=${(params.layers || []).join(",") || "全库"}。\n${r.note}`, r);
    },
  });

  pi.registerTool({
    name: "gov_bak_scan",
    label: "备份表识别扫描",
    description: "备份表识别（表名匹配 _bak/_backup/_back/_old/_his/_copy 等），可限定层。触发后端扫描，结果落库后用 gov_query 读取。",
    promptSnippet: "识别多国数仓备份表（_bak/_backup/_old 等）",
    promptGuidelines: [
      "Use gov_bak_scan when the user wants to find backup tables by name pattern.",
    ],
    parameters: {
      type: "object",
      properties: {
        country: { type: "string", enum: COUNTRY_ENUM, description: "国家" },
        layers: { type: "array", items: { type: "string", enum: LAYER_ENUM } },
        lookback_days: { type: "number" },
      },
      required: ["country"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResponse("已取消");
      onUpdate?.({ content: [{ type: "text", text: "正在触发备份表识别…" }], details: {} });
      const r = await govBakScan({ ...params, layers: params.layers || undefined });
      return textResponse(`备份表识别已受理：${r.country}。\n${r.note}`, r);
    },
  });

  pi.registerTool({
    name: "gov_query",
    label: "查询零访问/备份表结果",
    description: "查询已落库的零访问表或备份表（只读）。自动从 n8n 执行记录读取。支持按层/容量过滤。",
    promptSnippet: "查询已落库的零访问表或备份表结果",
    promptGuidelines: [
      "Use gov_query to read zero-access or backup table results after a scan has run.",
    ],
    parameters: {
      type: "object",
      properties: {
        country: { type: "string", enum: COUNTRY_ENUM, description: "国家" },
        layers: { type: "array", items: { type: "string", enum: LAYER_ENUM } },
        bak: { type: "boolean", description: "是否查询备份表结果" },
        min_gb: { type: "number", description: "只返回容量大于该值的表" },
      },
      required: ["country"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResponse("已取消");
      onUpdate?.({ content: [{ type: "text", text: "正在查询…" }], details: {} });
      const r = await govQuery({ ...params, layers: params.layers || undefined });
      return textResponse(`查询结果：${rowsToText(r.rows)}`, { rowCount: r.rowCount, rows: r.rows });
    },
  });

  pi.registerTool({
    name: "gov_export",
    label: "导出 CSV/Excel/DROP SQL",
    description: "把查询到的表导出为 CSV / Excel(每国一个sheet) / DROP SQL 草稿文件。rows 为 [{table_schema,table_name,table_rows,size_gb,create_time}]。",
    promptSnippet: "导出表清单为 CSV/Excel/DROP SQL 文件",
    promptGuidelines: [
      "Use gov_export to write table lists to CSV, Excel, or DROP SQL draft files.",
      "gov_export never executes DROP; it only writes .sql draft files for review.",
    ],
    parameters: {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object" }, description: "要导出的表行" },
        format: { type: "string", enum: ["csv", "sql", "xlsx"], description: "导出格式" },
        country: { type: "string", enum: COUNTRY_ENUM },
        name: { type: "string", description: "文件名（可中文）" },
      },
      required: ["rows", "format"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResponse("已取消");
      const r = await govExport(params);
      return textResponse(`已导出 ${r.rowCount} 行 → ${r.file}`, r);
    },
  });

  pi.registerTool({
    name: "gov_drop_sql",
    label: "生成 DROP SQL 草稿",
    description: "为表清单生成 DROP TABLE 草稿文件（仅写文件，永不执行）。rows 为 [{table_schema,table_name,...}]。",
    promptSnippet: "生成 DROP SQL 草稿（不执行）",
    promptGuidelines: [
      "Use gov_drop_sql to draft DROP TABLE SQL for review; it NEVER executes the drops.",
      "Before drafting drops for large tables, remind the user drops are irreversible.",
    ],
    parameters: {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object" } },
        country: { type: "string", enum: COUNTRY_ENUM },
        comment: { type: "string" },
      },
      required: ["rows"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResponse("已取消");
      const r = await govDropSql(params);
      return textResponse(`DROP 草稿已生成（未执行）→ ${r.file}`, r);
    },
  });

  pi.registerTool({
    name: "gov_countries",
    label: "列出支持的国家",
    description: "列出数据治理支持的国家及其网关映射。",
    promptSnippet: "列出数据治理支持的国家",
    parameters: { type: "object", properties: {} },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const list = await govCountries({});
      return textResponse(list.map((c) => `- ${c.code} ${c.name} (gateway=${c.gatewayCountry})`).join("\n"), { countries: list });
    },
  });

  pi.registerTool({
    name: "gov_bucket_check",
    label: "分桶合理性检测（两维度：分桶+分区）",
    description: "检测 HASH 分桶数过少（<=10）但行数巨大（每桶行数>=阈值，默认1000万）的表。两维度判断：逐张统计分区数，计算每分区每桶行数与严重级别（HIGH=每分区每桶≥1000万，优先调；MED=100万~1000万；LOW=<100万已稀释）。结果<=15张时自动增强，更多可用 enhance_partitions=true。",
    promptSnippet: "检测分桶不合理的表（两维度：分桶数过少+分区是否稀释）",
    promptGuidelines: [
      "Use gov_bucket_check when the user wants to find tables with unreasonable bucket distribution (too few buckets for large row counts).",
      "The result includes SEVERITY: HIGH tables (>=10M rows per partition-bucket) are the real targets; LOW tables are already diluted by partitioning and need no action.",
      "Example: a table with 4B rows per bucket but 949 partitions is only ~4.4M rows per partition-bucket (MED), much less urgent than an unpartitioned table with 500M rows per bucket (HIGH).",
      "After gov_bucket_check, prioritize HIGH tables (largest ROWS_PER_PART_BUCKET) for DISTRIBUTE_BUCKET adjustment.",
    ],
    parameters: {
      type: "object",
      properties: {
        country: { type: "string", enum: COUNTRY_ENUM, description: "国家" },
        max_bucket: { type: "number", description: "分桶数上限，默认10" },
        min_rows_per_bucket: { type: "number", description: "每桶最小行数阈值，默认1000万" },
        limit: { type: "number", description: "返回行数上限，默认50" },
        enhance_partitions: { type: "boolean", description: "true 强制逐张数分区做两维度判断（结果多时较慢）；默认结果<=15张自动启用" },
      },
      required: ["country"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResponse("已取消");
      onUpdate?.({ content: [{ type: "text", text: "正在检测分桶合理性（两维度：分桶+分区）…" }], details: {} });
      const r = await govBucketCheck(params);
      if (!r.rows || !r.rows.length) return textResponse(`未发现分桶不合理的表（${r.country}）。`, r);
      const lines = r.rows.map((x) => {
        const part = x.PARTITION_COUNT != null
          ? `分区=${x.PARTITION_COUNT} 每分区每桶=${Number(x.ROWS_PER_PART_BUCKET).toLocaleString()} [${x.SEVERITY}]`
          : `分区键=${x.PARTITION_KEY ? String(x.PARTITION_KEY).replace(/`/g, "") : "无"}`;
        return `- ${x.TABLE_SCHEMA}.${x.TABLE_NAME}  ${part}  bucket=${x.DISTRIBUTE_BUCKET}  rows=${Number(x.TABLE_ROWS).toLocaleString()}  ${x.DATA_SIZE_GB}GB  每桶=${Number(x.ROWS_PER_BUCKET).toLocaleString()}`;
      });
      const high = r.rows.filter((x) => x.SEVERITY === "HIGH").length;
      const med = r.rows.filter((x) => x.SEVERITY === "MED").length;
      const low = r.rows.filter((x) => x.SEVERITY === "LOW").length;
      return textResponse(
        `发现 ${r.rowCount} 张分桶不合理的表（${r.country}）：\n${lines.join("\n")}\n\n` +
        `严重级别：HIGH=${high}（每分区每桶≥1000万，最优先调） MED=${med} LOW=${low}（已被分区稀释）。\n` +
        `可用 gov_export 导出清单。`,
        { rowCount: r.rowCount, high, med, low, rows: r.rows },
      );
    },
  });
}
