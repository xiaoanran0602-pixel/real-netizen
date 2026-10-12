// ============================================================
// 她要发的图、换的头像：全部用生图模型生成，不再去网上搜。
//   POST <baseUrl>/v1/images/generations（OpenAI Images 兼容协议），返回 data[0].b64_json 的 PNG。
//
// 为什么不搜图了：搜到的图经常是防盗链的占位图（比如各种「防盗链，请直接访问」），
// 程序以为换成功了，实际头像/配图是一张占位卡片。生成的图来源可控、内容就是她想要的。
//
// 提示词由她自己（决定动作的那次后台调用）写：画面是什么、为什么拍。这里只按用途补上拍摄感：
//   照片类 → 「iPhone 原厂相机 无 PS 痕迹 偶尔手抖 仿佛随手拍摄」这类手机随手拍的质感，按画面调整；
//   头像   → 方图、构图干净；她这种人会用的头像（风景、星空、植物、书页、动物、插画），不用真人自拍。
// 质量用 low（够用、便宜、约 10–20 秒）。尺寸非 auto 时 quality 必须同时给，否则网关返回 500。
// 模型名与开关在 settings：imageModel（默认 gpt-image-1）、imagesEnabled（可整体关闭）。
// 日志只记用途、耗时和是否成功，不记提示词全文和 Key。
// ============================================================

import { readSettings } from "../config/settings.js";
import { readModelSecrets } from "../config/secrets.js";
import { saveMedia } from "../store/media.js";
import { createLogger } from "../util/log.js";

const log = createLogger("images");
/** 默认生图模型；可在「设置 → 模型 → 生图模型」里改。 */
export const IMAGE_MODEL = "gpt-image-1";
export const IMAGE_QUALITY = "low";
const IMAGE_TIMEOUT_MS = 120_000;
const PROMPT_MAX_CHARS = 800;
const SIZES = Object.freeze({ photo: "1024x1536", landscape: "1536x1024", avatar: "1024x1024" });

/** 照片类的拍摄质感：按画面挑，别每张都一样（真人随手拍也不是每张都抖）。 */
const PHOTO_STYLES = Object.freeze([
  "iPhone 原厂相机直出，无 PS 痕迹，仿佛随手拍摄，构图有点随意",
  "手机随手拍，轻微手抖带一点糊，自动曝光，没有滤镜",
  "iPhone 原相机，无后期，画面边缘有点歪，像走路时顺手拍的",
  "手机拍的日常照片，光线就是现场的光，不完美，有生活感",
]);
const NIGHT_STYLE = "夜里用手机拍的，噪点明显，有点暗，光源发散，无 PS 痕迹";
const AVATAR_STYLE = "适合当社交软件头像的方图，主体居中、构图干净；不要文字、不要水印、不要真人正脸";
const NEGATIVE = "不要出现任何文字、水印、logo、边框；不要像商业摄影或海报";

/** images/generations 的地址：沿用模型设置里的网关地址（去掉末尾 /v1 或 /messages 再拼）。 */
export function imagesUrl(baseUrl) {
  const base = String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\/(v1\/)?(messages|chat\/completions)$/u, "")
    .replace(/\/v1$/u, "");
  return `${base}/v1/images/generations`;
}

/**
 * 按用途补上拍摄质感，组成最终提示词。纯函数，便于测试。
 * @param {string} scene 她自己写的画面描述
 * @param {{kind: "photo"|"avatar", night?: boolean, random?: () => number}} options
 */
export function buildImagePrompt(scene, options) {
  const text = String(scene ?? "").trim().slice(0, PROMPT_MAX_CHARS);
  if (options.kind === "avatar") return `${text}。${AVATAR_STYLE}。${NEGATIVE}`;
  const random = options.random ?? Math.random;
  const style = options.night ? NIGHT_STYLE : PHOTO_STYLES[Math.floor(random() * PHOTO_STYLES.length)];
  return `${text}。${style}。${NEGATIVE}`;
}

/** 画面描述里像夜景就换夜拍的质感。 */
export function looksNight(scene, now = new Date()) {
  return /(夜|晚上|深夜|星空|星星|月亮|路灯|霓虹)/u.test(scene ?? "") || now.getHours() >= 20 || now.getHours() < 5;
}

/**
 * 生成一张图存到 data/media，返回本地文件名；失败返回 null（调用方改发纯文字或放弃）。
 * @param {string} scene 她写的画面描述
 * @param {{kind?: "photo"|"avatar", orientation?: "portrait"|"landscape", now?: Date, fetchImpl?: typeof fetch, random?: () => number}} [options]
 */
export async function generateImage(scene, options = {}) {
  if (!String(scene ?? "").trim()) return null;
  const kind = options.kind ?? "photo";
  const [settings, secrets] = await Promise.all([readSettings(), readModelSecrets()]);
  if (settings.imagesEnabled === false) {
    log.warn("image generation skipped: images disabled");
    return null;
  }
  if (!secrets.baseUrl || !secrets.apiKey) {
    log.warn("image generation skipped: model not configured");
    return null;
  }
  const prompt = buildImagePrompt(scene, { kind, night: kind === "photo" && looksNight(scene, options.now), random: options.random });
  const size = kind === "avatar" ? SIZES.avatar : options.orientation === "landscape" ? SIZES.landscape : SIZES.photo;
  const model = settings.imageModel || IMAGE_MODEL;
  const started = Date.now();
  try {
    const response = await (options.fetchImpl ?? fetch)(imagesUrl(secrets.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secrets.apiKey}` },
      // size 不是 auto 时必须带 quality，否则网关 500（接口文档的注意事项）。
      body: JSON.stringify({ model, prompt, n: 1, size, quality: IMAGE_QUALITY }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn("image generation failed", { kind, status: response.status, ms: Date.now() - started });
      return null;
    }
    const body = await response.json();
    const b64 = body?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) {
      log.warn("image generation returned no image", { kind, ms: Date.now() - started });
      return null;
    }
    const file = await saveMedia(Buffer.from(b64, "base64"), "png");
    log.info("image generated", { kind, size, ms: Date.now() - started });
    return file;
  } catch (error) {
    log.warn("image generation error", { kind, error: error?.name === "TimeoutError" ? "timeout" : error?.message, ms: Date.now() - started });
    return null;
  }
}
