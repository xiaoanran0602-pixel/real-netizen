// ============================================================
// 身体内核的运行时（docs/14 第 6.3、7、8 节）。唯一写入口，权威状态常驻内存。
//
//   kernel.accept(event)   统一的事件入口：去重、时效、epoch、预算，然后施加
//                          → accepted / duplicate / stale / conflict / invalid / unavailable
//   kernel.tick(now)       心跳：只做算术，不读日程文件、不联网、不调模型
//   kernel.snapshot(now)   只读投影，不改状态
//   kernel.checkpoint()    原子写 inner.json 的 body 子树（失败如实报告）
//   kernel.rebase(now)     回档后：epoch 递增、锚点设为现在、丢弃旧世界的异步结果
//
// 持久化：事件先追加到 data/kernel-log.jsonl（recordType=kernel_event），再在内存里施加；
//         无事件时每 30 秒检查点一次；退出、暂停、回档前强制落盘。
//         重启：读检查点，重放 seq 更大的事件，再推进到现在。只容忍最后一行不完整；中段损坏报错停用。
// 内核串行器里不等模型、不等网络（docs/14 第 8.3 节），避免和聊天队列互相卡死。
// ============================================================

import { createHash } from "node:crypto";
import { paths } from "../config/paths.js";
import { appendText, createSerializer, readJson, readText, writeJsonAtomic } from "../store/files.js";
import { createLogger } from "../util/log.js";
import { HOUR_MS, MINUTE_MS } from "../util/time.js";
import { advanceBody, projectBody } from "./body-advance.js";
import { applyAppraisal, BODY_PARAMS, CHECKPOINT_INTERVAL_MS, createBody, heartRate } from "./body.js";
import { driversAt } from "./body-advance.js";

const log = createLogger("kernel");
export const EVENT_TYPES = Object.freeze(["message_perceived", "chat_appraisal", "schedule_adopted", "weather_observed", "thoughts_changed", "delivery_confirmed"]);
export const DEDUP_KEEP_MS = 7 * 24 * HOUR_MS;
/** 评价晚到 30 分钟以内：按半衰期折减后施加；超过只补记，不制造尖峰（docs/14 第 6.3 节）。 */
export const LATE_APPRAISAL_MS = 30 * MINUTE_MS;
const SUMMARY_INTERVAL_MS = 30 * MINUTE_MS;

function payloadHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex").slice(0, 16);
}

/**
 * 校验事件形状（外部边界只验一次，docs/14 第 8.2 节）。
 * @returns {string | null} 错误原因
 */
export function validateEvent(event) {
  if (!event || typeof event !== "object") return "not-object";
  if (typeof event.id !== "string" || !event.id) return "no-id";
  if (!EVENT_TYPES.includes(event.type)) return "unknown-type";
  if (!Number.isFinite(event.occurredAt)) return "no-time";
  if (event.type === "chat_appraisal" && event.payload !== null) {
    const p = event.payload;
    if (!p || typeof p !== "object") return "bad-appraisal";
    for (const key of ["valence", "activation", "tension"]) if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < -1 || p[key] > 1) return `bad-${key}`;
    for (const key of ["importance", "confidence", "surprise"]) if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1) return `bad-${key}`;
  }
  return null;
}

/** 解析事件日志：只容忍最后一行不完整（docs/14 第 8.1 节）。 */
export function parseKernelLog(text) {
  const lines = (text ?? "").split("\n");
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      const tail = lines.slice(index + 1).every((rest) => !rest.trim());
      if (tail) break;
      throw Object.assign(new Error(`kernel log corrupted at line ${index + 1}`), { kind: "corrupted" });
    }
  }
  return rows;
}

/**
 * @param {{
 *   loadTimeline: (now: number) => Promise<{segments: any[], world: any, city: string, thoughts: any[]}>,
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
      default:
        // message_perceived：只登记感知时间；delivery_confirmed：由念头池释放，身体从池的新版本感知。
        return { applied: null };
    }
  }

  return {
    /** 启动：读检查点、重放日志、推进到现在。 */
    start: () =>
      serialize(async () => {
        timeline = await deps.loadTimeline(now());
        const saved = (await readJson(paths.inner(), {}))?.body;
        const legacy = await readJson(paths.inner(), {});
        if (saved?.schemaVersion === 1 && saved.paramsVersion === BODY_PARAMS.version) body = saved;
        else if (saved && saved.paramsVersion !== BODY_PARAMS.version) {
          status = "unavailable";
          log.warn("unknown params version, kernel disabled", { version: saved.paramsVersion });
          return { status };
        } else {
          // 首次：从旧版迁移 E/T（docs/14 第 10.2 节），不把旧「想念」转换成不快。
          body = createBody(now(), { energy: legacy?.vitals?.energy, tension: legacy?.vitals?.stress });
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
          advanceTo(row.acceptedAt);
          applyEvent(row);
          body.lastEventSeq = row.seq;
          remember(row, row.payloadHash, row.acceptedAt);
        }
        advanceTo(now());
        status = "ready";
        await writeCheckpoint();
        return { status };
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
        const { applied, reason } = applyEvent(record);
        body.lastEventSeq = seq;
        remember(record, hash, acceptedAt);
        dirty = true;
        await writeCheckpoint();
        return { result: "accepted", seq, applied, ...(reason ? { reason } : {}) };
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

    /** 只读快照：投影到 now，不改状态（docs/14 第 7.2 节第 5 条）。 */
    snapshot(nowMs = now()) {
      if (!body) return { status, values: null };
      const projected = nowMs > body.at ? projectBody(body, nowMs, timeline) : body;
      const drivers = driversAt(timeline, nowMs);
      return {
        status: degraded ?? status,
        epoch: projected.epoch,
        seq: projected.lastEventSeq,
        at: nowMs,
        values: { ...projected.values },
        bands: { ...projected.bands },
        derived: { heartRate: heartRate(projected.values, { asleep: drivers.asleep, physical: drivers.physical }), asleep: drivers.asleep, tag: drivers.segment?.tag ?? null },
        stale: nowMs - body.at > 5 * MINUTE_MS,
      };
    },

    /** 刷新输入（日程、天气、念头）——由独立任务调用，再走 accept 记成事件。 */
    timeline: () => timeline,
    checkpoint: () => serialize(writeCheckpoint),

    /** 回档：epoch = max(暂停前, 恢复快照) + 1，锚点设为现在，丢弃旧异步结果（docs/14 第 8.3 节）。 */
    rebase: () =>
      serialize(async () => {
        const restored = (await readJson(paths.inner(), {}))?.body;
        const epoch = Math.max(body?.epoch ?? 1, restored?.epoch ?? 1) + 1;
        body = { ...(restored?.schemaVersion === 1 ? restored : createBody(now())), at: now(), epoch, dedup: [], impulseWindow: [] };
        timeline = await deps.loadTimeline(now());
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
