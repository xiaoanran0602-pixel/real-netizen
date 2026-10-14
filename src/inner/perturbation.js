// ============================================================
// 这一刻碰巧发生的小事（docs/19）：有人叫她、手上的事刚好告一段落、身边有点动静。
// 同样的处境、同样的一句话，回出来也不该每次一样；差别来自那一刻真的有点不一样，不来自「随机换个说法」。
//
//   程序掷骰，模型叙事：发不发生、发生哪件由这里决定，写成一句画面放在处境后面。
//   每件事都挂在日程标签上：开会时不会有小孩来拉她，在家时不会有同事来找她。
//   大多数时候什么都不发生；发生过一次之后隔几轮才可能再有。
//   他在说心里的事、想被安慰时，不安排有人把她叫走。安全例外什么都不安排。
// 纯函数：不读盘、不调模型；随机数由调用方给。
// ============================================================

/** 上一次发生之后，至少隔这么多轮才可能再有。 */
export const MIN_QUIET_TURNS = 4;

/** 每轮各种事发生的机会，按她此刻能分给手机多少查表。加起来就是这一轮「有事发生」的机会。 */
export const CHANCE = Object.freeze({
  glance: { interrupted: 0.08, freed: 0.08, around: 0.05 },
  half: { interrupted: 0.04, freed: 0, around: 0.07 },
  full: { interrupted: 0, freed: 0, around: 0.06 },
});

/** 有人/有事把她叫走。只来得及回一句。全部是第三人称事实。 */
export const INTERRUPTED = Object.freeze({
  上班: ["她刚拿起手机，同事过来找她说事。"],
  加班: ["她刚拿起手机，同事过来找她说事。"],
  截止: ["她刚拿起手机，主编在群里催稿了。"],
  开会: ["快轮到她说话了。"],
  天文台: ["有个小孩跑过来，拉她去看望远镜。"],
  运动: ["休息的时间到了，她得接着练。"],
  通勤: ["她要换乘了，得走一段。"],
});
export const ONE_LINE_ONLY = "她只来得及回一句。";

/** 手上的事刚好告一段落：这一会儿手机是完全在手里的。 */
export const FREED = Object.freeze({
  上班: ["她手上这一段刚好弄完，能歇一会儿。"],
  加班: ["她手上这一段刚好弄完，能歇一会儿。"],
  截止: ["她刚把一章交出去，能喘口气。"],
  写作: ["她刚写完一段，停下来了。"],
  开会: ["会开到一半，中间休息。"],
  天文台: ["小孩们被带去看望远镜了，她能歇几分钟。"],
});

/** 身边的一点动静。 */
export const AROUND = Object.freeze({
  上班: ["旁边有人在打电话，声音不小。", "工作群里一直有人在发消息。", "她杯子里的咖啡已经凉了。"],
  加班: ["办公室里只剩几个人了。", "她杯子里的咖啡已经凉了。"],
  截止: ["工作群里一直有人在发消息。"],
  开会: ["有人讲了很久，还没讲完。"],
  通勤: ["车厢里人很多。", "旁边有人在外放视频。"],
  出门: ["路上人不少。"],
  吃饭: ["店里人多，有点吵。"],
  天文台: ["有两个小孩在旁边追着跑。"],
  写作: ["她的茶泡得太久了，有点苦。"],
  空闲: ["她耳机里放着歌。"],
  夜里在家: ["楼下有人在说话，听得见。", "她耳机里放着歌。"],
});

const TABLES = Object.freeze({ interrupted: INTERRUPTED, freed: FREED, around: AROUND });
const TENDER = new Set(["vent", "ask_comfort"]);

/**
 * 这一轮有没有事发生。
 * @param {{spot?: string, attention?: string, safety?: boolean, mode?: string, register?: string, quietTurns?: number, rng?: () => number}} input
 *   spot：处境的地点键（situation.sceneOf 的 spot：日程标签，或「夜里在家」）
 * @returns {{kind: "interrupted"|"freed"|"around", line: string} | null}
 */
export function rollPerturbation(input) {
  if (input.safety || !input.spot) return null;
  if (Number.isFinite(input.quietTurns) && input.quietTurns < MIN_QUIET_TURNS) return null;
  const rng = input.rng ?? Math.random;
  const chance = CHANCE[input.attention] ?? CHANCE.full;
  const tender = input.mode === "heart" || TENDER.has(input.register);
  let roll = rng();
  for (const kind of ["interrupted", "freed", "around"]) {
    const width = chance[kind] ?? 0;
    if (roll >= width) {
      roll -= width;
      continue;
    }
    // 落在这一格。没有这种事可发生、或者这时候不该发生：这一格作废，不挪给别的事。
    const options = TABLES[kind][input.spot] ?? [];
    if (options.length === 0 || (kind === "interrupted" && tender)) return null;
    return { kind, line: options[Math.min(options.length - 1, Math.floor(rng() * options.length))] };
  }
  return null;
}

/** 写进处境后面的句子。 */
export function passingLines(passing) {
  if (!passing?.line) return [];
  return passing.kind === "interrupted" ? [passing.line, ONE_LINE_ONLY] : [passing.line];
}

/**
 * 这件事对她此刻能分给手机多少的影响：空下来了就是完全在手里；别的不变。
 * @param {string | undefined} attention
 * @param {{kind: string} | null} passing
 */
export function attentionAfter(attention, passing) {
  return passing?.kind === "freed" ? "full" : attention;
}

/**
 * 处境对一条回复分几段发的上限（只有 Wave 逐段发送时用得上；null = 不限）。
 * 被叫走：一段。抽空看的手机：最多两段。安全例外不限。
 * @param {{attention?: string, passing?: {kind: string} | null, safety?: boolean}} input
 */
export function segmentCap(input) {
  if (input.safety) return null;
  if (input.passing?.kind === "interrupted") return 1;
  return attentionAfter(input.attention, input.passing) === "glance" ? 2 : null;
}
