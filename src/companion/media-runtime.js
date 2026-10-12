// 后台作品库：串行持久化、先缓存资料，再按在线空闲时段模拟消费；离线不补看。
import { paths } from "../config/paths.js";
import { readSettings } from "../config/settings.js";
import { isDry } from "../config/runtime.js";
import { readJson, writeJsonAtomic, createSerializer } from "../store/files.js";
import { complete } from "../model/client.js";
import { formatLocalDate } from "../util/time.js";
import { createLogger } from "../util/log.js";
import { daySlots, slotAt } from "../inner/tags.js";
import { readLife } from "./life.js";
import { searchMedia } from "./media-search.js";
import { acceptCatalog, analyzeMedia, EMPTY_LIBRARY, formatMediaContext, normalizeMediaRequests, SESSION_MINUTES, workKey } from "./media-library.js";

export const MEDIA_TICK_MS = 60_000;
const MAX_WORKS = 200;
const MAX_ATTEMPTS = 3;
const log = createLogger("media");
export const readMediaLibrary = () => readJson(paths.mediaLibrary(), { ...EMPTY_LIBRARY, works: [] });

async function leisureInterval(from, to) {
  if (formatLocalDate(new Date(from)) !== formatLocalDate(new Date(to))) return false;
  const life = await readLife(new Date(to));
  if (!life.day) return false;
  const slots = daySlots(life.day);
  const minute = (ms) => new Date(ms).getHours() * 60 + new Date(ms).getMinutes();
  const a = slotAt(slots, minute(from));
  const b = slotAt(slots, minute(to));
  return a?.tag === "空闲" && b?.tag === "空闲" && a.start === b.start;
}

export function createMediaRuntime(deps = {}) {
  const now = deps.now ?? Date.now;
  const readStore = deps.readStore ?? readMediaLibrary;
  const writeStore = deps.writeStore ?? ((db) => writeJsonAtomic(paths.mediaLibrary(), db));
  const enabled = deps.enabled ?? (async () => !isDry() && (await readSettings()).mediaEnabled !== false);
  const available = deps.available ?? leisureInterval;
  const search = deps.search ?? searchMedia;
  const analyze = deps.analyze ?? ((input) => analyzeMedia({ ...input, complete: deps.complete ?? complete }));
  const serialize = createSerializer();
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let timer = null;
  let running = false;
  let paused = false;
  let epoch = 0;
  let controller = null;
  let lastTick = null;

  async function fetchCatalog(work, unit, signal) {
    const result = await search({ title: work.title, kind: work.kind, creator: work.creator, year: work.year, ...(unit ? { unit } : {}) }, { signal });
    if (!result?.sources?.length) throw new Error("no-sources");
    const sources = result.sources.slice(0, 5).map((s) => ({ title: String(s.title).slice(0, 240), url: s.url, snippet: String(s.snippet ?? "").slice(0, 1200) }));
    const raw = await analyze({ work, sources, unit, signal });
    return { ...acceptCatalog(raw, sources, work, unit), sources, fetchedAt: now() };
  }

  function tick() {
    return serialize(async () => {
      if (paused || !(await enabled())) { lastTick = null; return; }
      const at = now();
      const elapsed = lastTick !== null && at >= lastTick && at - lastTick <= 2 * MEDIA_TICK_MS ? at - lastTick : 0;
      const from = lastTick ?? at;
      lastTick = at;
      const generation = epoch;
      const db = await readStore();
      const day = formatLocalDate(new Date(at));
      const candidates = db.works.filter((w) => !["completed", "needs_clarification"].includes(w.status) && (w.attempts ?? 0) < MAX_ATTEMPTS && (w.retryAt ?? 0) <= at && (w.progressDay !== day || (w.completedToday ?? 0) < 3));
      // 新推荐先补资料，不能被一部长剧的观看会话堵上数天；消费仍只推进一个会话。
      const work = candidates.find((w) => !w.catalog) ?? candidates.find((w) => w.session) ?? candidates[0];
      if (!work) return;
      controller = new AbortController();
      try {
        if (!work.catalog) {
          work.catalog = await fetchCatalog(work, null, controller.signal);
          work.status = "ready";
        } else if (await available(from, at)) {
          if (!work.session) {
            const unit = work.completedUnits + 1;
            if (unit > 500) throw new Error("unit-limit");
            const detail = ["movie", "music"].includes(work.kind) ? work.catalog : await fetchCatalog(work, unit, controller.signal);
            if (work.catalog.totalUnits === null && detail.totalUnits !== null) work.catalog.totalUnits = detail.totalUnits;
            work.session = { unit, elapsedMs: 0, notes: detail.notes, sources: detail.sources, startedAt: at };
            work.status = "active";
          } else {
            work.session.elapsedMs += elapsed;
            if (work.session.elapsedMs >= SESSION_MINUTES[work.kind] * 60_000) {
              const { unit, notes } = work.session;
              work.history.push({ unit, at, notes, provenance: "simulation_from_sources" });
              work.history = work.history.slice(-500);
              work.completedUnits = unit;
              work.completedToday = work.progressDay === day ? (work.completedToday ?? 0) + 1 : 1;
              work.progressDay = day;
              work.session = null;
              work.status = work.catalog.totalUnits !== null && unit >= work.catalog.totalUnits ? "completed" : "ready";
            }
          }
        } else return;
        work.attempts = 0;
        work.retryAt = 0;
        delete work.error;
      } catch (error) {
        if (controller.signal.aborted || generation !== epoch) return;
        work.attempts = (work.attempts ?? 0) + 1;
        work.retryAt = at + work.attempts * 30 * 60_000;
        work.status = error.message === "ambiguous" || error.message === "identity" ? "needs_clarification" : "unavailable";
        work.error = work.status === "needs_clarification" ? "作品版本待确认" : "资料不足或搜索暂不可用";
        log.info("lookup deferred", { id: work.id, status: work.status, attempts: work.attempts });
      } finally {
        controller = null;
      }
      if (paused || generation !== epoch) return;
      work.updatedAt = at;
      await writeStore(db);
    });
  }

  function schedule() {
    if (!running || paused) return;
    timer = setTimer(async () => {
      try { await tick(); } catch (error) { log.warn("tick failed", { message: error?.message }); }
      schedule();
    }, MEDIA_TICK_MS);
    timer?.unref?.();
  }

  return {
    /** 只持久化队列；不在聊天/记忆整理的关键路径等网络。 */
    recommend(raw, userText, contextUserText = "") {
      const generation = epoch;
      return serialize(async () => {
        if (paused || generation !== epoch || !(await enabled())) return;
        const requests = normalizeMediaRequests(raw, userText, contextUserText);
        if (!requests.length) return;
        const db = await readStore();
        for (const request of requests) {
          const id = workKey(request);
          const existing = db.works.find((w) => w.id === id);
          if (existing) {
            if (existing.status === "unavailable") { existing.attempts = 0; existing.retryAt = 0; }
            continue;
          }
          const uncertain = db.works.find((w) => w.status === "needs_clarification" && w.kind === request.kind && w.title === request.title && (!w.year || w.year === request.year) && (!w.creator || w.creator === request.creator));
          if (uncertain) {
            Object.assign(uncertain, request, { id, status: "pending", catalog: null, attempts: 0, retryAt: 0 });
            continue;
          }
          if (db.works.length >= MAX_WORKS) break;
          db.works.push({ ...request, id, status: "pending", requestedAt: now(), updatedAt: now(), catalog: null, completedUnits: 0, session: null, history: [], attempts: 0, retryAt: 0 });
        }
        if (!paused && generation === epoch) await writeStore(db);
      });
    },
    tick,
    async context({ messages }) { return formatMediaContext(await readStore(), messages); },
    async lifeFacts() {
      const db = await readStore();
      return db.works.filter((w) => w.catalog && !["completed", "needs_clarification"].includes(w.status)).slice(0, 2).map((w) => `她收到了《${w.title}》的推荐，模拟已完成${w.completedUnits}段；可在空闲时安排接着看/读/听。不能把计划写成已完成，实际进度由记录推进。`);
    },
    status: readStore,
    start() { if (running) return; running = true; lastTick = null; schedule(); },
    pause() { paused = true; epoch += 1; lastTick = null; clearTimer(timer); timer = null; controller?.abort(); return serialize(() => undefined); },
    resume() { paused = false; lastTick = null; schedule(); },
    async stop() { running = false; await this.pause(); },
    idle: () => serialize(() => undefined),
  };
}
