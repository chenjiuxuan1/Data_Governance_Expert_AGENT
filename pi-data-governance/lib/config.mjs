import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "..", "config", "data-governance.config.json");

/**
 * 展开 ${ENV:default} 形式的环境变量占位符。
 */
export function resolveEnvString(value, env = process.env) {
  return String(value ?? "").replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_match, key, def) => {
    const raw = env[key];
    return raw !== undefined && raw !== "" ? raw : (def ?? "");
  });
}

/**
 * 加载数据治理配置（JSON + 环境变量占位符展开）。
 */
export function loadConfig({ configPath = process.env.GOV_CONFIG_PATH || DEFAULT_CONFIG_PATH, env = process.env } = {}) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(`数据治理配置文件不存在: ${configPath} (${error.message})`);
  }
  const cfg = JSON.parse(raw);
  return deepResolve(cfg, env);
}

function deepResolve(value, env) {
  if (typeof value === "string") return resolveEnvString(value, env);
  if (Array.isArray(value)) return value.map((v) => deepResolve(v, env));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepResolve(v, env);
    return out;
  }
  return value;
}

const KNOWN_COUNTRIES = ["cn", "ine", "mx", "ph", "pk", "th"];

/**
 * 归一化国家代码（id/indonesia → ine 等）。
 */
export function normalizeCountryCode(value, cfg) {
  const code = String(value || "").trim().toLowerCase();
  const aliases = (cfg?.countryAliases) || {};
  return aliases[code] || code;
}

/**
 * 校验国家代码，返回网关用 country 码（gatewayCountry）。
 */
export function resolveCountry(value, cfg, { env = process.env } = {}) {
  const code = normalizeCountryCode(value, cfg);
  const entry = cfg?.countries?.[code];
  if (!entry) {
    const err = new Error(`不支持的国家: ${value}（可用: ${KNOWN_COUNTRIES.join("/")}）`);
    err.statusCode = 400;
    throw err;
  }
  const token = String(env[entry.tokenEnv] || "").trim();
  return {
    code,
    name: entry.name,
    gatewayCountry: entry.gatewayCountry,
    tokenEnv: entry.tokenEnv,
    token,
  };
}

export function knownCountries() {
  return KNOWN_COUNTRIES.slice();
}
