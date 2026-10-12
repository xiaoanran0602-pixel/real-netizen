// ============================================================
// 极简路由：method + 路径模式（:param）→ 处理函数。处理函数拿到 ctx，返回值由 server.js 写回。
// ============================================================

/**
 * @typedef {{req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, params: Record<string, string>, query: URLSearchParams, url: URL, body: () => Promise<any>, rawBody: () => Promise<string>, header: (name: string) => string | undefined}} Ctx
 * @typedef {(ctx: Ctx) => Promise<any> | any} Handler
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 处理函数返回 reply(...) 时按指定状态码和头写回；返回普通对象时 200 JSON。 */
export function reply(status, body, headers = {}) {
  return { __reply: true, status, body, headers };
}

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}$`, "u"), keys };
}

export function createRouter() {
  /** @type {{method: string, regex: RegExp, keys: string[], handler: Handler}[]} */
  const routes = [];
  const add = (method) => (pattern, handler) => {
    routes.push({ method, ...compile(pattern), handler });
  };
  return {
    get: add("GET"),
    put: add("PUT"),
    post: add("POST"),
    delete: add("DELETE"),
    /** @returns {{handler: Handler, params: Record<string, string>} | {methodNotAllowed: true} | null} */
    match(method, pathname) {
      let pathMatched = false;
      for (const route of routes) {
        const found = route.regex.exec(pathname);
        if (!found) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = {};
        route.keys.forEach((key, index) => {
          try {
            params[key] = decodeURIComponent(found[index + 1]);
          } catch {
            params[key] = found[index + 1];
          }
        });
        return { handler: route.handler, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}
