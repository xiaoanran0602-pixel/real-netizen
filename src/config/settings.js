// ============================================================
// settings.json：外观、聊天、名字、城市、推理强度、一天分界、她会生病等非敏感设置。
// 模型地址和 Key 不在这里（见 secrets.js）。读时补默认值并兼容旧字段名。
// ============================================================

import { paths } from "./paths.js";
import { readCached, readJson, writeJsonAtomic } from "../store/files.js";

export const REASONING_LEVELS = Object.freeze(["off", "low", "medium", "high"]);
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 8192;

export const DEFAULT_SETTINGS = Object.freeze({
  companionName: "林澈",
  /** 用户名默认空：开源版不绑定任何真实人名。提示词里用 displayUserName() 回退为「他」。 */
  userName: "",
  signature: "",
  avatarColor: "#7c6fb0",
  reasoningLevel: "low",
  // 自适应思考的 token 也算在 max_tokens 里，low 档思考很短，2048 足够一段聊天回复。
  maxOutputTokens: 2048,
  backgroundReasoningLevel: "medium",
  replyMode: "whole",
  typingDelay: true,
  splitBubbles: true,
  theme: "system",
  fontSize: 15,
  city: "上海",
  momentsEnabled: true,
  /** 生图模型名（OpenAI Images 兼容），空则由调用方回退到 gpt-image-1。 */
  imageModel: "gpt-image-1",
  /** 她能主动找他的每日上限（0–5）；也控制溢出念头的出口频率。 */
  proactivePerDay: 2,
  /** 总开关：关闭后头像/朋友圈/主动消息全部不发起生图请求。 */
  imagesEnabled: true,
  /** 「一天」的分界（0–6 点）：凌晨 1 点的聊天算前一天。 */
  dayBoundaryHour: 4,
  canGetSick: true,
  /** 生病时想念上限（依赖强度），70–95。 */
  sickMissCap: 85,
  /**
   * 内心状态由谁控制（docs/14 第 10.2 节）：
   *   legacy 旧版五个体征控制；shadow 旧版控制、新内核只算并记录对照；body 新内核唯一控制。
   * 首版默认 shadow：两套都跑，但只有旧版影响回复，先观察曲线再切换。
   */
  innerEngineMode: "shadow",
  /** 念头池（docs/13）：开着时「她此刻脑子里的事」进提示词，溢出的念头会主动找你或发朋友圈。 */
  thoughtsEnabled: true,
  /** 推荐作品的后台检索与有来源的模拟观看/阅读。 */
  mediaEnabled: true,
});

const isString = (max, allowEmpty = false) => (v) => typeof v === "string" && v.length <= max && (allowEmpty || v.trim().length > 0);
const isInt = (min, max) => (v) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isBool = (v) => typeof v === "boolean";
const oneOf = (...values) => (v) => values.includes(v);

/** 能由界面修改的字段及其校验。 */
export const SETTINGS_FIELDS = Object.freeze({
  companionName: isString(40),
  userName: isString(40, true),
  signature: isString(200, true),
  avatarColor: (v) => typeof v === "string" && /^#[0-9a-f]{6}$/iu.test(v),
  reasoningLevel: oneOf(...REASONING_LEVELS),
  maxOutputTokens: isInt(MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
  backgroundReasoningLevel: oneOf(...REASONING_LEVELS),
  replyMode: oneOf("whole", "stream"),
  typingDelay: isBool,
  splitBubbles: isBool,
  theme: oneOf("light", "dark", "system"),
  fontSize: isInt(12, 22),
  city: isString(40),
  momentsEnabled: isBool,
  imageModel: isString(80),
  imagesEnabled: isBool,
  proactivePerDay: isInt(0, 5),
  dayBoundaryHour: isInt(0, 6),
  canGetSick: isBool,
  sickMissCap: isInt(70, 95),
  innerEngineMode: oneOf("legacy", "shadow", "body"),
  thoughtsEnabled: isBool,
  mediaEnabled: isBool,
});

/** 旧字段名 → 新字段名。 */
const LEGACY_FIELDS = Object.freeze({ memoryReasoningLevel: "backgroundReasoningLevel" });

/**
 * 补默认值、丢弃不认识或不合法的字段、兼容旧字段名。
 * @param {unknown} raw
 */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, unknown>} */
  const source = { ...input };
  for (const [legacy, current] of Object.entries(LEGACY_FIELDS)) {
    if (source[current] === undefined && source[legacy] !== undefined) source[current] = source[legacy];
  }
  /** @type {Record<string, unknown>} */
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, validate] of Object.entries(SETTINGS_FIELDS)) {
    let value = source[key];
    if (key === "maxOutputTokens" && typeof value === "number" && Number.isFinite(value)) {
      value = Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.trunc(value)));
    }
    if (typeof value === "string" && key !== "signature") value = value.trim();
    if (value !== undefined && validate(value)) out[key] = value;
  }
  return /** @type {typeof DEFAULT_SETTINGS} */ (out);
}

/**
 * 校验一组修改；返回合法的部分和被拒绝的字段名。
 * @param {Record<string, unknown>} patch
 */
export function validateSettingsPatch(patch) {
  /** @type {Record<string, unknown>} */
  const accepted = {};
  /** @type {string[]} */
  const rejected = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    const validate = SETTINGS_FIELDS[key];
    if (!validate || !validate(value)) rejected.push(key);
    else accepted[key] = value;
  }
  return { accepted, rejected };
}

/** 读设置（按 mtime 缓存，设置页保存后下一次读就是新的）。 */
export async function readSettings() {
  const raw = await readCached(paths.settings(), (text) => JSON.parse(text.replace(/^\uFEFF/u, "")));
  return normalizeSettings(raw);
}

/** 合并保存；只写合法字段。 */
export async function updateSettings(patch) {
  const { accepted, rejected } = validateSettingsPatch(patch);
  if (rejected.length > 0) return { settings: null, rejected };
  const current = normalizeSettings(await readJson(paths.settings(), {}));
  const next = { ...current, ...accepted };
  await writeJsonAtomic(paths.settings(), next);
  return { settings: next, rejected };
}
