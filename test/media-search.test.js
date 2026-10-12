import test from "node:test";
import assert from "node:assert/strict";
import { parseDuckDuckGoHtml, parseBingRss, searchMedia, MediaSearchError, safePublicUrl, decodeEntities } from "../src/companion/media-search.js";

const response = (text, status = 200) => new Response(text, { status });
const ddg = (title = "欢颜") => `<a class="x result__a" rel="nofollow" href="//duckduckgo.com/l/?rut=x&amp;uddg=https%3A%2F%2Fexample.com%2Fa">${title} &amp; 介绍</a><div class="result__body"><a class="result__snippet" href="x">${title} 剧情内容</a></div>`;

test("解析 DDG 属性顺序、实体、跳转链接并去重", () => {
  const result = parseDuckDuckGoHtml(ddg(), "欢颜");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://example.com/a");
  assert.match(result.sources[0].title, /欢颜/);
});

test("只请求固定搜索站，不跟随重定向，不接受局域网来源", async () => {
  await searchMedia({ title: "欢颜", kind: "series" }, { fetchImpl: async (url, options) => {
    assert.equal(new URL(url).hostname, "html.duckduckgo.com");
    assert.equal(options.redirect, "error");
    return response(ddg());
  } });
  for (const url of ["http://localhost/", "http://host.localhost/", "http://internal/", "http://[fc00::1]/", "http://[::ffff:127.0.0.1]/", "https://user:pass@example.com/"]) assert.equal(safePublicUrl(url), null);
  assert.equal(decodeEntities("a&#99999999;b"), "ab");
});

test("Bing RSS 支持 CDATA 并过滤无关项", () => {
  const xml = `<rss><item><title><![CDATA[欢颜（电视剧）]]></title><link>https://example.com/x</link><description><![CDATA[欢颜 剧情]]></description></item><item><title>别的</title><link>https://example.com/y</link><description>无关</description></item></rss>`;
  assert.equal(parseBingRss(xml, "欢颜").length, 1);
});

test("challenge 不作为 DDG 资料", () => assert.equal(parseDuckDuckGoHtml("captcha challenge", "欢颜").challenge, true));

test("网络错误 fallback 到 Bing，最多两次请求", async () => {
  const urls = [];
  const result = await searchMedia({ title: "欢颜", kind: "movie" }, { fetchImpl: async (url) => { urls.push(url); if (urls.length === 1) throw new Error("offline"); return response(`<rss><item><title>欢颜</title><link>https://example.com</link><description>剧情</description></item></rss>`); } });
  assert.equal(result.sources.length, 1); assert.equal(urls.length, 2); assert.match(urls[1], /bing\.com/);
});

test("不安全来源、超大响应和取消被拒绝", async () => {
  assert.equal(parseBingRss("<item><title>欢颜</title><link>http://127.0.0.1/a</link><description>x</description></item>", "欢颜").length, 0);
  await assert.rejects(() => searchMedia({ title: "欢颜", kind: "movie" }, { fetchImpl: async () => response("x".repeat(512 * 1024 + 1)) }), (e) => e instanceof MediaSearchError && e.kind === "response-too-large");
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => searchMedia({ title: "欢颜", kind: "movie" }, { fetchImpl: async (_url, { signal }) => { signal.throwIfAborted(); return response(""); }, signal: ac.signal }));
});
