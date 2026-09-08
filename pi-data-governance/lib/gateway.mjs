import { resolveCountry } from "./config.mjs";

/**
 * 数据治理网关客户端。
 * 通过 n8n 工作流「全库零访问扫描」(9VkJJugXwnWqJApp) 的 webhook 执行：
 *  - 完整扫描（read_only=false）：重建 refs（被访问表）→ 计算零访问表 → 落库
 *  - 只读查询（read_only=true）：直接查询已落库的零访问表/备份表
 * 注意：该 webhook 的「返回结果」节点存在已知序列化问题（响应体为空但数据已落库），
 * 因此本客户端以「执行落库 + 结果查询」两步完成，不依赖 webhook 响应体。
 */

const DEFAULT_WEBHOOK_BASE = "https://sql-cn.kuainiujinke.com";
const DEFAULT_WORKFLOW_ID = "9VkJJugXwnWqJApp";
const RESULT_NODE = "查询零访问表统计";

function postJson(url, body, { timeoutMs = 60_000, fetchFn = fetch, headers: extraHeaders = {} } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  return fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: controller?.signal,
  }).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 从 n8n API 读取指定工作流最近一次执行中「查询零访问表统计」节点的 rows。
 * 解决 webhook 返回体为空的问题（返回结果节点已知序列化 bug，但数据已落库/节点已出结果）。
 * 需要环境变量 N8N_URL / N8N_API_KEY。
 */
export async function readExecutionRows({ env = process.env, fetchFn = fetch, workflowId = DEFAULT_WORKFLOW_ID, nodeName = RESULT_NODE } = {}) {
  const n8nUrl = String(env.N8N_URL || "").replace(/\/+$/, "");
  const apiKey = String(env.N8N_API_KEY || "").trim();
  if (!n8nUrl || !apiKey) {
    return { ok: false, reason: "N8N_URL/N8N_API_KEY 未配置，无法从执行记录读取", rows: [] };
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30_000) : null;
  try {
    const listRes = await fetchFn(`${n8nUrl}/api/v1/executions?limit=1&workflowId=${workflowId}`, {
      headers: { "X-N8N-API-KEY": apiKey },
      signal: controller?.signal,
    });
    const list = await listRes.json().catch(() => ({}));
    const eid = list.data?.[0]?.id;
    if (!eid) return { ok: false, reason: "未找到执行记录", rows: [] };
    const detailRes = await fetchFn(`${n8nUrl}/api/v1/executions/${eid}?includeData=true`, {
      headers: { "X-N8N-API-KEY": apiKey },
      signal: controller?.signal,
    });
    const detail = await detailRes.json().catch(() => ({}));
    const run = detail.data?.resultData?.runData || {};
    const nodeArr = run[nodeName] || [];
    const main = nodeArr[0]?.data?.main?.[0]?.[0]?.json;
    const data = main?.data || main || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    return { ok: true, executionId: eid, rows };
  } catch (error) {
    return { ok: false, reason: error.message, rows: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 触发完整零访问扫描（read_only=false）。
 * @param {object} opts
 * @param {string} opts.country - 国家代码（cn/ine/mx/ph/pk/th）
 * @param {number} [opts.lookbackDays] - 回看窗口天数（默认取配置）
 * @param {string[]} [opts.layers] - 限定层（ods/dwd/dws/ads）；不传则全库
 * @param {boolean} [opts.bak] - 是否只扫备份表（bak 模式）
 */
export async function triggerZombieScan(opts, { cfg, env = process.env, fetchFn = fetch } = {}) {
  const country = resolveCountry(opts.country, cfg, { env });
  const body = {
    country: country.code,
    lookback_days: Number(opts.lookbackDays ?? cfg.lookbackDays ?? 30),
  };
  if (opts.layers && Array.isArray(opts.layers)) body.layers = opts.layers.join(",");
  if (opts.bak) body.bak = true;
  if (opts.min_gb != null) body.min_gb = Number(opts.min_gb);

  const base = String(cfg.gateway.n8nUrl || DEFAULT_WEBHOOK_BASE).replace(/\/+$/, "");
  const webhook = `${base}${cfg.gateway.zombieWebhook}`;
  // 触发为 fire-and-forget：webhook 要等 n8n 执行完才返回（可能几分钟），
  // 这里用短超时，超时即视为"已受理"（扫描在后台继续执行）。
  let response = null;
  let timeoutNote = "";
  try {
    response = await postJson(webhook, body, {
      timeoutMs: Number(env.GOV_SCAN_TIMEOUT_MS || 25_000),
      fetchFn,
    });
  } catch (error) {
    if (error.name === "AbortError" || /timeout|timed out|abort/i.test(error.message || "")) {
      timeoutNote = "（触发已发出，webhook 等待执行完成而超时，属正常）";
      response = null;
    } else {
      throw error;
    }
  }
  if (response && !response.ok) {
    const text = await response.text().catch(() => "");
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    const error = new Error(payload.error || `扫描网关失败 (HTTP ${response.status})`);
    error.statusCode = 502;
    throw error;
  }

  // 注意：webhook 返回可能为空（已知问题）。此处仅确认请求已受理。
  return {
    success: true,
    country: country.code,
    gatewayCountry: country.gatewayCountry,
    lookbackDays: body.lookback_days,
    layers: body.layers || null,
    bak: Boolean(body.bak),
    accepted: true,
    timeoutNote,
    note: "扫描已在 n8n 后端执行；请稍候用 gov_query 读取结果（零访问表已落库）。",
  };
}

/**
 * 只读查询已落库的零访问表/备份表。
 * @param {object} opts
 * @param {string} opts.country
 * @param {number} [opts.offset]
 * @param {string} [opts.schema] - 限定 schema
 * @param {number} [opts.min_gb]
 * @param {boolean} [opts.bak] - bak 模式查询
 * @param {number} [opts.limit] - 最大行数
 */
export async function queryZeroAccess(opts, { cfg, env = process.env, fetchFn = fetch } = {}) {
  const country = resolveCountry(opts.country, cfg, { env });
  const body = {
    country: country.code,
    read_only: true,
    offset: Math.max(0, Number(opts.offset ?? 0)),
  };
  if (opts.schema) body.schema = String(opts.schema);
  if (opts.min_gb != null) body.min_gb = Number(opts.min_gb);
  if (opts.bak) body.bak = true;
  if (opts.layers && Array.isArray(opts.layers)) body.layers = opts.layers.join(",");

  const base = String(cfg.gateway.n8nUrl || DEFAULT_WEBHOOK_BASE).replace(/\/+$/, "");
  const webhook = `${base}${cfg.gateway.zombieWebhook}`;
  const response = await postJson(webhook, body, {
    timeoutMs: Number(env.GOV_QUERY_TIMEOUT_MS || 90_000),
    fetchFn,
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 300) }; }

  if (!response.ok) {
    const error = new Error(payload.error || `查询网关失败 (HTTP ${response.status})`);
    error.statusCode = 502;
    throw error;
  }

  // webhook 返回体可能为空（已知问题），返回可解析到的部分；若为空则提示用 CSV/执行记录读取
  let rows = payload.data?.rows || payload.rows || payload.data || [];
  rows = Array.isArray(rows) ? rows : [];

  // fallback：从 n8n 执行记录读取（推荐路径，数据可靠）
  if (rows.length === 0) {
    const exec = await readExecutionRows({ env, fetchFn });
    if (exec.ok && exec.rows.length > 0) {
      rows = exec.rows;
    }
    return {
      success: true,
      country: country.code,
      gatewayCountry: country.gatewayCountry,
      rows,
      rowCount: rows.length,
      source: exec.ok ? `n8n-execution:${exec.executionId}` : "webhook-empty",
      executionId: exec.executionId || null,
      note: exec.ok
        ? `已从 n8n 执行记录(执行 ${exec.executionId})读取 ${rows.length} 行。`
        : "webhook 返回体为空且未能从执行记录读取（检查 N8N_URL/N8N_API_KEY）。",
    };
  }

  return {
    success: true,
    country: country.code,
    gatewayCountry: country.gatewayCountry,
    rows,
    rowCount: rows.length,
    source: "webhook",
  };
}

/**
 * 通用只读 SR 查询（如分桶合理性检查等分析类 SQL）。
 * 通过 n8n 通用查询 webhook 执行（该 webhook 由数据治理包配套部署：
 * 接收 {country, sql} → 校验只读 → 调 SR 网关 → 返回 rows）。
 * 若 webhook 未部署，回退到直接调用 SR 网关（需网络可达 172.20.0.234）。
 * @param {object} opts
 * @param {string} opts.country - 国家（cn/ine/mx/ph/pk/th）
 * @param {string} opts.sql - 只读 SQL
 * @param {number} [opts.limit] - 返回行数上限（默认 100）
 */
export async function runSrQuery(opts, { cfg, env = process.env, fetchFn = fetch } = {}) {
  const country = resolveCountry(opts.country, cfg, { env });
  const sql = String(opts.sql || "").trim();
  if (!sql) {
    const err = new Error("sql 必填");
    err.statusCode = 400;
    throw err;
  }
  const readOnly = /^(select|show|desc|describe|explain|with)\s/i.test(sql);
  if (!readOnly) {
    const err = new Error("仅允许只读 SQL（SELECT/SHOW/DESC/EXPLAIN/WITH）");
    err.statusCode = 400;
    throw err;
  }
  const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 100)));

  const base = String(cfg.gateway.n8nUrl || DEFAULT_WEBHOOK_BASE).replace(/\/+$/, "");
  const genericWebhook = `${base}/webhook/gov-generic-query`;
  try {
    const response = await postJson(genericWebhook, {
      country: country.code,
      sql,
    }, { timeoutMs: Number(env.GOV_QUERY_TIMEOUT_MS || 120_000), fetchFn });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const error = new Error(payload.error || payload.message || `查询网关失败 (HTTP ${response.status})`);
      error.statusCode = 502;
      throw error;
    }
    const rows = payload.data?.rows || payload.rows || [];
    return {
      success: true,
      country: country.code,
      gatewayCountry: country.gatewayCountry,
      rows: Array.isArray(rows) ? rows.slice(0, limit) : [],
      rowCount: Array.isArray(rows) ? Math.min(rows.length, limit) : 0,
      source: "generic-webhook",
      truncated: Array.isArray(rows) && rows.length > limit,
    };
  } catch (cause) {
    // webhook 不可达时，尝试直连 SR 网关
    const srGateway = String(cfg.gateway.srGateway || "http://172.20.0.234:4888").replace(/\/+$/, "");
    const token = String(env.FUXI_SR_READ_TOKEN || cfg.readTokens?.sr || "fuxi_backend_query_all_20260518");
    try {
      const response = await postJson(`${srGateway}/api/rust/v1/sr-sandboxes/sql-executions`, {
        taskName: "gov-generic-query",
        country: country.gatewayCountry,
        purpose: "agent",
        accessMode: "local",
        sqlMode: "query",
        sql,
        page: 1,
        pageSize: limit,
        timeoutSec: 55,
      }, {
        timeoutMs: Number(env.GOV_QUERY_TIMEOUT_MS || 120_000),
        fetchFn,
        headers: { "Authorization": `Bearer ${token}` },
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok) {
        const error = new Error(payload.message || payload.error || `SR 网关失败 (HTTP ${response.status})`);
        error.statusCode = 502;
        throw error;
      }
      const rows = payload.data?.rows || payload.rows || [];
      return {
        success: true,
        country: country.code,
        gatewayCountry: country.gatewayCountry,
        rows: Array.isArray(rows) ? rows.slice(0, limit) : [],
        rowCount: Array.isArray(rows) ? Math.min(rows.length, limit) : 0,
        source: "sr-gateway-direct",
      };
    } catch (directError) {
      if (cause.statusCode) throw cause;
      const error = new Error(`通用查询失败（webhook 与直连均不可用）: ${cause.message} / ${directError.message}`);
      error.statusCode = 502;
      throw error;
    }
  }
}
