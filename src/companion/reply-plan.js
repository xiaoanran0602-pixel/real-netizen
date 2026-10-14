// 确定性话轮规划：回应需求 × 注意容量，附带互动压力的负反馈。
// 数字是可回归的工程预算，不是心理测量。上限不是要求凑满；不随机、不裁答案。
import { guessRegister, SESSION_GAP_MS } from "../inner/conversation.js";
import { splitParagraphs } from "../util/text.js";
import { decide } from "../model/systemone.js";

const size = (text) => [...String(text ?? "")].length;
const clean = (text) => String(text ?? "").trim();
const top = (dist) => Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0];
const ACK = /^(嗯+|哦+|好[的啊呀吧]?|行|知道了|明白了|收到|谢[谢啦]|哈哈+|对[啊呀的]?)[\s，,。.!！~～]*$/u;
const CLOSE = /(?:不聊了|不想聊了|先不聊|我睡了|先睡了|晚安|回头聊|先忙去了|我先忙了)[\s，,。!！~～]*$/u;
const BOUNDARY = /(?:别|不要|不用|不想|不必)(?:再|一直|老是)?(?:问|催|管|叮嘱|念叨)|不聊这个|换个话题/u;
const EXPLAIN = /解释|展开|详细|讲讲|聊聊|没(?:听|看)?懂|什么意思|为什么|怎么理解|接着说|然后呢/u;
const CLARIFY = /没(?:听|看)?懂|什么意思|什么叫|怎么理解/u;
const INVITE = /你猜|猜猜|你知道.*[吗么]|有件事想.*说/u;
const QUESTION = /[?？]|(?:吗|么|呢|没)[。！!\s]*$|(?:好点|好些|吃了|到了|下班了)没/u;
const countQuestions = (text) => (text.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? []).filter((clause) => QUESTION.test(clause)).length;
const ASK_HER = /你(?:呢|在|今天|最近|刚|还|那|怎么|是不是|忙|做|吃|睡)|问你|说说你/u;
// 行为计数只管轻闲聊的动作汇报，不把“我觉得”和解释自己刚才的话算成生活道具。
const selfAction = (text) => /我这边|我(?:们)?(?:刚|还|也|正|先|得|准备|已经|今天|早上|晚上|最近|那屋|那盆)|^刚(?:醒|起|爬)/u.test(clean(text).replace(/我刚才(?:说|讲|想|指|解释)/gu, ""));

/** 合并他连续发来的消息；只用同一回聊天的最近互动衡量压力。 */
export function currentExchange(messages = [], now = Date.now()) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && ["user", "assistant"].includes(m.role));
  const last = list.findLastIndex((m) => m.role === "user");
  if (last < 0) return { text: "", recent: [], previousAssistantText: "" };
  let first = last;
  while (first > 0 && list[first - 1].role === "user") first -= 1;
  const sentAt = Number.isFinite(list[last].at) ? list[last].at : now;
  const before = list.slice(0, first);
  let start = before.length;
  let nextAt = sentAt;
  while (start > 0 && before.length - start < 12) {
    const previousAt = Number.isFinite(before[start - 1].at) ? before[start - 1].at : nextAt;
    if (nextAt - previousAt > SESSION_GAP_MS) break;
    nextAt = previousAt;
    start -= 1;
  }
  const recent = before.slice(start);
  return { text: list.slice(first, last + 1).map((m) => clean(m.text)).filter(Boolean).join("\n"), recent, previousAssistantText: recent.findLast((m) => m.role === "assistant")?.text ?? "" };
}

export function planReply({ messages = [], now = Date.now(), conversation, situation, expressed, safety = false } = {}) {
  const { text, recent } = currentExchange(messages, now);
  if (safety) return { version: 1, need: "safety", followup: "safety", maxSegments: undefined, targetChars: null, reasons: ["safety"], signals: {} };
  const register = conversation?.register ?? top(guessRegister(text));
  const closing = CLOSE.test(text);
  const boundary = BOUNDARY.test(text);
  // 标点不应让一个“早，”落到分享；词法明确的短招呼优先于分类器。
  const greeting = top(guessRegister(text)) === "greeting";
  const explicit = EXPLAIN.test(text);
  const minimal = (closing && !explicit) || (boundary && !explicit && size(text) < 25) || ACK.test(text) || greeting || !text;
  const asks = countQuestions(text);
  const assistants = recent.filter((m) => m.role === "assistant").slice(-3);
  const users = recent.filter((m) => m.role === "user").slice(-3);
  let questionStreak = 0;
  for (let i = assistants.length - 1; i >= 0 && QUESTION.test(clean(assistants[i].text)); i -= 1) questionStreak += 1;
  const questionPressure = questionStreak >= 2 || countQuestions(clean(assistants.at(-1)?.text)) >= 2;
  const hisChars = users.reduce((n, m) => n + size(m.text), 0) + size(text);
  const herChars = assistants.reduce((n, m) => n + size(m.text), 0);
  const imbalance = assistants.length >= 2 && herChars > Math.max(120, hisChars * 3);
  const sustained = recent.length >= 4 && users.filter((m) => size(m.text) >= 16).length >= 1 && ["discussing", "heart"].includes(conversation?.mode);
  const semanticNeed = conversation?.need;
  let need = minimal ? "acknowledge" : explicit ? "explain" : ["explain", "explore"].includes(semanticNeed) ? semanticNeed : ["discuss", "ask_comfort", "vent"].includes(register) ? "explain" : "respond";
  if (!minimal && register === "vent" && !explicit && size(text) < 80) need = "respond";
  const clarification = CLARIFY.test(text);
  if (!minimal && clarification) need = "explain";
  if (!minimal && !clarification && (need === "explain" || need === "explore") && (sustained || asks >= 2 || size(text) >= 160 || semanticNeed === "explore")) need = "explore";
  const demand = { acknowledge: 0, respond: 1, explain: 2, explore: 3 }[need];
  const selfDisclosureBlocked = demand < 2 && !ASK_HER.test(text) && assistants.slice(-2).length === 2 && assistants.slice(-2).every((m) => selfAction(m.text));
  // 注意容量使用已有内核输出（energy/tension -> activeBudget、疲惫/负荷 -> maxSegments）。
  // 空闲只解除限制，不产生表达需求；想念/低防线不会加问话额度。
  const attention = situation?.attention ?? "half";
  const attentionCap = { glance: 1, half: 2, full: 3 }[attention] ?? 2;
  const active = Number.isFinite(expressed?.activeBudget) ? expressed.activeBudget : 2;
  const imminent = Number.isFinite(situation?.minutesToNext) && situation.minutesToNext <= 5;
  const capacity = Math.max(1, Math.min(attentionCap, active, imminent ? 1 : 3));
  const reciprocal = users.slice(-2).length === 2 && users.slice(-2).every((m) => size(m.text) >= 12) && size(text) >= 20 && !imbalance && !questionPressure;
  let maxSegments = demand <= 1 ? 1 : Math.min(demand + 1, capacity + 1);
  if (need === "respond" && reciprocal && capacity >= 2) maxSegments = 2;
  if (Number.isFinite(expressed?.maxSegments) && expressed.maxSegments >= 1) maxSegments = Math.min(maxSegments, expressed.maxSegments);
  if (imbalance && demand < 2) maxSegments = 1;
  let targetChars = [45, 100, 260, 520][demand];
  if (capacity === 1) targetChars = Math.min(targetChars, demand >= 2 ? 220 : 75);
  if (imbalance && demand < 2) targetChars = Math.min(targetChars, 65);
  const semanticFollowup = conversation?.followup;
  let followup = semanticFollowup === "clarify" ? "clarify" : INVITE.test(text) || semanticFollowup === "invite" ? "invite" : "none";
  if (minimal || boundary || (questionPressure && followup !== "clarify" && !INVITE.test(text)) || (imbalance && followup === "invite" && !INVITE.test(text))) followup = "none";
  const reasons = [need, `attention-${attention}`];
  if (questionPressure) reasons.push("question-pressure");
  if (imbalance) reasons.push("one-sided-output");
  if (sustained) reasons.push("mutual-engagement");
  if (reciprocal) reasons.push("reciprocal-sharing");
  if (boundary) reasons.push("user-boundary");
  if (imminent) reasons.push("next-activity-soon");
  if (selfDisclosureBlocked) reasons.push("repeated-self-report");
  return { version: 1, need, followup, maxSegments, targetChars, selfDisclosureBlocked, reasons, signals: { register, demand, capacity, questionStreak, hisChars, herChars, sustained } };
}

export function replyPlanText(plan) {
  if (!plan || plan.need === "safety") return null;
  const purpose = { acknowledge: "这轮接住招呼、确认或收尾就够了。", respond: "这轮回应他刚说的事，不逐项补齐近况。", explain: "这轮需要回答他的疑问或认真回应他的感受，先把这件事说清楚。", explore: "这轮有展开的需要，可以连续说几条把回答讲清楚。" }[plan.need];
  const followup = plan.followup === "clarify" ? "有影响回答的缺失信息时，只澄清那一个点；已有信息足够就直接回答。" : plan.followup === "invite" ? "他留了话头，可以顺着问一个真正想知道的问题，也可以直接回应。" : "这轮不追加需要他回答的新问题；已经说完的事可以停在这里。";
  return ["本轮回应范围（只用于生成，不输出这些说明）：", purpose,
    `最多 ${plan.maxSegments} 个自然段，总长参考上限 ${plan.targetChars} 字；不需要凑满。回答所需的信息保留，少写附带动作和无关话题。`,
    followup, ...(plan.selfDisclosureBlocked ? ["她已经连续讲了两轮自己正在做什么，他没有接着问她。这轮不再补自己的动作和生活近况。"] : []),
    ...(plan.reasons.includes("user-boundary") ? ["他刚明确说了不喜欢的相处方式。尊重这个边界，不用玩笑反驳、不说他小题大做，也不用解释自己在怎样陪他。"] : []),
    "生活背景用于理解她，不需要每轮汇报。记得他的身体和行程，不等于此刻需要叮嘱他；他没有求建议时不替他安排。历史里的回复篇幅和段式不是本轮的格式要求。"].join("\n");
}

/** 只检查能可靠观察的形状，不用正则猜语义删句子。 */
export function replyViolations(text, plan) {
  if (!plan || plan.need === "safety") return [];
  const errors = [];
  if (size(text) > plan.targetChars * 1.35) errors.push("length");
  if (splitParagraphs(text).length > plan.maxSegments) errors.push("paragraphs");
  if (plan.need === "acknowledge" && plan.followup === "none" && QUESTION.test(clean(text))) errors.push("extra-question");
  if (plan.selfDisclosureBlocked && selfAction(text)) errors.push("repeated-self-report");
  return errors;
}

export const REPLY_REVIEW_QUESTIONS = Object.freeze({ issue: {
  type: "choice",
  instructions: "判断候选回复是否有一个明确需要修改的问题。结合最新用户意图和最近对话，不按命令式词汇或问号一刀切。观点上的不同意和自然关心一次可以保留。但用户刚明确划过相处边界时，反驳或讽刺该边界就是问题，不能以熟人调侃豁免。只有明确证据才选问题，拿不准选 clear。",
  criteria: {
    clear: "直接回应用户，或自然的分享、讨论、受邀请的提问；没有下列明确问题",
    management: "用户没有求建议，她却安排他作息、吃喝、工作或思想情绪；或以亲密之名责怪、训斥他，反驳或讽刺他明确划定的相处边界",
    interrogate: "缺少澄清或邀请的理由，却让用户交代无关近况、连续回答多个追问，或继续问他拒绝的话题",
    recital: "没人问她近况，最近已经讲过类似动作或生活道具，这轮又为凑完整重复插入自我汇报",
    meta: "用解释自己该怎样陪聊、怎样回应用户的流程，代替真实接话",
    nonresponse: "遗漏用户本轮明确要她回答的核心问题，或把认真讨论当成需要他停止的情绪问题",
  },
} });

/** 有界语义验收：只给最近对话，不给记忆和私密基石。失败放行但明确标记未检查。 */
export async function reviewPlannedReply({ reply, plan, messages = [], signal, judge = decide }) {
  if (!plan || plan.need === "safety") return { issues: [], checked: false };
  const cut = (text) => [...String(text ?? "")].slice(0, 1200).join("");
  try {
    const reading = await judge({ state: { 关系: "平等的熟人朋友，有耐心、有自己的观点；喜欢由她自己消化，不以关心为由管理对方。", 最近对话: messages.slice(-6).map((m) => ({ role: m.role, text: cut(m.content ?? m.text) })), 本轮需求: plan.need, 追问许可: plan.followup, 用户本轮明确划边界: plan.reasons.includes("user-boundary"), 候选回复: cut(reply) }, questions: REPLY_REVIEW_QUESTIONS, signal, timeoutMs: 2000 });
    const probabilities = reading?.issue?.probabilities;
    const entries = Object.entries(probabilities ?? {}).filter(([key, value]) => key in REPLY_REVIEW_QUESTIONS.issue.criteria && Number.isFinite(value) && value >= 0);
    const total = entries.reduce((n, [, p]) => n + p, 0);
    if (!total) return { issues: [], checked: false };
    const [key, value] = entries.sort((a, b) => b[1] - a[1])[0];
    return { issues: key !== "clear" && value / total >= 0.65 ? [`semantic-${key}`] : [], checked: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { issues: [], checked: false };
  }
}

/** 网页和 Wave 共用：草稿不发出、不写记忆；最多重写一次，绝不机械裁掉尾段。 */
export async function generatePlannedReply({ complete, plan, system, messages, signal, normalize = clean, review }) {
  const call = (prompt) => complete({ role: "chat", system: prompt, messages, stream: false, signal }).then(normalize);
  const assess = async (text) => {
    const semantic = review ? await review({ reply: text, plan, messages, signal }) : { issues: [], checked: false };
    return { issues: [...replyViolations(text, plan), ...(semantic.issues ?? [])], checked: semantic.checked };
  };
  let reply = await call(system);
  if (!reply) throw new Error("empty reply");
  let assessment = await assess(reply);
  const initialViolations = assessment.issues;
  let rewritten = false;
  if (initialViolations.length) {
    const details = initialViolations.filter((v) => v.startsWith("semantic-")).map((v) => REPLY_REVIEW_QUESTIONS.issue.criteria[v.slice(9)]).join("；");
    const instruction = `本轮草稿需要重写（${initialViolations.join(", ")}）。${details}。重新写一条完整回复，保留对他的问题的回答。直接接他正在说的事，不解释改写过程，不自我检讨或宣布陪聊方式。删去未被请求的管理、无关追问、重复自述，保留真实观点和必要的回答。\n${replyPlanText(plan)}`;
    const prompt = typeof system === "string" ? `${system}\n\n${instruction}` : { ...system, dynamic: `${system.dynamic ?? ""}\n\n${instruction}` };
    try {
      const candidate = await call(prompt);
      if (candidate) {
        const candidateAssessment = await assess(candidate);
        // 初稿有语义问题时，检查器不可用不能被算成“问题消失”。
        if (candidateAssessment.issues.length < initialViolations.length && (!initialViolations.some((v) => v.startsWith("semantic-")) || candidateAssessment.checked)) {
          reply = candidate; assessment = candidateAssessment; rewritten = true;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // 模型重写失败仍保留完整原稿；预算失守显式回报，不冒充已经修好。
    }
  }
  if (signal?.aborted) throw Object.assign(new Error("aborted"), { kind: "aborted" });
  const violations = assessment.issues;
  // 最后只规范气泡边界，保留每一个字。绝不以裁正文伪造“简短”。
  const parts = splitParagraphs(reply);
  if (plan?.maxSegments && parts.length > plan.maxSegments) reply = [...parts.slice(0, plan.maxSegments - 1), parts.slice(plan.maxSegments - 1).join("\n")].join("\n\n");
  return { reply, rewritten, violations, initialViolations, semanticChecked: assessment.checked };
}
