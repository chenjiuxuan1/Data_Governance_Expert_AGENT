import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * 导出器：CSV / Excel(每国一个 sheet) / DROP SQL 草稿。
 * 数据行格式：{ table_schema, table_name, table_rows, size_gb, create_time }
 */

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeUtf8(file, content) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
}

/** CSV（UTF-8 BOM，Excel 直接打开不乱码）。若行含 distribute_bucket 字段则输出分桶列（含两维度分区信息）。 */
export function exportCsv(rows, filePath, { countryName } = {}) {
  const first = rows[0] || {};
  const keys = Object.keys(first);
  const isBucket = keys.includes("distribute_bucket");
  const isGeneric = !isBucket && !keys.includes("table_schema");
  let header;
  if (isBucket) {
    header = ["country", "table_schema", "table_name", "table_model", "partition_key", "distribute_key", "distribute_bucket", "table_rows", "size_gb", "rows_per_bucket", "partition_count", "rows_per_part_bucket", "severity"];
  } else if (isGeneric) {
    // 通用模式：中文字段名（如用户 SQL 的两维度检测结果），直接用字段名做表头
    header = keys;
  } else {
    header = ["country", "table_schema", "table_name", "table_rows", "size_gb", "create_time"];
  }
  const lines = [header.join(",")];
  for (const r of rows) {
    if (isBucket) {
      lines.push([
        csvEscape(countryName || ""),
        csvEscape(r.table_schema),
        csvEscape(r.table_name),
        csvEscape(r.table_model),
        csvEscape(r.partition_key),
        csvEscape(r.distribute_key),
        r.distribute_bucket ?? "",
        r.table_rows ?? "",
        r.size_gb ?? "",
        r.rows_per_bucket ?? "",
        r.partition_count ?? "",
        r.rows_per_part_bucket ?? "",
        csvEscape(r.severity || ""),
      ].join(","));
    } else if (isGeneric) {
      lines.push(header.map((k) => csvEscape(r[k])).join(","));
    } else {
      lines.push([
        csvEscape(countryName || ""),
        csvEscape(r.table_schema),
        csvEscape(r.table_name),
        r.table_rows ?? "",
        r.size_gb ?? "",
        csvEscape(String(r.create_time ?? "").slice(0, 10)),
      ].join(","));
    }
  }
  writeUtf8(filePath, "\uFEFF" + lines.join("\n"));
  return filePath;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** DROP SQL 草稿（只读审查，永不自动执行） */
export function exportDropSql(rows, filePath, { countryName, comment } = {}) {
  const lines = [
    `-- ${countryName || ""} 数据治理 DROP SQL 草稿`,
    `-- ${comment || "零访问/备份表，请逐张确认后再执行"}`,
    "-- ⚠️ DROP 不可逆，仅供审查，请勿在生产直接执行",
    "",
  ];
  for (const r of rows) {
    const schema = String(r.table_schema).replace(/`/g, "``");
    const name = String(r.table_name).replace(/`/g, "``");
    const size = r.size_gb != null ? `${Number(r.size_gb).toFixed(3)}GB` : "";
    const rowcount = r.table_rows != null ? `rows=${Number(r.table_rows).toLocaleString()}` : "";
    lines.push(`-- ${r.table_name}: ${size} ${rowcount}`);
    lines.push(`DROP TABLE IF EXISTS \`${schema}\`.\`${name}\`;`);
    lines.push("");
  }
  writeUtf8(filePath, lines.join("\n"));
  return filePath;
}

/** Excel：每个国家一个 sheet。调用 python3 + openpyxl 生成 .xlsx。 */
export function exportXlsx(groupedRows, filePath, { python = "python3" } = {}) {
  const tmpDir = path.join(path.dirname(filePath), ".tmp_xlsx");
  mkdirp(tmpDir);
  const manifests = [];
  for (const [country, rows] of Object.entries(groupedRows)) {
    const csvPath = path.join(tmpDir, `${country}.csv`);
    exportCsv(rows, csvPath, {});
    manifests.push({
      country,
      csv: csvPath,
      rows: rows.length,
      gb: rows.reduce((s, r) => s + (Number(r.size_gb) || Number(r["总数据量GB"]) || 0), 0),
    });
  }
  const manifestPath = path.join(tmpDir, "manifest.json");
  writeUtf8(manifestPath, JSON.stringify(manifests));
  const script = buildXlsxScript();
  const scriptPath = path.join(tmpDir, "build_xlsx.py");
  writeUtf8(scriptPath, script);
  execSync(`${python} "${scriptPath}" "${manifestPath}" "${filePath}"`, { stdio: "inherit" });
  return filePath;
}

function buildXlsxScript() {
  return `
import json, sys, os, csv
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

manifest_path, out_path = sys.argv[1], sys.argv[2]
manifests = json.load(open(manifest_path, encoding="utf-8"))
wb = Workbook()
wb.remove(wb.active)
header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
header_font = Font(bold=True, color="FFFFFF")
for m in manifests:
    ws = wb.create_sheet(title=m["country"][:31])
    ws.append([m["country"], "张数: %d" % m["rows"], "容量: %.0f GB" % m["gb"]])
    ws.append([])
    with open(m["csv"], encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        data_rows = list(reader)
    if "distribute_bucket" in fieldnames:
        headers = ["库(schema)", "表名(table_name)", "模型", "分区键", "分桶键", "分桶数", "总行数", "容量(GB)", "每桶行数", "分区数", "每分区每桶行数", "严重级别"]
        colkeys = ["table_schema", "table_name", "table_model", "partition_key", "distribute_key", "distribute_bucket", "table_rows", "size_gb", "rows_per_bucket", "partition_count", "rows_per_part_bucket", "severity"]
        widths = [18, 55, 10, 14, 22, 10, 15, 12, 16, 10, 16, 10]
    elif "table_schema" in fieldnames:
        headers = ["库(schema)", "表名(table_name)", "行数", "容量(GB)", "创建时间"]
        colkeys = ["table_schema", "table_name", "table_rows", "size_gb", "create_time"]
        widths = [18, 50, 14, 12, 14]
    else:
        # 通用模式：直接用 CSV 字段名做表头（如中文列的中文检测结果）
        headers = fieldnames
        colkeys = fieldnames
        widths = [max(10, min(30, len(str(h)) * 2 + 6)) for h in headers]
    ws.append(headers)
    ncol = len(headers)
    for col in range(1, ncol + 1):
        c = ws.cell(row=3, column=col)
        c.fill = header_fill; c.font = header_font
        c.alignment = Alignment(horizontal="center")
    for r in data_rows:
        ws.append([r.get(k, "") for k in colkeys])
    for col, w in zip(range(1, ncol + 1), widths):
        ws.column_dimensions[get_column_letter(col)].width = w
    ws.freeze_panes = "A4"
wb.save(out_path)
print("saved:", out_path)
`;
}
