// 14 身体内核：四维状态、驱动、分段推进、扰动限幅、心率、档位滞回，以及 12.1 的例算。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MINUTE_MS } from "../src/util/time.js";
import { advanceBody, driversAt, projectBody } from "../src/inner/body-advance.js";
import { normalizeSchedule, closeSegments, expectedLoad, thoughtLoad, weatherLoad, WEATHER_FRESH_MS, WEATHER_MAX_AGE_MS } from "../src/inner/body-drivers.js";
import { applyAppraisal, appraisalWeight, bandsOf, BODY_PARAMS, createBody, heartRate, stepWithTargets, targetsOf } from "../src/inner/body.js";
import { at } from "./helpers.js";

const DAY = "2026-10-10";
const DAY0 = at(2026, 10, 10, 0, 0).getTime();

function timelineOf(slots, extra = {}) {
  const segments = closeSegments(normalizeSchedule(slots, { date: DAY, adoptedAt: DAY0, version: 1 }));
  return { segments, world: null, city: "上海", thoughts: [], ...extra };
}

test("初始状态与心率：E/T 可从旧版迁移；心率是派生读数、不反向控制", () => {
  const body = createBody(DAY0, { energy: 55, tension: 80 });
  assert.equal(body.values.energy, 55);
  assert.equal(body.values.tension, 80);
  assert.equal(body.values.activation, 25 + 0.3 * 50);
  assert.equal(heartRate({ valence: 0, activation: 25, energy: 70, tension: 10 }, { asleep: false }), 68, "58 + 0.35×25 + 0.1×10 取整");
  assert.ok(heartRate({ valence: 0, activation: 25, energy: 70, tension: 10 }, { asleep: true }) < 68, "睡着时更低");
  assert.ok(heartRate({ valence: 0, activation: 100, energy: 100, tension: 100, physical: 1 }, { physical: 1 }) <= 130);
});

test("固定目标衰减：8 分钟后激活的额外差值减半，90 分钟后愉悦的额外差值减半", () => {
  const targets = targetsOf({ valence: 8, activation: 25, energy: 70, tension: 10 }, { asleep: false, weather: 0, thoughtLoad: 0, expectedLoad: 0 });
  const hit = { valence: 17.72, activation: 32.128, energy: 70, tension: 5.14 };
  const after8 = stepWithTargets(hit, targets, 8);
  assert.ok(Math.abs(after8.activation - targets.activation - (hit.activation - targets.activation) / 2) < 1e-9);
  const after90 = stepWithTargets(hit, targets, 90);
  assert.ok(Math.abs(after90.valence - targets.valence - (hit.valence - targets.valence) / 2) < 1e-9);
  const after60 = stepWithTargets(hit, targets, 60);
  assert.ok(Math.abs(after60.tension - targets.tension - (hit.tension - targets.tension) / 2) < 1e-9);
});

test("12.1 的例算：q=0.54、ΔV=9.72、ΔA=7.128、ΔT=−4.86", () => {
  const appraisal = { valence: 1, activation: 0.6, tension: -0.5, importance: 0.8, confidence: 0.9, surprise: 0.5 };
  assert.ok(Math.abs(appraisalWeight(appraisal) - 0.54) < 1e-9);
  const body = createBody(DAY0, { valence: 8, activation: 25, energy: 70, tension: 10 });
  const { body: after, applied } = applyAppraisal(body, appraisal, DAY0);
  assert.ok(Math.abs(applied.valence - 9.72) < 1e-9);
  assert.ok(Math.abs(applied.activation - 7.128) < 1e-9);
  assert.ok(Math.abs(applied.tension + 4.86) < 1e-9);
  assert.ok(Math.abs(after.values.valence - 17.72) < 1e-9);
  assert.ok(Math.abs(after.values.activation - 32.128) < 1e-9);
  assert.ok(Math.abs(after.values.tension - 5.14) < 1e-9);
  assert.equal(after.values.energy, 70, "扰动不改精力");
});

test("扰动限幅：10 分钟预算 V=24、A=30、T=24，按最小可用比例整体缩放", () => {
  const body = createBody(DAY0, { valence: 0, activation: 50, energy: 70, tension: 50 });
  let current = body;
  const strong = { valence: 1, activation: 1, tension: 1, importance: 1, confidence: 1, surprise: 1 };
  for (let i = 0; i < 6; i += 1) current = applyAppraisal(current, strong, DAY0 + i * 1000).body;
  const usedV = current.impulseWindow.reduce((sum, entry) => sum + Math.abs(entry.delta.valence), 0);
  assert.ok(usedV <= 24 + 1e-9, `usedV=${usedV}`);
  assert.ok(current.values.valence <= 24 + 1e-9);
  const low = applyAppraisal(createBody(DAY0), { valence: 1, activation: 0, tension: 0, importance: 0.1, confidence: 1, surprise: 0 }, DAY0);
  assert.equal(low.applied.valence, 0, "importance < 0.15 不施加");
  const unsure = applyAppraisal(createBody(DAY0), { valence: 1, activation: 0, tension: 0, importance: 1, confidence: 0.5, surprise: 0 }, DAY0);
  assert.equal(unsure.applied.valence, 0, "confidence < 0.6 不施加");
  const budgeted = applyAppraisal(createBody(DAY0, { valence: -100 }), { valence: 1, activation: 0, tension: 0, importance: 1, confidence: 1, surprise: 1 }, DAY0);
  assert.equal(budgeted.body.impulseWindow.length, 1, "顶满边界也记预算，不能绕过限额");
});

test("档位滞回：阈值附近不来回换风格", () => {
  const enter = bandsOf({ valence: 0, activation: 70, energy: 20, tension: 70 }, {});
  assert.deepEqual(enter, { lowEnergy: true, highActivation: true, highTension: true, valence: "neutral" });
  const inBand = bandsOf({ valence: 0, activation: 60, energy: 35, tension: 60 }, enter);
  assert.deepEqual(inBand, { lowEnergy: true, highActivation: true, highTension: true, valence: "neutral" }, "滞回带内保持");
  const relaxed = bandsOf({ valence: 25, activation: 0, energy: 90, tension: 0 }, {});
  assert.equal(relaxed.valence, "relaxed");
  assert.equal(bandsOf({ valence: 17, activation: 0, energy: 90, tension: 0 }, relaxed).valence, "relaxed", "退出要低于 15");
  assert.equal(bandsOf({ valence: 10, activation: 0, energy: 90, tension: 0 }, relaxed).valence, "neutral");
});

test("日程驱动：走到某段才采用；未来一小时的预期负荷只取最大不相加", () => {
  const slots = [
    { start: 0, tag: "睡觉" },
    { start: 8 * 60, tag: "起床" },
    { start: 9 * 60, tag: "上班" },
    { start: 18 * 60, tag: "吃饭" },
  ];
  const timeline = timelineOf(slots);
  const atWork = driversAt(timeline, DAY0 + 10 * 60 * MINUTE_MS);
  assert.equal(atWork.segment.tag, "上班");
  assert.equal(atWork.load, 0.65);
  const asleep = driversAt(timeline, DAY0 + 3 * 60 * MINUTE_MS);
  assert.equal(asleep.asleep, true);
  assert.equal(asleep.load, 0, "睡着时负荷与恢复都不生效");
  const before = driversAt(timeline, DAY0 + 8 * 60 * MINUTE_MS + 30 * MINUTE_MS);
  assert.ok(before.expectedLoad > 0 && before.expectedLoad <= 0.65, "渐近的准备压力");
  assert.equal(expectedLoad(timeline.segments, DAY0 + 10 * 60 * MINUTE_MS), 0, "已经开始的段不算预期");
  assert.equal(before.expectedLoad, 0.65 * (1 - 30 / 60), "只取最大的一项，不相加");
});

test("天气是弱背景：观测 30 分钟内最强、6 小时后归零，城市不符或没有观测时间就不算", () => {
  const now = DAY0 + 12 * 60 * MINUTE_MS;
  assert.equal(weatherLoad({ city: "上海", weather: { code: "clear" }, weatherObservedAt: now }, "上海", now), 2);
  const old = weatherLoad({ city: "上海", weather: { code: "rain" }, weatherObservedAt: now - 3 * 60 * MINUTE_MS }, "上海", now);
  assert.ok(old < 0 && old > -2, "褪色但没归零");
  assert.equal(weatherLoad({ city: "上海", weather: { code: "rain" }, weatherObservedAt: now - WEATHER_MAX_AGE_MS - 1 }, "上海", now), 0);
  assert.equal(weatherLoad({ city: "北京", weather: { code: "clear" }, weatherObservedAt: now }, "上海", now), 0);
  assert.equal(weatherLoad({ city: "上海", weather: { code: "clear" } }, "上海", now), 0, "没有观测时间不算，不能拿刷新时间冒充");
  assert.ok(WEATHER_FRESH_MS > 0);
});

test("念头负荷：取 demand 最高三项、除以 2 封顶；空池为 0", () => {
  assert.equal(thoughtLoad([]), 0);
  const thoughts = [
    { strength: 100, affect: { demand: 1 } },
    { strength: 80, affect: { demand: 0.8 } },
    { strength: 90, affect: { demand: 0.6 } },
    { strength: 100, affect: { demand: 1 } },
  ];
  const top3 = (1 + 0.64 + 0.54) / 2;
  assert.ok(Math.abs(thoughtLoad(thoughts) - Math.min(1, top3)) < 1e-9);
  assert.equal(thoughtLoad([{ strength: 100, closed: true, affect: { demand: 1 } }]), 0, "闭合的不算");
});

test("推进：与调度频率无关（同一积分网格）；高负荷耗精力、夜里恢复；不靠用户消息解锁", () => {
  const slots = [
    { start: 0, tag: "睡觉" },
    { start: 8 * 60, tag: "起床" },
    { start: 9 * 60, tag: "加班" },
    { start: 22 * 60, tag: "睡觉" },
  ];
  const timeline = timelineOf(slots);
  const body = createBody(DAY0 + 7 * 60 * MINUTE_MS, { energy: 80, tension: 20, valence: 10 });
  const to = DAY0 + 24 * 60 * MINUTE_MS + 6 * 60 * MINUTE_MS;
  const once = advanceBody(body, to, timeline).body;
  const steppedEvery = (stepMs) => {
    let stepped = body;
    for (let t = body.at + stepMs; t < to; t += stepMs) {
      const { body: advanced } = advanceBody({ ...stepped, at: stepped.at }, t, timeline);
      stepped = { ...advanced, at: t };
    }
    return advanceBody({ ...stepped, at: stepped.at }, to, timeline).body;
  };
  const at5 = steppedEvery(5_000);
  const at15 = steppedEvery(15_000);
  for (const key of ["valence", "activation", "energy", "tension"]) {
    assert.ok(Math.abs(once.values[key] - at15.values[key]) < 1e-6, `${key} 一次 vs 15 秒：${once.values[key]} vs ${at15.values[key]}`);
    assert.ok(Math.abs(at5.values[key] - at15.values[key]) < 1e-6, `${key} 5 秒 vs 15 秒：${at5.values[key]} vs ${at15.values[key]}`);
  }
  const afterWork = advanceBody(body, DAY0 + 22 * 60 * MINUTE_MS, timeline).body;
  assert.ok(afterWork.values.energy < 80, `加班到晚上精力更低（${afterWork.values.energy}）`);
  const night = advanceBody(createBody(DAY0 + 22 * 60 * MINUTE_MS, { energy: 30 }), DAY0 + 24 * 60 * MINUTE_MS + 6 * 60 * MINUTE_MS, timeline).body;
  assert.ok(night.values.energy > 30, "睡觉时精力恢复");
});

test("跨零点连续、范围有界；长时间离线补算标 coarse 且不产生无输入放大", () => {
  const slots = [{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "起床" }, { start: 9 * 60, tag: "上班" }, { start: 23 * 60, tag: "睡觉" }];
  const timeline = timelineOf(slots);
  const body = createBody(DAY0 + 23 * 60 * MINUTE_MS, { energy: 40 });
  const overnight = advanceBody(body, DAY0 + 24 * 60 * MINUTE_MS + 8 * 60 * MINUTE_MS, timeline).body;
  assert.ok(overnight.values.energy > 40 && overnight.values.energy <= 100);
  const longOffline = advanceBody(body, body.at + 7 * 24 * 60 * MINUTE_MS, timeline);
  assert.equal(longOffline.catchupMode, "coarse");
  assert.ok(Number.isFinite(longOffline.body.values.valence));
  for (const key of ["valence", "activation", "energy", "tension"]) {
    const value = longOffline.body.values[key];
    assert.ok(value >= (key === "valence" ? -100 : 0) && value <= 100, `${key}=${value}`);
  }
  const projected = projectBody(body, body.at + 60 * MINUTE_MS, timeline);
  assert.equal(body.at, DAY0 + 23 * 60 * MINUTE_MS, "投影不改原状态");
  assert.equal(projected.at, body.at + 60 * MINUTE_MS);
});

test("中午才生成日程：新计划只从现在采用，过去的时间不被倒灌", () => {
  const fallback = timelineOf([{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "起床" }, { start: 9 * 60, tag: "空闲" }, { start: 23 * 60, tag: "睡觉" }]);
  const afternoon = DAY0 + 13 * 60 * MINUTE_MS;
  const morning = advanceBody(createBody(DAY0 + 9 * 60 * MINUTE_MS, { tension: 10 }), afternoon, fallback).body;
  // 生成的计划里写着「12:00 起加班」，但采用时刻是 13:00：12:00–13:00 那一段不能倒灌进已经历的时间。
  const late = { segments: closeSegments(normalizeSchedule([{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "起床" }, { start: 12 * 60, tag: "加班" }, { start: 23 * 60, tag: "睡觉" }], { date: DAY, adoptedAt: afternoon, version: 2 })), world: null, city: "上海", thoughts: [] };
  const withLate = advanceBody(createBody(DAY0 + 9 * 60 * MINUTE_MS, { tension: 10 }), afternoon, late).body;
  assert.ok(Math.abs(withLate.values.tension - morning.values.tension) < 1e-6, `今天之前的计划不改已经历的时间（${withLate.values.tension} vs ${morning.values.tension}）`);
  const afterAdopt = advanceBody(withLate, afternoon + 60 * MINUTE_MS, late).body;
  assert.ok(afterAdopt.values.tension > withLate.values.tension, "采用之后才生效");
});

test("参数集中在版本化对象里；模型不能改系数", () => {
  assert.equal(BODY_PARAMS.version, "body-v1");
  assert.ok(Object.isFrozen(BODY_PARAMS));
  assert.ok(Object.isFrozen(BODY_PARAMS.tags));
  const body = createBody(DAY0);
  assert.equal(body.paramsVersion, BODY_PARAMS.version);
  assert.equal(body.epoch, 1);
  assert.deepEqual(body.inputVersions, { schedule: 0, weather: 0, thoughts: 0 });
});
