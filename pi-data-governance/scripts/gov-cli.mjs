#!/usr/bin/env node
/**
 * gov-cli — 数据治理专家命令行入口。
 * 用法示例：
 *   node scripts/gov-cli.mjs zombie --country pk --layers ods,dwd,dws,ads
 *   node scripts/gov-cli.mjs bak --country pk
 *   node scripts/gov-cli.mjs query --country pk --bak
 *   node scripts/gov-cli.mjs export --format xlsx --name 四层备份表 --rows-json '[...]'
 *   node scripts/gov-cli.mjs countries
 */

import { govZombieScan, govBakScan, govQuery, govExport, govDropSql, govCountries, govBucketCheck } from "../tools/gov-tools.mjs";

const HELP = `
数据治理专家 CLI
用法: gov-cli <command> [options]

命令:
  zombie   触发零访问(僵尸)表扫描
  bak      备份表识别扫描
  query    查询已落库结果
  export   导出 CSV/Excel/DROP SQL
  drop     生成 DROP SQL 草稿
  bucket   分桶合理性检测（HASH 分桶过少但行数巨大）
  countries 列出支持的国家

选项:
  --country <code>      国家 cn/ine/mx/ph/pk/th
  --layers a,b,c        限定层 ods,dwd,dws,ads
  --lookback <days>     回看天数(默认30)
  --min-gb <n>          最小容量过滤
  --bak                 备份表模式
  --offset <n>          查询分页偏移
  --schema <name>       查询按 schema 过滤
  --format <csv|sql|xlsx> 导出格式(默认 csv)
  --name <name>         导出文件名
  --dir <path>          导出目录
  --rows-json <json>    直接提供数据行(JSON数组)用于导出
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (args.layers && typeof args.layers === "string") {
    args.layers = args.layers.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (args.minGb) args.min_gb = Number(args.minGb);
  if (args.lookback) args.lookback_days = Number(args.lookback);
  if (args.rowsJson) {
    try { args.rows = JSON.parse(args.rowsJson); } catch { throw new Error("--rows-json 不是合法 JSON 数组"); }
  }
  if (args.bak === true || args.bak === "true") args.bak = true;

  switch (command) {
    case "zombie":
      console.log(JSON.stringify(await govZombieScan(args), null, 2));
      break;
    case "bak":
      console.log(JSON.stringify(await govBakScan(args), null, 2));
      break;
    case "query":
      console.log(JSON.stringify(await govQuery(args), null, 2));
      break;
    case "export":
      console.log(JSON.stringify(await govExport(args), null, 2));
      break;
    case "drop":
      console.log(JSON.stringify(await govDropSql(args), null, 2));
      break;
    case "bucket":
      console.log(JSON.stringify(await govBucketCheck(args), null, 2));
      break;
    case "countries":
      console.log(JSON.stringify(await govCountries(args), null, 2));
      break;
    default:
      console.error(`未知命令: ${command}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[gov-cli] 错误: ${error.message}`);
  process.exitCode = 1;
});
