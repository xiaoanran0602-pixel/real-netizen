// ============================================================
// 执行她的决定：发朋友圈、换头像、换签名、主动找他；换头像和签名同步到聊天渠道资料。
// 每件事都写一条她这几天的记忆，聊天时她记得自己做过什么。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { readChannelSecrets } from "../config/secrets.js";
import { enabledChannels } from "../channels/registry.js";
import { readBytes } from "../store/files.js";
import { broadcast } from "../http/events.js";
import { mediaUrl } from "../store/media.js";
import { createLogger } from "../util/log.js";
import { formatLocalDate } from "../util/time.js";
import { generateImage } from "./images.js";
import { newId, readProfile, updateMoments, updateProfile, writeMomentMemory } from "./store.js";

const log = createLogger("moments");
const SIGNATURE_MAX_CHARS = 60;

/** 网页用的 profile 视图。 */
export function profileView(profile) {
  return { avatar: profile.avatar ? mediaUrl(profile.avatar.file) : null, signature: profile.signature?.text ?? null, currentCity: profile.currentCity ?? null };
}

/**
 * 换头像/签名时同步到所有已启用的聊天渠道；单个渠道失败只记日志，不影响网页那边。
 * 返回是否至少同步成功一个（调试接口和日志用）。
 */
export async function syncChannelProfile(patch) {
  const secrets = await readChannelSecrets();
  const channels = enabledChannels(secrets);
  if (channels.length === 0) return false;
  let avatarBytes = null;
  if (patch.avatarFile) {
    try {
      avatarBytes = await readBytes(join(paths.media(), patch.avatarFile));
    } catch (error) {
      avatarBytes = null;
    }
  }
  const profile = { ...(patch.signature ? { signature: patch.signature } : {}), ...(avatarBytes ? { avatar: avatarBytes } : {}) };
  let synced = false;
  for (const channel of channels) {
    if (typeof channel.updateProfile !== "function") continue;
    try {
      await channel.updateProfile(secrets[channel.id] ?? {}, profile);
      synced = true;
      log.info("channel profile synced", { channel: channel.id, signature: Boolean(patch.signature), avatar: Boolean(avatarBytes) });
    } catch (error) {
      log.warn("channel profile sync failed", { channel: channel.id, error: error?.message });
    }
  }
  return synced;
}

/** 回档后：头像或签名和回档前不同就同步一次。 */
export async function syncProfileAfterRestore(before, after) {
  if (!after) return;
  const avatarChanged = (before?.avatar?.file ?? null) !== (after.avatar?.file ?? null);
  const signatureChanged = (before?.signature?.text ?? null) !== (after.signature?.text ?? null);
  if (avatarChanged || signatureChanged) {
    await syncChannelProfile({ ...(avatarChanged && after.avatar ? { avatarFile: after.avatar.file } : {}), ...(signatureChanged && after.signature ? { signature: after.signature.text } : {}) });
  }
  broadcast("profile", profileView(after));
}

/** 她给自己记的「这张图是什么」：优先用她写的一句话，没有就截画面描述的开头。 */
function captionOf(decision) {
  return (decision.imageCaption || decision.imagePrompt || "").split(/[。\n]/u)[0].slice(0, 40);
}

/**
 * @param {{action: string, text?: string, imagePrompt?: string, imageCaption?: string, reason?: string}} decision
 * @param {string} trigger
 * @param {Date} now
 * @param {{bridge: any, generate?: typeof generateImage}} deps
 */
export async function executeDecision(decision, trigger, now, deps) {
  const today = formatLocalDate(now);
  const generate = deps.generate ?? generateImage;
  switch (decision.action) {
    case "post": {
      const image = decision.imagePrompt ? await generate(decision.imagePrompt, { kind: "photo", now }) : null;
      if (!decision.text && !image) return { action: "none", detail: "empty-post" };
      const caption = image ? captionOf(decision) : "";
      const profile = await readProfile();
      const post = { id: newId(), at: Date.now(), text: decision.text ?? "", images: image ? [image] : [], ...(caption ? { imageCaption: caption } : {}), ...(profile.currentCity ? { location: profile.currentCity } : {}), trigger, likes: [], comments: [] };
      await updateMoments((moments) => moments.posts.unshift(post));
      await writeMomentMemory({
        kind: "self_daily",
        slug: post.id.slice(0, 8),
        description: `我发了条朋友圈：${post.text.slice(0, 40)}`,
        body: `${today} 我发了一条朋友圈：「${post.text}」${caption ? `，配了一张自己拍的照片：${caption}` : ""}。${decision.reason ? `当时是因为${decision.reason}` : ""}`,
        now,
      });
      log.info("posted", { trigger, withImage: Boolean(image) });
      return { action: "post", detail: post.id };
    }
    case "avatar": {
      if (!decision.imagePrompt) return { action: "none", detail: "no-prompt" };
      const image = await generate(decision.imagePrompt, { kind: "avatar", now });
      // 修复：原来搜到防盗链占位图也算「换成功」；现在生不出图就不换，资料和记忆都不改。
      if (!image) return { action: "none", detail: "image-failed" };
      const caption = captionOf(decision);
      const profile = await updateProfile((draft) => {
        draft.avatar = { file: image, query: caption, prompt: decision.imagePrompt.slice(0, 400), at: Date.now() };
        draft.history.push({ kind: "avatar", value: caption, at: Date.now(), ...(decision.reason ? { reason: decision.reason } : {}) });
      });
      await writeMomentMemory({ kind: "self_daily", slug: `avatar-${Date.now().toString(36)}`, description: `我换了头像：${caption}`, body: `${today} 我把头像换成了：${caption}。${decision.reason ?? ""}`, now });
      await syncChannelProfile({ avatarFile: image });
      broadcast("profile", profileView(profile));
      log.info("avatar changed", { trigger });
      return { action: "avatar", detail: image };
    }
    case "message": {
      if (!decision.text) return { action: "none", detail: "no-text" };
      const image = decision.imagePrompt ? await generate(decision.imagePrompt, { kind: "photo", now }) : null;
      const sent = await deps.bridge.sendProactive(decision.text, image ?? undefined, decision.reason, image ? captionOf(decision) : undefined);
      log.info("proactive message", { trigger, sent, withImage: Boolean(image) });
      return sent ? { action: "message", detail: decision.text } : { action: "none", detail: "channel-not-ready" };
    }
    case "signature": {
      const text = decision.text?.slice(0, SIGNATURE_MAX_CHARS);
      if (!text) return { action: "none", detail: "no-text" };
      const profile = await updateProfile((draft) => {
        draft.signature = { text, at: Date.now() };
        draft.history.push({ kind: "signature", value: text, at: Date.now(), ...(decision.reason ? { reason: decision.reason } : {}) });
      });
      await writeMomentMemory({ kind: "self_daily", slug: `signature-${Date.now().toString(36)}`, description: `我把签名改成了：${text}`, body: `${today} 我把个性签名改成了「${text}」。${decision.reason ?? ""}`, now });
      await syncChannelProfile({ signature: text });
      broadcast("profile", profileView(profile));
      log.info("signature changed", { trigger });
      return { action: "signature", detail: text };
    }
    default:
      return { action: "none" };
  }
}
