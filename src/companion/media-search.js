const DDG_ORIGIN = "https://html.duckduckgo.com/html/";
const BING_ORIGIN = "https://www.bing.com/search";
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 12_000;
const KINDS = new Set(["movie", "series", "book", "music"]);

export class MediaSearchError extends Error {
  constructor(message, kind, cause) {
    super(message, { cause });
    this.name = "MediaSearchError";
    this.kind = kind;
  }
}

/** Comparison form used for both query matching and duplicate detection. */
export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{S}]+/gu, "");
}

function decodeEntities(value) {
  return String(value ?? "").replace(/&(?:amp|lt|gt|quot|apos|nbsp|#(\d+)|#x([\da-f]+));/giu, (all, decimal, hex) => {
    if (decimal || hex) {
      const point = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[all] ?? all;
  });
}

function stripMarkup(value) {
  return decodeEntities(String(value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1").replace(/<[^>]*>/gu, "")).replace(/\s+/gu, " ").trim();
}

function safePublicUrl(value) {
  let url;
  try { url = new URL(decodeEntities(value)); } catch { return null; }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!host.includes(".") || /\.(?:local|localhost|internal|lan)$/u.test(host) || host === "0.0.0.0" || host.includes(":")) return null;
  if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) && host.split(".").some((part) => Number(part) > 255)) return null;
  return url.href;
}

function queryFor(work) {
  if (!work || typeof work.title !== "string" || !work.title.trim() || work.title.length > 70 || /[\r\n]/u.test(work.title) || !KINDS.has(work.kind)) {
    throw new MediaSearchError("invalid work", "invalid-input");
  }
  const parts = [work.title.trim(), work.kind === "series" ? "电视剧" : work.kind === "movie" ? "电影" : work.kind === "book" ? "书" : "音乐"];
  if (work.creator != null && String(work.creator).trim()) parts.push(String(work.creator).trim());
  if (work.year != null && String(work.year).trim()) parts.push(String(work.year).trim());
  if (work.unit != null) {
    if (!Number.isInteger(work.unit) || work.unit < 1) throw new MediaSearchError("invalid unit", "invalid-input");
    parts.push(work.kind === "series" ? `第${work.unit}集剧情` : work.kind === "book" ? `第${work.unit}章 内容` : "");
  } else parts.push(work.kind === "music" ? "作品介绍" : work.kind === "book" ? "内容" : "剧情");
  return parts.filter(Boolean).join(" ");
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu"));
  return match ? match[2] : "";
}

function ddgTarget(raw) {
  const decoded = decodeEntities(raw);
  try {
    const parsed = new URL(decoded, DDG_ORIGIN);
    if (parsed.hostname === "duckduckgo.com" && parsed.pathname === "/l/") return parsed.searchParams.get("uddg") ?? "";
  } catch { /* rejected below */ }
  return decoded;
}

export function parseDuckDuckGoHtml(html, title) {
  const text = String(html ?? "");
  if (/(?:captcha|challenge|机器人验证|人机验证|unusual traffic)/iu.test(text)) return { challenge: true, sources: [] };
  const wanted = normalizeSearchText(title);
  const sources = [];
  for (const match of text.matchAll(/<a\b[^>]*class\s*=\s*(["'])[^"']*\bresult__a\b[^"']*\1[^>]*>([\s\S]*?)<\/a>/giu)) {
    const tag = match[0];
    const bodyStart = match.index + match[0].length;
    const next = text.indexOf("result__a", bodyStart);
    const section = text.slice(match.index, next > 0 ? next : match.index + 12000);
    const href = safePublicUrl(ddgTarget(attr(tag, "href")));
    const resultTitle = stripMarkup(match[2]);
    const snippetMatch = section.match(/<a\b[^>]*class\s*=\s*(["'])[^"']*\bresult__snippet\b[^"']*\1[^>]*>([\s\S]*?)<\/a>/iu);
    const snippet = stripMarkup(snippetMatch?.[2]);
    if (href && wanted && normalizeSearchText(`${resultTitle} ${snippet}`).includes(wanted)) sources.push({ title: resultTitle, url: href, snippet });
  }
  return { challenge: false, sources: uniqueSources(sources) };
}

export function parseBingRss(xml, title) {
  const wanted = normalizeSearchText(title);
  const sources = [];
  for (const item of String(xml ?? "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)) {
    const block = item[1];
    const get = (name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "iu"))?.[1] ?? "";
    const resultTitle = stripMarkup(get("title"));
    const snippet = stripMarkup(get("description"));
    const href = safePublicUrl(stripMarkup(get("link")));
    if (href && wanted && normalizeSearchText(`${resultTitle} ${snippet}`).includes(wanted)) sources.push({ title: resultTitle, url: href, snippet });
  }
  return uniqueSources(sources);
}

function uniqueSources(items) {
  const seen = new Set();
  return items.filter((item) => { const key = item.url; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 5);
}

async function readLimited(response, signal) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new MediaSearchError("search response too large", "response-too-large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new MediaSearchError("search response too large", "response-too-large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock?.(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function request(fetchImpl, url, externalSignal) {
  const controller = new AbortController();
  if (externalSignal?.aborted) controller.abort(externalSignal.reason ?? new DOMException("Aborted", "AbortError"));
  const timer = setTimeout(() => controller.abort(new DOMException("Search timed out", "TimeoutError")), TIMEOUT_MS);
  const abort = () => controller.abort(externalSignal.reason ?? new DOMException("Aborted", "AbortError"));
  externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "error", headers: { accept: "text/html,application/rss+xml" } });
    if (!response.ok) throw new MediaSearchError(`search HTTP ${response.status}`, "http");
    return await readLimited(response, controller.signal);
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new MediaSearchError(error.message, error.name === "TimeoutError" ? "timeout" : "cancelled", error);
    throw error instanceof MediaSearchError ? error : new MediaSearchError(error?.message ?? "search network failure", "network", error);
  } finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); }
}

export async function searchMedia(work, options = {}) {
  const query = queryFor(work);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new MediaSearchError("fetch unavailable", "config");
  const signal = options.signal;
  const ddgUrl = `${DDG_ORIGIN}?q=${encodeURIComponent(query)}`;
  try {
    const parsed = parseDuckDuckGoHtml(await request(fetchImpl, ddgUrl, signal), work.title);
    if (parsed.challenge) throw new MediaSearchError("search challenge", "challenge");
    if (parsed.sources.length) return { query, sources: parsed.sources, fetchedAt: new Date().toISOString() };
  } catch (error) {
    if (error?.kind === "response-too-large") throw error;
    if (signal?.aborted || error?.kind === "cancelled" || error?.name === "AbortError") throw error;
  }
  const bingUrl = `${BING_ORIGIN}?format=rss&q=${encodeURIComponent(query)}`;
  const sources = parseBingRss(await request(fetchImpl, bingUrl, signal), work.title);
  return { query, sources, fetchedAt: new Date().toISOString() };
}

export { safePublicUrl, decodeEntities };
