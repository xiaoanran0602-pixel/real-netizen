// ============================================================
// 持续情绪与身体式内核（docs/14）——纯计算部分。
// 四个状态：愉悦度 V、激活度 A、精力 E、张力 T。模拟心率 H 是派生读数，不反向控制。
//
// 施工纪律（docs/14 第 5、7 节）：
//   - 所有右侧都用「本小段开始时」的同一份状态计算，不更新一个数后立刻拿新值算另一个。
//   - 目标按半衰期向目标靠近（差值减半），不是「每 90 分钟数值减半」。
//   - 时间用分钟，精力速率点/小时；内部保留浮点，展示时取整。
//   - 计算网格固定 5 秒：5 秒心跳、15 秒心跳、离线补算走同一条路径，结果与调度频率无关。
// 本文件不读盘、不调模型、不联网（docs/14 第 7.1 节：心跳只做算术）。
// ============================================================

import { formatLocalDate, HOUR_MS, MINUTE_MS } from "../util/time.js";
import { initialPsyche } from "./psyche.js";

/** 计算网格（毫秒）。调度频率可以改，网格不改（docs/14 第 7.2 节）。 */
export const GRID_MS = 5_000;
/** 离线补算：超过这个时长，较早的部分用 60 秒网格近似。 */
export const COARSE_AFTER_MS = 72 * HOUR_MS;
export const COARSE_GRID_MS = 60_000;
/** 无事件时的检查点间隔。 */
export const CHECKPOINT_INTERVAL_MS = 30_000;
/** 扰动的滑动预算窗口。 */
export const IMPULSE_WINDOW_MS = 10 * MINUTE_MS;
export const BUDGET = Object.freeze({ V: 24, A: 30, T: 24 });
const HALF_LIFE_MIN = Object.freeze({ V: 90, A: 8, T: 60 });
const E_MAX_RATE_UP = 5;
const INITIAL = Object.freeze({ valence: 8, activation: 25, energy: 70, tension: 10 });

/** 参数集中在一个版本化对象里；模型不能改它（docs/14 第 3.1、13 节）。 */
export const BODY_PARAMS = Object.freeze({
  version: "body-v2",
  initial: INITIAL,
  halfLifeMin: HALF_LIFE_MIN,
  gridMs: GRID_MS,
  /** 标签 → 负荷 / 恢复 / 体力（docs/14 第 4.1 节的表）。 */
  tags: Object.freeze({
    起床: { load: 0, recovery: 0.2, physical: 0 },
    空闲: { load: 0, recovery: 0.2, physical: 0 },
    睡觉: { load: 0, recovery: 0, physical: 0 },
    吃饭: { load: 0, recovery: 0.6, physical: 0 },
    上班: { load: 0.65, recovery: 0, physical: 0 },
    写作: { load: 0.65, recovery: 0, physical: 0 },
    加班: { load: 0.9, recovery: 0, physical: 0 },
    截止: { load: 0.9, recovery: 0, physical: 0 },
    开会: { load: 0.75, recovery: 0, physical: 0 },
    运动: { load: 0.3, recovery: 0, physical: 0.85 },
    通勤: { load: 0.25, recovery: 0, physical: 0.25 },
    出门: { load: 0.25, recovery: 0, physical: 0.25 },
    洗澡: { load: 0, recovery: 0.5, physical: 0.1 },
    天文台: { load: 0.35, recovery: 0.1, physical: 0.1 },
    喝酒: { load: 0, recovery: 0.5, physical: 0 },
    生病: { load: 0, recovery: 0.5, physical: 0 },
  }),
  /** 天气偏好：默认全 0，不默认「阴天必然难过」（docs/14 第 4.3 节）。 */
  weatherPreference: Object.freeze({ clear: 2, cloudy: 0, overcast: -1, rain: -2, snow: -1, fog: -1, wind: 0, storm: -3 }),
  /** 表现档位的进入/退出阈值（滞回，docs/14 第 9.2 节；merge-inner-engines design §6）。 */
  bands: Object.freeze({
    tired: [55, 60],
    exhausted: [25, 30],
    hungry: [30, 35],
    highActivation: [65, 55],
    highTension: [65, 55],
    relaxedValence: [20, 15],
    subduedValence: [-20, -15],
  }),
  /** 饥饿：饱腹低于 30 时按程度把愉悦目标最多下调 6、张力目标最多上调 6。 */
  hunger: Object.freeze({ from: 30, valence: 6, tension: 6 }),
  heart: Object.freeze({ base: 58, activation: 0.35, tension: 0.1, physical: 35, asleep: 6, min: 48, max: 130 }),
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const VALENCE_RANGE = [-100, 100];

export function paramTag(tag) {
  return BODY_PARAMS.tags[tag] ?? { load: 0.25, recovery: 0, physical: 0.1 };
}

/**
 * 内核的初始状态。E/T 可以从旧版迁移（docs/14 第 10.2 节）；psyche 是慢层（merge-inner-engines design §2）。
 * @param {number} atMs
 * @param {{energy?: number, tension?: number, activation?: number, valence?: number, psyche?: any}} [seed]
 */
export function createBody(atMs, seed = {}) {
  const energy = Number.isFinite(seed.energy) ? clamp(seed.energy, 0, 100) : INITIAL.energy;
  const tension = Number.isFinite(seed.tension) ? clamp(seed.tension, 0, 100) : INITIAL.tension;
  const activation = Number.isFinite(seed.activation) ? clamp(seed.activation, 0, 100) : clamp(25 + 0.3 * (tension - 30), 0, 100);
  const valence = Number.isFinite(seed.valence) ? clamp(seed.valence, ...VALENCE_RANGE) : INITIAL.valence;
  return {
    schemaVersion: 2,
    paramsVersion: BODY_PARAMS.version,
    at: atMs,
    values: { valence, activation, energy, tension },
    segment: null,
    lastEventSeq: 0,
    epoch: 1,
    inputVersions: { schedule: 0, weather: 0, thoughts: 0 },
    dedup: [],
    impulseWindow: [],
    bands: bandsOf({ valence, activation, energy, tension }, {}),
    psyche: seed.psyche ?? initialPsyche({ day: formatLocalDate(new Date(atMs)) }),
  };
}

/**
 * 目标与速率（docs/14 第 5.1 节）。全部用同一份 values 计算。
 * 合并引擎加了两项中层修正：生病/加班周/假期的消耗倍率与精力上限（condition），饥饿（hunger ∈ [0,1]）。
 * @param {{valence: number, activation: number, energy: number, tension: number}} values
 * @param {{load: number, recovery: number, physical: number, interest: number, asleep: boolean, weather: number, thoughtLoad: number, expectedLoad: number, condition?: {drain?: number, energyCap?: number} | null, hunger?: number}} input
 */
export function targetsOf(values, input) {
  const { load: L = 0, recovery: R = 0, physical: P = 0, interest: I = 0 } = input;
  const { activation: A, energy: E, tension: T } = values;
  const energyCap = clamp(input.condition?.energyCap ?? 100, 0, 100);
  const H = clamp(input.hunger ?? 0, 0, 1);
  const hungerV = BODY_PARAMS.hunger.valence * H;
  const hungerT = BODY_PARAMS.hunger.tension * H;
  if (input.asleep) {
    const tensionTarget = clamp(6 + 6 * (input.thoughtLoad ?? 0) + hungerT, 0, 100);
    const activationTarget = clamp(8 + 0.1 * T, 0, 100);
    const valenceTarget = clamp(8 + (input.weather ?? 0) + 5 * I - 0.25 * Math.max(0, tensionTarget - 15) - hungerV, ...VALENCE_RANGE);
    return {
      tension: tensionTarget,
      activation: activationTarget,
      valence: valenceTarget,
      energyRatePerHour: 12 * (1 - (0.4 * A) / 100),
      energyCap,
    };
  }
  const D = clamp((40 - E) / 40, 0, 1);
  const U = clamp(input.thoughtLoad ?? 0, 0, 1);
  const F = clamp(input.expectedLoad ?? 0, 0, 1);
  const tensionTarget = clamp(10 + 25 * L + 18 * U + 8 * F + 8 * D + hungerT, 0, 100);
  const activationTarget = clamp(22 + 28 * L + 32 * P + 10 * F + 0.15 * T - 8 * (1 - E / 100), 0, 100);
  const valenceTarget = clamp(8 + (input.weather ?? 0) + 5 * I - 0.25 * Math.max(0, T - 15) - 0.1 * Math.max(0, 40 - E) - hungerV, ...VALENCE_RANGE);
  let energyRatePerHour = clamp(E_MAX_RATE_UP * R - 2 - 4 * L - 4 * P - 2 * Math.max(0, (A - 50) / 50), -30, 30);
  // 清醒时的消耗：感冒、加班周 ×1.3，假期 ×0.8；恢复不受影响。
  if (energyRatePerHour < 0) energyRatePerHour *= input.condition?.drain ?? 1;
  return { tension: tensionTarget, activation: activationTarget, valence: valenceTarget, energyRatePerHour, energyCap };
}

/** 目标不变时推进一小段（docs/14 第 5.2 节）：差值按半衰期减半，精力按速率线性，并夹在精力上限以下。 */
export function stepWithTargets(values, targets, minutes, halfLifeMin = BODY_PARAMS.halfLifeMin) {
  const decay = (value, target, halfLife) => (halfLife > 0 ? target + (value - target) * 2 ** (-minutes / halfLife) : target);
  const cap = clamp(targets.energyCap ?? 100, 0, 100);
  return {
    valence: clamp(decay(values.valence, targets.valence, halfLifeMin.V), ...VALENCE_RANGE),
    activation: clamp(decay(values.activation, targets.activation, halfLifeMin.A), 0, 100),
    tension: clamp(decay(values.tension, targets.tension, halfLifeMin.T), 0, 100),
    energy: clamp(values.energy + (targets.energyRatePerHour * minutes) / 60, 0, cap),
  };
}

export function heartRate(values, { asleep = false, physical = 0 } = {}) {
  const H = BODY_PARAMS.heart;
  const raw = H.base + H.activation * values.activation + H.tension * values.tension + H.physical * physical - (asleep ? H.asleep : 0);
  return Math.round(clamp(raw, H.min, H.max));
}

/**
 * 档位（带滞回，docs/14 第 9.2 节）。读的时候只投影副本，不改权威档位。
 * tired / exhausted 看精力（低于进入值进入、高于退出值退出），hungry 看派生饱腹（不传就不变）。
 * @param {{valence: number, activation: number, energy: number, tension: number}} values
 * @param {any} previous 上一次的档位
 * @param {{fullness?: number}} [derived]
 */
export function bandsOf(values, previous = {}, derived = {}) {
  const B = BODY_PARAMS.bands;
  const low = (value, [enter, exit], was) => (value < enter ? true : value > exit ? false : Boolean(was));
  const tired = low(values.energy, B.tired, previous?.tired);
  const exhausted = low(values.energy, B.exhausted, previous?.exhausted);
  const hungry = Number.isFinite(derived?.fullness) ? low(derived.fullness, B.hungry, previous?.hungry) : Boolean(previous?.hungry);
  const highActivation = values.activation > B.highActivation[0] ? true : values.activation < B.highActivation[1] ? false : Boolean(previous?.highActivation);
  const highTension = values.tension > B.highTension[0] ? true : values.tension < B.highTension[1] ? false : Boolean(previous?.highTension);
  let valence = previous?.valence ?? "neutral";
  if (values.valence > B.relaxedValence[0]) valence = "relaxed";
  else if (values.valence < B.subduedValence[0]) valence = "subdued";
  else if (valence === "relaxed" && values.valence < B.relaxedValence[1]) valence = "neutral";
  else if (valence === "subdued" && values.valence > B.subduedValence[1]) valence = "neutral";
  return { tired, exhausted, hungry, highActivation, highTension, valence };
}

/**
 * 扰动权重（docs/14 第 6.2 节）：q = importance × confidence × (0.5 + 0.5 × surprise)。
 */
export function appraisalWeight(appraisal) {
  const importance = clamp(Number(appraisal?.importance) || 0, 0, 1);
  const confidence = clamp(Number(appraisal?.confidence) || 0, 0, 1);
  const surprise = clamp(Number(appraisal?.surprise) || 0, 0, 1);
  if (confidence < 0.6 || importance < 0.15) return 0;
  return clamp(importance * confidence * (0.5 + 0.5 * surprise), 0, 1);
}

/** 未缩放的三维扰动。 */
export function appraisalDelta(appraisal) {
  const q = appraisalWeight(appraisal);
  const dir = (key) => clamp(Number(appraisal?.[key]) || 0, -1, 1);
  return { valence: 18 * q * dir("valence"), activation: 22 * q * dir("activation"), tension: 18 * q * dir("tension") };
}

/**
 * 施加扰动：先按 10 分钟滑动预算整体缩放（三个维度取最小可用比例），再夹取。
 * 预算记录按缩放后的扰动计，不能靠顶满数值绕过限额（docs/14 第 6.2 节）。
 * @param {any} body
 * @param {any} appraisal
 * @param {number} atMs
 */
export function applyAppraisal(body, appraisal, atMs) {
  const next = { ...body, values: { ...body.values }, impulseWindow: [...(body.impulseWindow ?? [])], bands: body.bands };
  const delta = appraisalDelta(appraisal);
  const used = { V: 0, A: 0, T: 0 };
  for (const entry of next.impulseWindow) {
    if (atMs - entry.at > IMPULSE_WINDOW_MS) continue;
    used.V += Math.abs(entry.delta.valence ?? 0);
    used.A += Math.abs(entry.delta.activation ?? 0);
    used.T += Math.abs(entry.delta.tension ?? 0);
  }
  let ratio = 1;
  const pairs = [["V", delta.valence], ["A", delta.activation], ["T", delta.tension]];
  for (const [key, value] of pairs) {
    if (!value) continue;
    ratio = Math.min(ratio, Math.max(0, BUDGET[key] - used[key]) / Math.abs(value));
  }
  ratio = clamp(ratio, 0, 1);
  const scaled = { valence: delta.valence * ratio, activation: delta.activation * ratio, tension: delta.tension * ratio };
  next.values.valence = clamp(next.values.valence + scaled.valence, ...VALENCE_RANGE);
  next.values.activation = clamp(next.values.activation + scaled.activation, 0, 100);
  next.values.tension = clamp(next.values.tension + scaled.tension, 0, 100);
  next.impulseWindow = [...next.impulseWindow.filter((entry) => atMs - entry.at <= IMPULSE_WINDOW_MS), { at: atMs, delta: scaled }];
  next.bands = bandsOf(next.values, next.bands);
  return { body: next, applied: scaled, ratio };
}

/** 时钟倒退或异常：不结算负时长（docs/14 第 7.3 节）。 */
export function safeFrom(bodyAt, toMs) {
  return Math.max(bodyAt, Math.min(bodyAt, toMs));
}

export { clamp, INITIAL, VALENCE_RANGE };
