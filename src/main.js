// ============================================================
// 入口：解析启动参数 → 准备 data → 启动 http → 启动后台调度。不读环境变量。
//   --port <n>            默认 3030
//   --host <addr>         默认 0.0.0.0（局域网可访问，必须有令牌）；127.0.0.1 只本机
//   --data <dir>          数据目录，默认 <Lin>/data
//   --dry                 不启动动态调度、零点预生成、日结时钟；不向任何聊天渠道发消息（用数据副本演练）
//   --channel-api-host <url> 联调时把 Telegram 基址指到假的服务器
//   --debug               打开调试日志
// 端口被占：打印明确错误并以 2 退出（守护脚本 10 秒后重试）。
// ============================================================

import { parseArgs } from "node:util";
import { getDataDir, setDataDir } from "./config/paths.js";
import { runtimeOptions, setRuntimeOptions } from "./config/runtime.js";
import { createApp } from "./app.js";
import { installProcessGuards } from "./http/server.js";
import { lanUrls } from "./http/routes/lan.js";
import { createLogger, setLogDebug } from "./util/log.js";

const log = createLogger("main");
const EXIT_PORT_IN_USE = 2;
const EXIT_BAD_ARGS = 64;
const SHUTDOWN_TIMEOUT_MS = 8_000;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      data: { type: "string" },
      dry: { type: "boolean" },
      "channel-api-host": { type: "string" },
      debug: { type: "boolean" },
    },
    strict: true,
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) throw new Error(`--port 不对：${values.port}`);
  return { port, host: values.host, data: values.data, dry: Boolean(values.dry), channelApiHost: values["channel-api-host"], debug: Boolean(values.debug) };
}

function banner(token) {
  const { host, port, dry } = runtimeOptions();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const lines = [
    "",
    `  她在这里：http://127.0.0.1:${port}/${query}`,
    ...lanUrls(token).map((url) => `  手机（同一网络）：${url}`),
    `  数据目录：${getDataDir()}`,
    ...(dry ? ["  --dry：不发聊天渠道消息、不跑后台调度"] : []),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`参数错误：${error.message}\n用法：node src/main.js [--port 3030] [--host 0.0.0.0] [--data <目录>] [--dry] [--channel-api-host <url>] [--debug]\n`);
    process.exit(EXIT_BAD_ARGS);
  }
  if (cli.data) setDataDir(cli.data);
  setRuntimeOptions({ port: cli.port, host: cli.host, dry: cli.dry, channelApiHost: cli.channelApiHost });
  setLogDebug(cli.debug);
  installProcessGuards();

  const { host, port } = runtimeOptions();
  const app = await createApp({ host });
  app.server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(`端口 ${port} 已被占用。先停掉占用它的程序（可能是旧版本还在跑），或用 --port 换一个。\n`);
      process.exit(EXIT_PORT_IN_USE);
    }
    log.error("server error", { error });
    process.exit(1);
  });
  await new Promise((resolve) => app.server.listen(port, host, resolve));
  banner(app.token);
  log.info("started", { port, host, dry: runtimeOptions().dry });
  await app.startBackground().catch((error) => log.error("background start failed", { error }));

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    // 正在进行的一轮最多等几秒；超时直接退出（对话是追加写，不会写坏）。
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

await main();
