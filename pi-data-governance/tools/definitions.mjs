/**
 * Pi 自定义工具元数据（TypeBox schema 风格）。
 * Pi Package 安装后可把这些工具注册进 pi-agent-core。
 * 字段：name / description / inputSchema(parameters)
 */

const countrySchema = {
  type: "string",
  description: "国家代码：cn/ine(印尼)/mx/ph/pk/th",
  enum: ["cn", "ine", "mx", "ph", "pk", "th"],
};

export const toolDefinitions = [
  {
    name: "gov_zombie_scan",
    description: "触发全库/分层(ods/dwd/dws/ads)零访问(僵尸)表扫描，后端 n8n 重建被访问表 refs 并计算零访问表落库。多国可用。",
    inputSchema: {
      type: "object",
      properties: {
        country: countrySchema,
        lookback_days: { type: "number", description: "回看窗口天数，默认 30" },
        layers: { type: "array", items: { type: "string", enum: ["ods", "dwd", "dws", "ads"] }, description: "限定层，不传则全库" },
        min_gb: { type: "number", description: "只保留大于该容量的表(GB)" },
      },
      required: ["country"],
    },
  },
  {
    name: "gov_bak_scan",
    description: "备份表识别（bak 模式）：按表名匹配 _bak/_backup/_back/_old/_his/_copy 等，可限定层。",
    inputSchema: {
      type: "object",
      properties: {
        country: countrySchema,
        lookback_days: { type: "number" },
        layers: { type: "array", items: { type: "string", enum: ["ods", "dwd", "dws", "ads"] } },
      },
      required: ["country"],
    },
  },
  {
    name: "gov_query",
    description: "查询已落库的零访问表或备份表（只读），支持分页、按 schema 过滤。",
    inputSchema: {
      type: "object",
      properties: {
        country: countrySchema,
        offset: { type: "number" },
        schema: { type: "string" },
        min_gb: { type: "number" },
        bak: { type: "boolean" },
        layers: { type: "array", items: { type: "string", enum: ["ods", "dwd", "dws", "ads"] } },
      },
      required: ["country"],
    },
  },
  {
    name: "gov_export",
    description: "导出 CSV / Excel(每国一个sheet) / DROP SQL 草稿文件。",
    inputSchema: {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object" } },
        format: { type: "string", enum: ["csv", "sql", "xlsx"] },
        country: countrySchema,
        dir: { type: "string" },
        name: { type: "string" },
      },
      required: ["rows"],
    },
  },
  {
    name: "gov_drop_sql",
    description: "生成 DROP SQL 草稿文件（仅写文件，永不执行）。",
    inputSchema: {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object" } },
        country: countrySchema,
        dir: { type: "string" },
        comment: { type: "string" },
      },
      required: ["rows"],
    },
  },
  {
    name: "gov_countries",
    description: "列出支持的国家及其网关映射。",
    inputSchema: { type: "object", properties: {} },
  },
];
