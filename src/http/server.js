// ============================================================
// HTTP 服务：http.createServer + 令牌 + 路由分发 + 静态文件（web/）+ 错误兜底。
// 请求体上限 1 MB；路由异常返回 500 并记日志，进程不退出。
// ============================================================

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { WEB_ROOT } from "../config/paths.js";
import { createLogger } from "../util/log.js";
import { createAuth } from "./auth.js";
import { HttpError } from "./router.js";

const log = createLogger("http");
export const BODY_LIMIT_BYTES = 1024 * 1024;
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        // 不 destroy 连接：丢弃剩余数据，让上层正常回 413。
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(status === 413 ? { connection: "close" } : {}), ...headers });
  res.end(JSON.stringify(body ?? {}));
}

async function serveStatic(res, pathname, headers) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return false;
  }
  const full = normalize(join(WEB_ROOT, rel));
  if (!full.startsWith(WEB_ROOT + sep) && full !== WEB_ROOT) return false;
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) return false;
  const type = STATIC_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache", ...headers });
  res.end(await readFile(full));
  return true;
}

/** 未处理的 Promise 拒绝只记日志，不让进程退出（后台任务失败不能把她整个弄死）。 */
export function installProcessGuards() {
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));
}

/**
 * @param {{router: ReturnType<import("./router.js").createRouter>, token: string}} options
 */
export function createLinServer({ router, token }) {
  const auth = createAuth({ token });
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const { ok, setCookie } = auth.check(req, url);
      const cookieHeader = setCookie ? { "set-cookie": setCookie } : {};
      if (!ok) return sendJson(res, 401, { error: "unauthorized" });
      const matched = router.match(req.method ?? "GET", url.pathname);
      if (matched && "handler" in matched) {
        let bodyText;
        const ctx = {
          req,
          res,
          url,
          params: matched.params,
          query: url.searchParams,
          header: (name) => {
            const value = req.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
          rawBody: async () => (bodyText ??= await readBody(req)),
          body: async () => {
            const text = await ctx.rawBody();
            if (!text.trim()) return {};
            try {
              return JSON.parse(text);
            } catch {
              throw new HttpError(400, "invalid json");
            }
          },
          cookieHeader,
        };
        const result = await matched.handler(ctx);
        if (res.headersSent || res.writableEnded) return;
        if (result && result.__reply) {
          if (Buffer.isBuffer(result.body)) {
            res.writeHead(result.status, { ...cookieHeader, ...result.headers });
            res.end(result.body);
            return;
          }
          return sendJson(res, result.status, result.body, { ...cookieHeader, ...result.headers });
        }
        return sendJson(res, 200, result ?? {}, cookieHeader);
      }
      if (matched && "methodNotAllowed" in matched) return sendJson(res, 405, { error: "method not allowed" });
      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
      if ((req.method === "GET" || req.method === "HEAD") && (await serveStatic(res, url.pathname, cookieHeader))) return;
      // 前端没有路由，未知路径回首页（比如手机直接打开 /#moments 以外的旧链接）。
      if (req.method === "GET" && (await serveStatic(res, "/", cookieHeader))) return;
      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      log.error("route failed", { method: req.method, path: url.pathname, error });
      return sendJson(res, 500, { error: "internal error" });
    }
  });
}
