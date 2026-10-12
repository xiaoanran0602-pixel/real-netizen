import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCatalog, formatMediaContext, normalizeMediaRequests, workKey } from "../src/companion/media-library.js";
import { createMediaRuntime } from "../src/companion/media-runtime.js";

const request = { title: "测试剧", kind: "series", creator: "", year: "2023", evidence: "推荐你看2023年的《测试剧》" };
const sources = [{ title: "测试剧 2023 电视剧 全2集 第1集剧情", url: "https://example.com/show", snippet: "测试剧2023年电视剧，全2集。第1集：主角回到了故乡。第2集：朋友重逢。" }];
const analysis = { identityMatched: true, ambiguous: false, notes: [{ source: 0, quote: "主角回到了故乡" }] };

test("作品提取只接受用户明说的标题/版本，不接受凭空作品或私聊作为搜索词", () => {
  const valid = normalizeMediaRequests([request], request.evidence);
  assert.equal(valid.length, 1);
  assert.equal(normalizeMediaRequests([{ ...request, title: "另一个故事" }], request.evidence).length, 0);
  assert.equal(normalizeMediaRequests([{ ...request, year: "1999" }], request.evidence).length, 0);
  assert.equal(normalizeMediaRequests([{ ...request, kind: "__proto__" }], request.evidence).length, 0);
  assert.equal(normalizeMediaRequests([{ ...request, title: "https://private.local/secret" }], request.evidence).length, 0);
  assert.equal(workKey(request), workKey({ ...request, title: " 测试剧 " }));
  assert.notEqual(workKey(request), workKey({ ...request, kind: "movie" }));
});

test("资料必须有可核对原文；同名歧义、假引用、错集数不能转为观看记录", () => {
  const catalog = acceptCatalog(analysis, sources, request, 1);
  assert.equal(catalog.totalUnits, 2);
  assert.equal(catalog.notes[0].text, "主角回到了故乡");
  assert.throws(() => acceptCatalog({ ...analysis, ambiguous: true }, sources, request), /ambiguous/);
  assert.throws(() => acceptCatalog({ ...analysis, notes: [{ source: 0, quote: "不存在的剧情" }] }, sources, request), /evidence/);
  assert.throws(() => acceptCatalog(analysis, sources, request, 3), /unit/);
  assert.throws(() => acceptCatalog(analysis, [{ ...sources[0], title: "测试剧2023电视剧简介" }], request, 1), /unit/, "不能用整部简介中碰巧出现的集数冒充这一集的内容");
  assert.throws(() => acceptCatalog(analysis, [{ ...sources[0], url: "http://127.0.0.1/" }], request), /evidence/);
});

test("分集页通过已核对作品路径继承版本，不能把同站其他作品混进来", () => {
  const detail = [{ title: "测试剧第1集剧情", url: "https://example.com/drama/abc123/episode/1", snippet: "主角回到了故乡。" }];
  const work = { ...request, catalog: { notes: [{ url: "https://example.com/drama/abc123" }] } };
  assert.equal(acceptCatalog(analysis, detail, work, 1).notes.length, 1);
  assert.throws(() => acceptCatalog(analysis, detail, request, 1), /identity/);
  assert.throws(() => acceptCatalog(analysis, [{ ...detail[0], url: "https://example.com/drama/another/episode/1" }], work, 1), /identity/);
});

function harness(extra = {}) {
  let data = { version: 1, works: [] };
  let clock = new Date(2026, 9, 10, 20).getTime();
  const calls = [];
  const storage = { readStore: async () => structuredClone(data), writeStore: async (next) => { data = structuredClone(next); } };
  const runtime = createMediaRuntime({
    now: () => clock,
    ...storage,
    enabled: async () => true,
    available: async () => true,
    search: async (work) => { calls.push(work); return { sources, fetchedAt: clock }; },
    analyze: async () => analysis,
    ...extra,
  });
  return { runtime, calls, storage, now: () => clock, data: () => data, advance: (minutes) => { clock += minutes * 60_000; } };
}

test("推荐先入库、查资料不等于看完，按可用时间推进且重复推荐复用缓存", async () => {
  const h = harness();
  await h.runtime.recommend([request], request.evidence);
  await h.runtime.tick();
  assert.equal(h.data().works.length, 1);
  assert.equal(h.data().works[0].completedUnits, 0);
  assert.equal(h.calls.length, 1);
  await h.runtime.recommend([request], request.evidence);
  await h.runtime.tick();
  assert.equal(h.data().works.length, 1);
  assert.equal(h.calls.length, 2, "第二次仅查第1集资料，不重复查概况");
  assert.equal(h.data().works[0].completedUnits, 0);
  for (let i = 0; i < 45; i += 1) { h.advance(1); await h.runtime.tick(); }
  assert.equal(h.data().works[0].completedUnits, 1);
  assert.equal(h.data().works[0].history[0].provenance, "simulation_from_sources");
});

test("已有长剧正在看时，新推荐仍优先补资料，不等整部剧看完", async () => {
  const h = harness();
  await h.runtime.recommend([request], request.evidence);
  await h.runtime.tick(); await h.runtime.tick();
  const other = { title: "新电影", kind: "movie", evidence: "推荐你看《新电影》" };
  await h.runtime.recommend([other], other.evidence);
  await h.runtime.tick();
  assert.equal(h.calls.at(-1).title, "新电影");
  assert.equal(h.data().works[0].completedUnits, 0);
});

test("没空、查不到资料都不虚构消费进度", async () => {
  const h = harness({ available: async () => false });
  await h.runtime.recommend([request], request.evidence);
  await h.runtime.tick();
  h.advance(1000);
  await h.runtime.tick();
  assert.equal(h.data().works[0].completedUnits, 0);
  const empty = harness({ search: async () => ({ sources: [] }) });
  await empty.runtime.recommend([request], request.evidence);
  await empty.runtime.tick();
  assert.equal(empty.data().works[0].status, "unavailable");
  assert.equal(empty.data().works[0].completedUnits, 0);
  await empty.runtime.tick();
  assert.equal(empty.data().works[0].attempts, 1, "退避期不刷搜索");
});

test("活跃会话跨重启保留进度，离线一天不补看，停用不联网", async () => {
  const h = harness();
  await h.runtime.recommend([request], request.evidence);
  await h.runtime.tick();
  await h.runtime.tick();
  h.advance(1); await h.runtime.tick();
  assert.equal(h.data().works[0].session.elapsedMs, 60_000);
  await h.runtime.stop();
  h.advance(1440);
  const next = createMediaRuntime({ ...h.storage, now: h.now, enabled: async () => true, available: async () => true, search: async () => { throw new Error("不应重复查已缓存段落"); } });
  await next.tick();
  assert.equal(h.data().works[0].session.elapsedMs, 60_000);
  h.advance(1); await next.tick();
  assert.equal(h.data().works[0].session.elapsedMs, 120_000);
  await next.stop();
  const disabled = createMediaRuntime({ ...h.storage, now: h.now, enabled: async () => false });
  await disabled.tick();
  assert.equal(h.data().works[0].session.elapsedMs, 120_000);
});

test("音乐和电影按估计时段完成一次，书按有证据的章节推进而非直接读完", async () => {
  for (const [kind, minutes] of [["music", 5], ["movie", 120], ["book", 25]]) {
    const rec = { title: "测试作品", kind, evidence: "推荐你看看《测试作品》" };
    const h = harness({ search: async () => ({ sources: [{ title: "测试作品 第一章 内容介绍", url: "https://example.com/work", snippet: "作品讲述了一段故乡的故事。" }] }), analyze: async () => ({ identityMatched: true, ambiguous: false, notes: [{ source: 0, quote: "作品讲述了一段故乡的故事" }] }) });
    await h.runtime.recommend([rec], rec.evidence);
    await h.runtime.tick(); await h.runtime.tick();
    for (let n = 0; n < minutes; n += 1) { h.advance(1); await h.runtime.tick(); }
    assert.equal(h.data().works[0].completedUnits, 1);
    assert.equal(h.data().works[0].status, kind === "book" ? "ready" : "completed");
  }
});

test("版本澄清沿用原推荐，不生成两个同名队列", async () => {
  const h = harness({ analyze: async () => ({ identityMatched: false, ambiguous: true, notes: [] }) });
  await h.runtime.recommend([{ ...request, year: "" }], request.evidence);
  await h.runtime.tick();
  assert.equal(h.data().works[0].status, "needs_clarification");
  await h.runtime.recommend([{ ...request, evidence: "2023年的那版" }], "2023年的那版", "推荐你看《测试剧》");
  assert.equal(h.data().works.length, 1);
  assert.equal(h.data().works[0].year, "2023");
  assert.equal(h.data().works[0].status, "pending");
});

test("暂停时的迟到搜索不写回，关闭后不再推进", async () => {
  let release;
  const h = harness({ search: () => new Promise((resolve) => { release = resolve; }) });
  await h.runtime.recommend([request], request.evidence);
  const running = h.runtime.tick();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const paused = h.runtime.pause();
  release({ sources });
  await Promise.all([running, paused]);
  assert.equal(h.data().works[0].catalog, null);
  await h.runtime.stop();
});

test("作品资料只在聊到它时注入，明确区分资料和模拟体验、限制剧透", () => {
  const work = { ...request, id: workKey(request), status: "ready", completedUnits: 0, catalog: acceptCatalog(analysis, sources, request), history: [] };
  const db = { version: 1, works: [work] };
  assert.equal(formatMediaContext(db, [{ role: "user", text: "今天写代码累了" }]), null);
  const text = formatMediaContext(db, [{ role: "user", text: "测试剧看了没？" }]);
  assert.match(text, /尚未开始/);
  assert.match(text, /模拟/);
  assert.match(text, /不主动剧透/);
  assert.doesNotMatch(text, /主角回到了故乡/, "未看不能把剧情引用当自己的观后感");
});
