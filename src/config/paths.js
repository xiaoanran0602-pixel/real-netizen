// ============================================================
// 数据目录与所有文件路径的唯一来源。别的模块只调这里的函数拿路径，不自己拼。
// 默认 <Lin>/data；启动参数 --data 可改（用数据副本做测试时用）。
// ============================================================

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Lin 程序根目录（src 的上级）。 */
export const APP_ROOT = resolve(HERE, "..", "..");
export const WEB_ROOT = join(APP_ROOT, "web");
const DEFAULT_DATA_DIR = join(APP_ROOT, "data");

let dataDir = DEFAULT_DATA_DIR;

/** @param {string} dir */
export function setDataDir(dir) {
  dataDir = resolve(dir);
}

export function getDataDir() {
  return dataDir;
}

/** @param {...string} segments */
export function dataPath(...segments) {
  return join(dataDir, ...segments);
}

export const paths = {
  settings: () => dataPath("settings.json"),
  persona: () => dataPath("persona.md"),
  /** 聊天提示词用的平实人设（事实清单，第三人称）。persona.md 是完整角色文档，给朋友圈、日程等用。 */
  profile: () => dataPath("profile.md"),
  core: () => dataPath("core.md"),
  coreSelf: () => dataPath("core-self.md"),
  state: () => dataPath("state.json"),
  conversations: () => dataPath("conversations"),
  conversationDir: (id) => dataPath("conversations", id),
  memory: () => dataPath("memory"),
  life: () => dataPath("memory", "life"),
  strength: () => dataPath("memory", ".strength.json"),
  moments: () => dataPath("moments.json"),
  /** 她的头像、签名（朋友圈那边的资料）。 */
  momentsProfile: () => dataPath("profile.json"),
  world: () => dataPath("world.json"),
  mediaLibrary: () => dataPath("media-library.json"),
  inner: () => dataPath("inner.json"),
  innerLog: () => dataPath("inner-log.jsonl"),
  /** 合并内心引擎时旧 inner.json 的备份（只写一次，回滚靠它）。 */
  innerLegacyBackup: () => dataPath("inner.legacy-backup.json"),
  thoughts: () => dataPath("thoughts.jsonl"),
  thoughtsMeta: () => dataPath("thoughts-state.json"),
  kernelLog: () => dataPath("kernel-log.jsonl"),
  pendingReplies: () => dataPath("pending-replies.json"),
  /** 这段聊天聊到了什么份上（docs/19）。眼下的事，不进回档范围。 */
  conversationState: () => dataPath("conversation-state.json"),
  media: () => dataPath("media"),
  archive: () => dataPath("archive"),
  archiveObjects: () => dataPath("archive", "objects"),
  archiveDays: () => dataPath("archive", "days"),
  secrets: () => dataPath("secrets"),
  modelSecrets: () => dataPath("secrets", "model.json"),
  channelSecrets: () => dataPath("secrets", "channels.json"),
  accessToken: () => dataPath("secrets", "access-token.txt"),
  logs: () => dataPath("logs"),
};

/**
 * 回档范围（「她的经历」）：存档与恢复共用。相对 data 目录，目录会递归。
 * state.json 不在这里：它只恢复下面 EXPERIENCE_STATE_KEYS 里的键，单独处理。
 * 不在范围内：settings、persona、core、world、secrets、logs、pending-replies、conversation-state、archive 本身。
 */
export const EXPERIENCE_PATHS = Object.freeze([
  "conversations",
  "memory",
  "moments.json",
  "profile.json",
  "inner.json",
  "inner-log.jsonl",
  "thoughts.jsonl",
  "thoughts-state.json",
  "media-library.json",
  "kernel-log.jsonl",
  "media",
]);

/** state.json 里与经历相关、随存档保存并在回档时写回的键。 */
export const EXPERIENCE_STATE_KEYS = Object.freeze([
  "lastUserMessageAt",
  "mainConversationId",
  "memoryCursor",
  "lastProactiveAt",
]);

/** 「时钟」键：回档时设为目标日，避免回档后立刻把丢掉的日子再整理一遍。 */
export const CLOCK_STATE_KEYS = Object.freeze(["lastConsolidated", "lastSnapshotDay"]);

/** 首次启动要建的目录。 */
export function requiredDirs() {
  return [getDataDir(), paths.conversations(), paths.memory(), paths.life(), paths.media(), paths.archiveObjects(), paths.archiveDays(), paths.secrets(), paths.logs()];
}
