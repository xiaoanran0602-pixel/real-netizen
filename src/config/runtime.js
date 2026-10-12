// ============================================================
// 运行时开关：由 main.js 按启动参数设置一次，其他模块只读。不用环境变量。
//   dry            --dry：不启动动态调度和零点预生成，不向任何渠道发消息（用数据副本演练用）
//   channelApiHost --channel-api-host：渠道联调时指到假的接口（如假 Telegram 服务器）
// ============================================================

const DEFAULT_CHANNEL_API_HOST = "https://api.telegram.org";

const options = {
  dry: false,
  channelApiHost: DEFAULT_CHANNEL_API_HOST,
  port: 3030,
  host: "0.0.0.0",
};

/** @param {Partial<typeof options>} patch */
export function setRuntimeOptions(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) options[key] = value;
  }
  options.channelApiHost = String(options.channelApiHost || DEFAULT_CHANNEL_API_HOST).replace(/\/+$/u, "");
}

export function runtimeOptions() {
  return options;
}

export function isDry() {
  return options.dry;
}
