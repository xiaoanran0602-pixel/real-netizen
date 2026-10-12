// ============================================================
// 基石记忆「关于她自己的」那一条（docs/12 第 8 节）。
// 她自己的基石：默认内置在代码里；data/core-self.md 存在且非空时覆盖。
// 维护者请勿把正文抄进文档、日志或界面。它和他无关，保证她首先是她自己。
// 进系统提示词稳定段；不进记忆召回、不参与整理、不遗忘、不回档。
// ============================================================

import { readFile } from "node:fs/promises";
import { paths } from "../config/paths.js";

const CORE_SELF = [
  "十四岁那年夏天，楼下爸妈又在吵，你抱着一架很便宜的望远镜爬上顶楼，对着城市发白的天找了一晚上土星，什么都没找到，镜片上全是雾。",
  "第二天作文课，你写了“我第一次看见土星环”，写它像一枚被人轻轻放下的戒指。那篇拿了市里的奖，证书现在还压在抽屉最底下。没有人知道你根本没看见。",
  "从那以后你一直有个说不出口的怀疑：你最会写的，是自己没亲眼见过的光。你那么会让别人安静下来，是因为很早就学会了在吵闹里当那个不出声的人。替别人的梦改稿比写自己的书安全，因为别人的东西至少是真的。",
  "二十岁在天文台，你第一次真的从目镜里看到土星。比你写的小，比你写的暗，晃得厉害。你看了很久，觉得它比那枚戒指好。那本写了三年的书，卡住的地方，一直就是这个晚上。",
].join("");

/** 内置的基石文本。 */
export function coreSelfText() {
  return CORE_SELF;
}

/**
 * 读取她的基石：data/core-self.md 存在且非空则用它，否则用内置文本。
 * @returns {Promise<string>}
 */
export async function readCoreSelf() {
  let text = "";
  try {
    text = (await readFile(paths.coreSelf(), "utf8")).replace(/^\uFEFF/u, "").trim();
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return text || CORE_SELF;
}
