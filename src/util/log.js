// ============================================================
// 日志：带模块前缀写 stdout/stderr。对象里名字像密钥的字段自动打码。
// 规矩：不记录消息全文、不记录 Key 和令牌（见 HANDOVER.md「日志」）。
// ============================================================

const SECRET_KEY_PATTERN = /(key|token|secret|password|authorization|cookie)/iu;
const MASK = "***";
const MAX_DEPTH = 4;

/** @type {{ quiet: boolean, debug: boolean }} */
const config = { quiet: false, debug: false };

/** 测试里关掉日志输出。 */
export function setLogQuiet(quiet) {
  config.quiet = Boolean(quiet);
}

/** 启动参数 --debug 打开调试日志（不用环境变量）。 */
export function setLogDebug(debug) {
  config.debug = Boolean(debug);
}

/**
 * 把对象里疑似密钥的字段替换成 ***；Error 只保留 message。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (value instanceof Error) return value.message;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) && item !== undefined && item !== null && item !== "" ? MASK : redact(item, depth + 1);
  }
  return out;
}

function format(args) {
  return args.map((arg) => {
    const safe = redact(arg);
    return typeof safe === "string" ? safe : JSON.stringify(safe);
  });
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * @param {string} module 模块前缀，如 "chat"、"channel"
 */
export function createLogger(module) {
  const prefix = `[lin:${module}]`;
  const write = (level, stream, args) => {
    if (config.quiet) return;
    stream.write(`${stamp()} ${level} ${prefix} ${format(args).join(" ")}\n`);
  };
  return {
    info: (...args) => write("INFO", process.stdout, args),
    warn: (...args) => write("WARN", process.stdout, args),
    error: (...args) => write("ERROR", process.stderr, args),
    debug: (...args) => {
      if (config.debug) write("DEBUG", process.stdout, args);
    },
  };
}
