// ============================================================
// 访问令牌：
//   ?token=<令牌> 命中 → 写 HttpOnly cookie lin_token（之后网页请求自动带上）
//   Authorization: Bearer <令牌> 也认
//   /api/lin/channels/webhook 与静态文件免令牌（回调靠签名）
//   其余 /api/* 没有令牌返回 401
// 只监听本机（127.0.0.1）且没有令牌文件时可不设令牌。
// ============================================================

import { timingSafeEqual } from "node:crypto";
import { WEBHOOK_PATH } from "../channels/webhook/channel.js";

export const TOKEN_COOKIE = "lin_token";
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 3600;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isPublicPath(pathname) {
  return pathname === WEBHOOK_PATH || !pathname.startsWith("/api/");
}

/**
 * @param {{token: string}} options token 为空字符串时不校验
 */
export function createAuth({ token }) {
  return {
    /**
     * 判断请求是否放行；放行且带了 ?token= 时返回要写的 Set-Cookie。
     * @param {import("node:http").IncomingMessage} req
     * @param {URL} url
     * @returns {{ok: boolean, setCookie?: string}}
     */
    check(req, url) {
      const queryToken = url.searchParams.get("token");
      const setCookie = token && queryToken && safeEqual(queryToken, token) ? `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax` : undefined;
      if (!token || isPublicPath(url.pathname)) return { ok: true, setCookie };
      if (setCookie) return { ok: true, setCookie };
      const bearer = /^Bearer\s+(.+)$/iu.exec(req.headers.authorization ?? "")?.[1]?.trim();
      if (bearer && safeEqual(bearer, token)) return { ok: true };
      const cookie = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
      if (cookie && safeEqual(cookie, token)) return { ok: true };
      return { ok: false };
    },
  };
}
