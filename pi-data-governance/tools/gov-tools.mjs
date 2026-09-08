import { loadConfig, resolveCountry, knownCountries } from "../lib/config.mjs";
import { triggerZombieScan, queryZeroAccess, runSrQuery } from "../lib/gateway.mjs";
import { exportCsv, exportDropSql, exportXlsx } from "../lib/exporters.mjs";
import path from "node:path";
import fs from "node:fs";

/**
 * 数据治理工具集合（供 Pi 自定义工具 / CLI / ZNZB 后端复用）。
 * 所有工具默认只读；DROP SQL 仅生成草稿文件，永不执行。
 */

function withConfig(opts = {}, env = process.env) {
  const cfg = loadConfig({ env });
  return cfg;
}

function outputDir(cfg, env) {
  return path.resolve(cfg.output.dir || "./output");
}

/** 工具1：gov_zombie_scan —— 触发全库/分层零访问（僵尸）表扫描 */
export async function govZombieScan(args, { env = process.env } = {}) {
  const cfg = loadConfig({ env });
  const country = resolveCountry(args.country, cfg, { env });
  const layers = Array.isArray(args.layers) && args.layers.length
    ? args.layers
    : (typeof args.layers === "string" && args.layers.trim() ? args.layers.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const result = await triggerZombieScan({
    country: country.code,
    lookbackDays: args.lookback_days ?? args.lookbackDays,
    layers,
    bak: args.bak,
    min_gb: args.min_gb,
  }, { cfg, env });
  return {
    ...result,
    country: country.code,
    gatewayCountry: country.gatewayCountry,
    layers: layers || null,
    instruction: "扫描已在后端执行。用 gov_query 读取结果；或跑 gov_export 生成 CSV/Excel。",
  };
}

/** 工具2：gov_bak_scan —— 备份表识别（bak 模式扫描） */
export async function govBakScan(args, { env = process.env } = {}) {
  return govZombieScan({ ...args, bak: true }, { env });
}

/** 工具3：gov_query —— 查询已落库的零访问表/备份表 */
export async function govQuery(args, { env = process.env } = {}) {
  const cfg = loadConfig({ env });
  const country = resolveCountry(args.country, cfg, { env });
  const layers = Array.isArray(args.layers) && args.layers.length
    ? args.layers
    : (typeof args.layers === "string" && args.layers.trim() ? args.layers.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const result = await queryZeroAccess({
    country: country.code,
    offset: args.offset,
    schema: args.schema,
    min_gb: args.min_gb,
    bak: args.bak,
    layers,
  }, { cfg, env });
  return {
    success: result.success,
    country: country.code,
    rows: result.rows,
    rowCount: result.rows.length,
    instruction: result.rows.length === 0
      ? "未取到行。webhook 返回体可能为空（已知问题），建议改用 CLI 的 export 从执行记录读取，或在 n8n 执行记录里查「查询零访问表统计」。"
      : "可直接展示 rows，或交给 gov_export 生成文件。",
  };
}

/** 工具4：gov_export —— 导出 CSV / Excel / DROP SQL 草稿 */
export async function govExport(args, { env = process.env } = {}) {
  const cfg = loadConfig({ env });
  const dir = path.resolve(args.dir || outputDir(cfg, env));
  const format = String(args.format || cfg.output.defaultFormat || "csv").toLowerCase();
  const country = args.country ? resolveCountry(args.country, cfg, { env }) : null;
  const name = String(args.name || "data-governance").replace(/[\\/:*?"<>|\s]+/g, "_").trim() || "data-governance";
  const suffix = country ? `_${country.code}` : "";
  const stamp = args.batch || cfg.batch || "current";
  const rows = Array.isArray(args.rows) ? args.rows : (args.data || []);

  if (format === "csv" || format === "sql") {
    const file = path.join(dir, `${name}${suffix}_${stamp}.${format === "sql" ? "sql" : "csv"}`);
    if (format === "sql") {
      exportDropSql(rows, file, { countryName: country?.name, comment: args.comment });
    } else {
      exportCsv(rows, file, { countryName: country?.name });
    }
    return { success: true, format, file, rowCount: rows.length };
  }

  if (format === "xlsx") {
    const file = path.join(dir, `${name}_${stamp}.xlsx`);
    // groupedRows: { countryCode: [rows] } 或单国 { code: rows }
    const grouped = country
      ? { [country.name || country.code]: rows }
      : (args.groupedRows && Object.keys(args.groupedRows).length ? args.groupedRows : { 汇总: rows });
    exportXlsx(grouped, file);
    return { success: true, format: "xlsx", file, groups: Object.keys(grouped).length };
  }

  const err = new Error(`不支持的导出格式: ${format}（可用 csv/sql/xlsx）`);
  err.statusCode = 400;
  throw err;
}

/** 工具5：gov_drop_sql —— 生成 DROP SQL 草稿（仅文件，不执行） */
export async function govDropSql(args, { env = process.env } = {}) {
  const cfg = loadConfig({ env });
  const rows = Array.isArray(args.rows) ? args.rows : [];
  const dir = path.resolve(args.dir || outputDir(cfg, env));
  const country = args.country ? resolveCountry(args.country, cfg, { env }) : null;
  const stamp = args.batch || cfg.batch || "current";
  const dropName = String(args.name || "tables").replace(/[\\/:*?"<>|\s]+/g, "_").trim() || "tables";
  const file = path.join(dir, `drop_${dropName}_${country?.code || "all"}_${stamp}.sql`);
  exportDropSql(rows, file, {
    countryName: country?.name,
    comment: args.comment || "零访问/备份表 DROP 草稿，请逐张确认后再执行",
  });
  return { success: true, file, rowCount: rows.length, executed: false, note: "仅生成草稿，未执行任何 DROP" };
}

/** 辅助：列出支持的国家 */
export function govCountries(_args, { env = process.env } = {}) {
  const cfg = loadConfig({ env });
  return knownCountries().map((code) => ({
    code,
    name: cfg.countries[code].name,
    gatewayCountry: cfg.countries[code].gatewayCountry,
  }));
}

/**
 * 分桶合理性检测 SQL（两维度：分桶 + 分区）。
 * 找出 HASH 分桶数 <= maxBucket 但行数巨大的表（每桶行数过大 = 分桶不合理）。
 * 默认输出 PARTITION_KEY 列（判断是否有分区）；可用 showPartition=false 关掉该列（退回纯分桶维度）。
 * 参数：maxBucket（默认10）、minRowsPerBucket（默认1000万）、maxRows（默认50）、排除 schema。
 * schemaWhitelist：限定只扫这些 schema（用于泰国等 tables_config 全表扫描超时的环境，IN 条件可避免全表扫描）。
 * onlyNoPartition：true 时只返回无分区表（PARTITION_KEY 为空），用于聚焦最紧急的调整对象。
 */
export function buildBucketCheckSql({ maxBucket = 10, minRowsPerBucket = 10_000_000, maxRows = 50, excludedSchemas = [], schemaWhitelist = [], showPartition = true, onlyNoPartition = false } = {}) {
  const exc = ["information_schema", "_statistics_", ...excludedSchemas]
    .map((s) => `'${String(s).replace(/'/g, "''")}'`).join(", ");
  const whitelistClause = Array.isArray(schemaWhitelist) && schemaWhitelist.length
    ? ` AND c.TABLE_SCHEMA IN (${schemaWhitelist.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(", ")})`
    : "";
  const partitionSelect = showPartition ? "    c.PARTITION_KEY,\n" : "";
  const noPartitionClause = showPartition && onlyNoPartition ? " AND (c.PARTITION_KEY IS NULL OR c.PARTITION_KEY = '')" : "";
  return `SELECT
    c.TABLE_SCHEMA,
    c.TABLE_NAME,
    c.TABLE_MODEL,
${partitionSelect}    c.DISTRIBUTE_KEY,
    c.DISTRIBUTE_BUCKET,
    t.TABLE_ROWS,
    ROUND(t.DATA_LENGTH / 1024 / 1024 / 1024, 2) AS DATA_SIZE_GB,
    CASE
        WHEN c.DISTRIBUTE_BUCKET > 0
        THEN ROUND(t.TABLE_ROWS / c.DISTRIBUTE_BUCKET, 0)
        ELSE NULL
    END AS ROWS_PER_BUCKET
  FROM information_schema.tables_config c
  JOIN information_schema.tables t
    ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
   AND c.TABLE_NAME   = t.TABLE_NAME
  WHERE c.DISTRIBUTE_TYPE = 'HASH'
    AND c.DISTRIBUTE_BUCKET > 0
    AND c.DISTRIBUTE_BUCKET <= ${Math.max(1, Number(maxBucket) || 10)}
    AND c.TABLE_SCHEMA NOT IN (${exc})${whitelistClause}${noPartitionClause}
  HAVING (CASE
        WHEN c.DISTRIBUTE_BUCKET > 0
        THEN ROUND(t.TABLE_ROWS / c.DISTRIBUTE_BUCKET, 0)
        ELSE NULL
    END) >= ${Math.max(1, Number(minRowsPerBucket) || 10_000_000)}
  ORDER BY ROWS_PER_BUCKET DESC
  LIMIT ${Math.max(1, Math.min(500, Number(maxRows) || 50))}`;
}

/** 泰国常用业务 schema 白名单（泰国 tables_config 全表扫描超时，需限定 schema） */
export const THAILAND_BUCKET_SCHEMAS = [
  "ods", "dwd", "dws", "ads", "fox_ods", "fox_dw", "fox_tmp", "fox_bi",
  "dm_aifox", "dm_model", "dm_tmp", "dm_irsd", "dm_wd_decision", "fin", "extdb",
  "dm_analyst", "dm_tmk", "dm_dd", "fin_global", "dm_dd_new", "biz_acctrix",
  "dev", "dwb", "rpt", "dm_strategy", "dim", "dm_fox", "biz_helios_tha",
];

/**
 * 工具6：gov_bucket_check —— 分桶合理性检测（两维度：分桶 + 分区）
 * 检测 HASH 分桶数过少（<=10）但行数巨大（每桶行数 >= min_rows_per_bucket）的表。
 * 两维度增强：对结果逐张 SHOW PARTITIONS 数分区数，计算"每分区每桶行数"与严重级别——
 *   HIGH = 每分区每桶 >= 1000万（无有效分区稀释，最优先调）
 *   MED  = 100万 ~ 1000万（有分区但每分区每桶仍大）
 *   LOW  = < 100万（分区已充分稀释，无需调整）
 * 分区统计逐表执行较慢：结果 <=15 张时自动启用；更多时可显式 enhance_partitions=true。
 */
export async function govBucketCheck(args, { env = process.env } = {}) {
  const cfg = loadConfig({ env });
  const country = resolveCountry(args.country, cfg, { env });
  // 泰国：tables_config 全表扫描在网关侧超时，默认限定业务 schema（可用 args.schema_whitelist 覆盖/关闭）
  const isThailand = country.code === "th";
  const schemaWhitelist = args.schema_whitelist !== undefined
    ? (Array.isArray(args.schema_whitelist) ? args.schema_whitelist : [])
    : (isThailand ? THAILAND_BUCKET_SCHEMAS : []);
  const sql = buildBucketCheckSql({
    maxBucket: args.max_bucket,
    minRowsPerBucket: args.min_rows_per_bucket,
    maxRows: args.limit || args.max_rows,
    excludedSchemas: args.excluded_schemas || [],
    schemaWhitelist,
    onlyNoPartition: args.only_no_partition,
  });
  const result = await runSrQuery({
    country: country.code,
    sql,
    limit: args.limit || args.max_rows,
  }, { cfg, env });
  const baseRows = result.rows || [];

  // 两维度增强：逐张数分区，算每分区每桶行数与严重级别
  const wantEnhance = args.enhance_partitions === true || (args.enhance_partitions !== false && baseRows.length > 0 && baseRows.length <= 15);
  let rows = baseRows;
  let partitionNote = "未做分区数统计（结果较多，可用 enhance_partitions=true 逐张统计分区数做两维度判断）";
  if (wantEnhance && baseRows.length) {
    const enriched = [];
    for (const r of baseRows) {
      const schema = String(r.TABLE_SCHEMA || "").replace(/`/g, "");
      const table = String(r.TABLE_NAME || "").replace(/`/g, "");
      const rpb = Number(r.ROWS_PER_BUCKET || 0);
      const parts = await countTablePartitions(country.gatewayCountry, schema, table, { cfg, env });
      const per = parts > 1 ? Math.max(1, Math.round(rpb / parts)) : rpb;
      const severity = per >= 10_000_000 ? "HIGH" : per >= 1_000_000 ? "MED" : "LOW";
      enriched.push({ ...r, PARTITION_COUNT: parts, ROWS_PER_PART_BUCKET: per, SEVERITY: severity });
    }
    rows = enriched;
    partitionNote = "已逐张统计分区数：SEVERITY=HIGH(每分区每桶≥1000万，优先调) / MED(100万~1000万) / LOW(<100万，已稀释)";
  }

  return {
    success: result.success,
    country: country.code,
    gatewayCountry: country.gatewayCountry,
    rows,
    rowCount: rows.length,
    source: result.source,
    sql,
    schemaWhitelist: schemaWhitelist.length ? schemaWhitelist : undefined,
    onlyNoPartition: !!args.only_no_partition,
    enhancedPartitions: wantEnhance,
    note: [
      schemaWhitelist.length
        ? `已限定 ${schemaWhitelist.length} 个业务 schema 检测（${country.name} 的 tables_config 全表扫描超时）`
        : null,
      partitionNote,
    ].filter(Boolean).join("；"),
    instruction: rows.length === 0
      ? "未发现分桶不合理的表（HASH 分桶≤10 且每桶行数>=阈值）。"
      : `发现 ${rows.length} 张分桶不合理的表（两维度：分桶+分区）。可用 gov_export 导出，或生成调整建议。`,
  };
}

/**
 * 数一张表的分区数（SHOW PARTITIONS 翻页直到拿完，上限 2000）。
 * @returns {Promise<number>}
 */
async function countTablePartitions(gatewayCountry, schema, table, { cfg, env } = {}) {
  const { runSrQuery } = await import("../lib/gateway.mjs");
  let total = 0;
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await runSrQuery({
        country: gatewayCountry,
        sql: `SHOW PARTITIONS FROM \`${String(schema).replace(/`/g, "")}\`.\`${String(table).replace(/`/g, "")}\` LIMIT 100 OFFSET ${offset}`,
        limit: 100,
      }, { cfg, env });
      const rows = r.rows || [];
      if (!rows.length) break;
      total += rows.length;
      offset += 100;
      if (rows.length < 100) break;
    } catch {
      break;
    }
  }
  return total;
}
