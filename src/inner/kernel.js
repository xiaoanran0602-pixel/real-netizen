// ============================================================
// 身体内核的运行时（docs/14 第 6.3、7、8 节；merge-inner-engines design §4、§7）。唯一写入口，权威状态常驻内存。
//
//   kernel.accept(event)   统一的事件入口：去重、时效、epoch、预算，然后施加
//                          → accepted / duplicate / stale / conflict / invalid / unavailable
//   kernel.tick(now)       心跳：只做算术，不读日程文件、不联网、不调模型
//   kernel.snapshot(now)   只读投影，不改状态（含慢层 psyche、推算饱腹用的段、推算想念用的念头）
//   kernel.project(to)     只读投影到任意时刻，返回 body 副本（simulate 接口用）
//   kernel.checkpoint()    原子写 inner.json 的 body 子树（失败如实报告）
//   kernel.rebase(now)     回档后：epoch 递增、锚点设为现在、丢弃旧世界的异步结果
//
// 慢层（自我感觉、两条意志张力、生病、转折……）也只在这里写：日结算与进入时段由推进完成，
// 记忆整理、掷骰、写书转折、漏一句、调试强制都以事件进来，写进同一份事件日志。
//
// 持久化：事件先追加到 data/kernel-log.jsonl（recordType=kernel_event），再在内存里施加；
//         无事件时每 30 秒检查点一次；退出、暂停、回档前强制落盘。
//         重启：读检查点，重放 seq 更大的事件，再推进到现在。只容忍最后一行不完整；中段损坏报错停用。
// 迁移：body-v1（或只有旧版 vitals）在启动时升级到 body-v2，原 inner.json 备份一次（inner.legacy-backup.json）。
// 内核串行器里不等模型、不等网络（docs/14 第 8.3 节），避免和聊天队列互相卡死。
// ============================================================

import { paths } from "../config/paths.js";
import { appendText, createSerializer, fileExists, readJson, readText, writeJsonAtomic } from "../store/files.js";
import { createLogger } from "../util/log.js";
import { formatLocalDate, HOUR_MS, MINUTE_MS } from "../util/time.js";
import { advanceBody, driversAt, projectBody } from "./body-advance.js";
import { applyAppraisal, bandsOf, BODY_PARAMS, CHECKPOINT_INTERVAL_MS, clamp, createBody, heartRate } from "./body.js";
import { FORCED, migrateInner, parseKernelLog, payloadHash, validateEvent } from "./kernel-events.js";
import { applyPsycheEvents, canTurn, initialPsyche, markTurning, TURNING_THRESHOLD } from "./psyche.js";

export { EVENT_TYPES, FORCE_KINDS, FORCED, migrateInner, parseKernelLog, validateEvent } from "./kernel-events.js";

const log = createLogger("kernel");
export const DEDUP_KEEP_MS = 7 * 24 * HOUR_MS;
/** 评价晚到 30 分钟以内：按半衰期折减后施加；超过只补记，不制造尖峰（docs/14 第 6.3 节）。 */
export const LATE_APPRAISAL_MS = 30 * MINUTE_MS;
const SUMMARY_INTERVAL_MS = 30 * MINUTE_MS;

const dayOf = (ms) => formatLocalDate(new Date(ms));

/** 有旧版字段时把原 inner.json 复制一份；已存在就不覆盖。 */
async function backupLegacy(file) {
  if (!file?.vitals && !file?.tensions) return false;
  if (await fileExists(paths.innerLegacyBackup())) return false;
  await writeJsonAtomic(paths.innerLegacyBackup(), file);
  return true;
}

/**
 * @param {{
 *   loadTimeline: (now: number) => Promise<{segments: any[], world: any, city: string, thoughts: any[], sickMissCap?: number, thoughtsEnabled?: boolean}>,
 *   now?: () => number,
 * }} deps
 */
export function createKernel(deps) {
  const now = deps.now ?? (() => Date.now());
  const serialize = createSerializer();
  let body = null;
  let timeline = { segments: [], world: null, city: "", thoughts: [] };
  let status = "recovering";
  let lastCheckpointAt = 0;
  let lastSummaryAt = 0;
  let dirty = false;
  let degraded = null;

  async function writeCheckpoint() {
    const current = await readJson(paths.inner(), {});
    try {
      await writeJsonAtomic(paths.inner(), { ...current, body });
      lastCheckpointAt = now();
      dirty = false;
      degraded = null;
      return { ok: true };
    } catch (error) {
      // 保留内存与已提交的日志，但如实报告降级，不装作已保存。
      degraded = "checkpoint-failed";
      log.warn("checkpoint failed", { error: error?.message });
      return { ok: false, error: error?.message };
    }
  }

  function advanceTo(toMs) {
    if (!body || toMs <= body.at) return;
    const { body: next, catchupMode } = advanceBody(body, toMs, timeline);
    body = next;
    if (catchupMode === "coarse") log.info("catch-up approximated", { hours: Math.round((toMs - body.at) / HOUR_MS) });
  }

  function remember(event, hash, acceptedAt) {
    body.dedup = [...(body.dedup ?? []).filter((entry) => acceptedAt - entry.acceptedAt <= DEDUP_KEEP_MS), { id: event.id, hash, acceptedAt }];
  }

  /** 把一个已校验的事件施加到内存状态（重放与正常接受共用）。 */
  function applyEvent(event) {
    switch (event.type) {
      case "chat_appraisal": {
        if (event.payload === null) return { applied: null };
        let appraisal = event.payload;
        const age = Math.max(0, (event.acceptedAt ?? event.occurredAt) - (event.payload.perceivedAt ?? event.occurredAt));
        if (age > LATE_APPRAISAL_MS) return { applied: null, reason: "late" };
        if (age > 0) {
          // 晚到的评价：各维度按自己的半衰期折减（明确的近似，不假装重新经历历史）。
          const fade = (key, half) => appraisal[key] * 2 ** (-age / MINUTE_MS / half);
          appraisal = { ...appraisal, valence: fade("valence", BODY_PARAMS.halfLifeMin.V), activation: fade("activation", BODY_PARAMS.halfLifeMin.A), tension: fade("tension", BODY_PARAMS.halfLifeMin.T) };
        }
        const result = applyAppraisal(body, appraisal, event.acceptedAt ?? event.occurredAt);
        body = result.body;
        return { applied: result.applied };
      }
      case "schedule_adopted":
        timeline = { ...timeline, segments: event.payload?.segments ?? timeline.segments };
        body.inputVersions = { ...body.inputVersions, schedule: event.payload?.version ?? body.inputVersions.schedule };
        return { applied: null };
      case "weather_observed":
        timeline = { ...timeline, world: event.payload?.world ?? timeline.world, city: event.payload?.city ?? timeline.city };
        body.inputVersions = { ...body.inputVersions, weather: event.payload?.observedAt ?? body.inputVersions.weather };
        return { applied: null };
      case "thoughts_changed":
        timeline = { ...timeline, thoughts: event.payload?.thoughts ?? timeline.thoughts };
        body.inputVersions = { ...body.inputVersions, thoughts: event.payload?.version ?? body.inputVersions.thoughts };
        return { applied: null };
      case "psyche_events": {
        const result = applyPsycheEvents(body.psyche, event.payload, event.acceptedAt ?? event.occurredAt);
        body = { ...body, psyche: result.psyche };
        return { applied: result.changes, ...(result.turning ? { turning: result.turning } : {}) };
      }
      case "condition_set": {
        const psyche = { ...body.psyche };
        if ("condition" in event.payload) psyche.condition = event.payload.condition ? { ...event.payload.condition } : null;
        if (event.payload.diceDay) psyche.diceDay = event.payload.diceDay;
        body = { ...body, psyche };
        return { applied: { condition: psyche.condition } };
      }
      case "turning": {
        // 写书的转折（日程生成前）：释放量为 0，实际释放由日程里的「写作」时段完成。
        if (!canTurn(body.psyche, "book", event.payload.day) || body.psyche.book < TURNING_THRESHOLD) return { applied: null, reason: "not-due" };
        body = { ...body, psyche: markTurning(body.psyche, "book", event.payload.day, 0, event.acceptedAt ?? event.occurredAt) };
        return { applied: { turning: "book" } };
      }
      case "leak_offered":
        body = { ...body, psyche: { ...body.psyche, leakOfferedAt: event.payload.at } };
        return { applied: { leakOfferedAt: event.payload.at } };
      case "force":
        return applyForce(event.payload.event, event.acceptedAt ?? event.occurredAt);
      default:
        // message_perceived：只登记感知时间；delivery_confirmed：由念头池释放，身体从池的新版本感知。
        return { applied: null };
    }
  }

  /** 调试强制：张力、压力（张力 T）、困（精力 E）、喝酒。 */
  function applyForce(kind, at) {
    const values = { ...body.values };
    const psyche = { ...body.psyche };
    if (kind === "tension:book") psyche.book = FORCED.tension;
    if (kind === "tension:seen") psyche.seen = FORCED.tension;
    if (kind === "stress") values.tension = clamp(FORCED.stress, 0, 100);
    if (kind === "tired") values.energy = clamp(FORCED.energy, 0, 100);
    if (kind === "drink") psyche.lastDrinkAt = at;
    body = { ...body, values, psyche, bands: bandsOf(values, body.bands) };
    return { applied: { force: kind } };
  }

  return {
    /** 启动：读检查点（必要时迁移到 v2 并备份旧文件）、重放日志、推进到现在。 */
    start: () =>
      serialize(async () => {
        timeline = await deps.loadTimeline(now());
        const file = await readJson(paths.inner(), {});
        const migration = migrateInner(file, now(), timeline);
        if (!migration) {
          status = "unavailable";
          log.warn("unknown params version, kernel disabled", { version: file?.body?.paramsVersion });
          return { status };
        }
        body = migration.body;
        if (migration.migrated !== "none") {
          const backedUp = await backupLegacy(file).catch((error) => (log.warn("legacy backup failed", { error: error?.message }), false));
          log.info("inner state migrated to body-v2", { from: migration.migrated, backedUp });
        }
        let rows;
        try {
          rows = parseKernelLog(await readText(paths.kernelLog()));
        } catch (error) {
          status = "unavailable";
          log.error("kernel log corrupted, not replaying", { error: error?.message });
          return { status };
        }
        for (const row of rows) {
          if (row.recordType !== "kernel_event" || row.seq <= body.lastEventSeq) continue;
          if (row.epoch !== body.epoch) continue;
          if (validateEvent(row)) continue;
          advanceTo(row.acceptedAt);
          applyEvent(row);
          body.lastEventSeq = row.seq;
          remember(row, row.payloadHash, row.acceptedAt);
        }
        advanceTo(now());
        status = "ready";
        await writeCheckpoint();
        return { status, migrated: migration.migrated };
      }),

    /**
     * 唯一的事件入口。
     * @param {{id: string, type: string, epoch?: number, occurredAt: number, payload: any}} event
     */
    accept: (event) =>
      serialize(async () => {
        if (status !== "ready" || !body) return { result: "unavailable" };
        const problem = validateEvent(event);
        if (problem) return { result: "invalid", reason: problem };
        if (event.epoch !== undefined && event.epoch !== body.epoch) return { result: "stale", reason: "epoch" };
        const acceptedAt = Math.max(now(), body.at);
        if (acceptedAt - event.occurredAt > DEDUP_KEEP_MS) return { result: "stale", reason: "too-old" };
        const hash = payloadHash(event.payload);
        const seen = (body.dedup ?? []).find((entry) => entry.id === event.id);
        if (seen) return seen.hash === hash ? { result: "duplicate" } : { result: "conflict" };
        const seq = (body.lastEventSeq ?? 0) + 1;
        const record = { recordType: "kernel_event", id: event.id, type: event.type, epoch: body.epoch, paramsVersion: BODY_PARAMS.version, occurredAt: event.occurredAt, acceptedAt, seq, payloadHash: hash, payload: event.payload };
        try {
          await appendText(paths.kernelLog(), `${JSON.stringify(record)}\n`);
        } catch (error) {
          // 日志失败不确认该事件；上游可按同 ID 重试。
          return { result: "unavailable", reason: error?.message };
        }
        advanceTo(acceptedAt);
        const { applied, reason, turning } = applyEvent(record);
        body.lastEventSeq = seq;
        remember(record, hash, acceptedAt);
        dirty = true;
        await writeCheckpoint();
        return { result: "accepted", seq, applied, ...(reason ? { reason } : {}), ...(turning ? { turning } : {}) };
      }),

    /** 心跳：推进到现在；无事件时每 30 秒落一次检查点；每 30 分钟写一条状态摘要。 */
    tick: () =>
      serialize(async () => {
        if (status !== "ready" || !body) return null;
        const at = now();
        // 时钟倒退：不倒退状态时间，不结算负时长，记录异常（docs/14 第 7.3 节）。
        if (at < body.at) {
          log.warn("clock went backwards", { by: body.at - at });
          return body;
        }
        advanceTo(at);
        dirty = true;
        if (at - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) await writeCheckpoint();
        if (at - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
          lastSummaryAt = at;
          await appendText(paths.kernelLog(), `${JSON.stringify({ recordType: "summary", at, epoch: body.epoch, values: body.values })}\n`).catch(() => undefined);
        }
        return body;
      }),

    /**
     * 只读快照：投影到 now，不改状态（docs/14 第 7.2 节第 5 条）。
     * 带上慢层 psyche、推算饱腹用的段、推算想念用的念头（派生读数由 express 现算）。
     */
    snapshot(nowMs = now()) {
      if (!body) return { status: degraded ?? status, values: null };
      const projected = nowMs > body.at ? projectBody(body, nowMs, timeline) : body;
      const drivers = driversAt(timeline, nowMs, projected.psyche);
      return {
        status: degraded ?? status,
        epoch: projected.epoch,
        seq: projected.lastEventSeq,
        at: nowMs,
        values: { ...projected.values },
        bands: { ...projected.bands },
        psyche: structuredClone(projected.psyche),
        segments: timeline.segments ?? [],
        thoughts: timeline.thoughtsEnabled === false ? [] : timeline.thoughts ?? [],
        sickMissCap: timeline.sickMissCap,
        derived: { heartRate: heartRate(projected.values, { asleep: drivers.asleep, physical: drivers.physical }), asleep: drivers.asleep, tag: drivers.segment?.tag ?? null },
        stale: nowMs - body.at > 5 * MINUTE_MS,
      };
    },

    /** 只读投影到任意时刻：返回 body 副本（simulate 接口用），不提交事件、不改权威状态。 */
    project(toMs) {
      if (!body) return null;
      const projected = toMs > body.at ? projectBody(structuredClone(body), toMs, timeline) : structuredClone(body);
      return { ...projected, segments: timeline.segments ?? [], thoughts: timeline.thoughtsEnabled === false ? [] : timeline.thoughts ?? [], sickMissCap: timeline.sickMissCap };
    },

    /** 刷新输入（日程、天气、念头）——由独立任务调用，再走 accept 记成事件。 */
    timeline: () => timeline,
    checkpoint: () => serialize(writeCheckpoint),

    /**
     * 回档：epoch = max(暂停前, 恢复快照) + 1，锚点设为现在，丢弃旧异步结果（docs/14 第 8.3 节）。
     * 回档后的 inner.json 若只有旧格式，走同一条迁移；closedDay 一律设为今天。
     */
    rebase: () =>
      serialize(async () => {
        timeline = await deps.loadTimeline(now());
        const file = await readJson(paths.inner(), {});
        const restored = file?.body;
        const epoch = Math.max(body?.epoch ?? 1, restored?.epoch ?? 1) + 1;
        const migration = migrateInner(file, now(), timeline);
        if (migration && migration.migrated !== "none") await backupLegacy(file).catch(() => false);
        const base = migration?.body ?? createBody(now());
        const today = dayOf(now());
        const psyche = { ...(base.psyche ?? initialPsyche()), closedDay: today, lastSlotId: driversAt(timeline, now()).segment?.slotId ?? base.psyche?.lastSlotId ?? null };
        body = { ...base, at: now(), epoch, dedup: [], impulseWindow: [], psyche };
        status = "ready";
        await appendText(paths.kernelLog(), `${JSON.stringify({ recordType: "rebase", at: now(), epoch })}\n`).catch(() => undefined);
        await writeCheckpoint();
        return { epoch };
      }),

    /** 输入刷新（独立任务调用，不在心跳临界区）。 */
    refreshTimeline: () =>
      serialize(async () => {
        timeline = await deps.loadTimeline(now());
        return timeline;
      }),

    status: () => degraded ?? status,
    epoch: () => body?.epoch ?? 0,
  };
}
