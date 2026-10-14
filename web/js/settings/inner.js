// 设置 → 高级 →「她的内心」：只读调试面板，一套状态（合并引擎）：
//   四维与模拟心率；派生的饱腹、想念、防线；自我感觉与两条张力；生病状态、档位、当前提示词；
//   念头池默认折叠（docs/13 第 4 节：他看到池子，黑箱就没了），点开才读。
// 这是给你看的后台，不进她的认知。接口不可用时只显示提示。
import { api } from "../api.js";
import { h, mount } from "../ui.js";

const REFRESH_MS = 30_000;
const BODY_LABELS = { valence: "愉悦", activation: "激活", energy: "精力", tension: "张力" };
const DERIVED_LABELS = { fullness: "饱腹", missing: "想念", guard: "防线" };
const SOURCE_TEXT = { him: "他", life: "她的生活", world: "外面", infer: "她的判断" };
const SICK_TEXT = { cold: "感冒", overtime: "加班周", vacation: "假期" };

function meter(label, value, min = 0) {
  const number = Math.round(Number(value) || 0);
  const percent = min < 0 ? (number - min) / 2 : number;
  return [h("span", null, `${label} ${number}`), h("div", { class: "lin-meter" }, h("span", { style: { width: `${Math.max(0, Math.min(100, percent))}%` } }))];
}

function bandText(bands) {
  if (!bands) return "-";
  const items = [
    bands.exhausted ? "很困" : bands.tired ? "累" : null,
    bands.hungry ? "饿" : null,
    bands.highTension ? "高张力" : null,
    bands.highActivation ? "高激活" : null,
    bands.valence === "relaxed" ? "轻松余韵" : bands.valence === "subdued" ? "低落余韵" : null,
  ].filter(Boolean);
  return items.length ? items.join("、") : "正常";
}

function thoughtsBlock() {
  const holder = h("div");
  const toggle = h(
    "button",
    {
      type: "button",
      class: "lin-button lin-button-ghost",
      onClick: async () => {
        try {
          const pool = await api.getThoughts();
          mount(
            holder,
            h(
              "div",
              { class: "lin-form" },
              h("span", { class: "lin-field-hint" }, `${pool.count} 条（上限 15）${pool.busyUntil > Date.now() ? ` · 她说过要忙到 ${new Date(pool.busyUntil).toLocaleTimeString("zh-CN")}` : ""}`),
              ...pool.items.map((item) =>
                h("span", { class: "lin-field-hint" }, `${item.strength} · ${SOURCE_TEXT[item.source] ?? item.source}${item.speakable ? "" : " · 说不出口"}${item.avoid ? " · 会绕开" : ""}${item.candidate ? ` · 等着${item.candidate === "message" ? "找你" : "发出来"}` : ""}`),
              ),
            ),
          );
        } catch {
          mount(holder, h("span", { class: "lin-field-hint" }, "念头池读不到。"));
        }
      },
    },
    "展开念头池（只看强度和来源，不显示内容）",
  );
  return h("div", null, toggle, holder);
}

function stateBlock(inner) {
  if (!inner.values) return h("span", { class: "lin-field-hint" }, `内心引擎${inner.status === "unavailable" ? "不可用" : "还在恢复"}：不注入状态，按平常回复。`);
  const psyche = inner.psyche ?? {};
  return [
    h(
      "div",
      { class: "lin-inner-grid" },
      Object.entries(BODY_LABELS).flatMap(([key, label]) => meter(label, inner.values[key], key === "valence" ? -100 : 0)),
      Object.entries(DERIVED_LABELS).flatMap(([key, label]) => meter(label, inner.derived?.[key])),
      meter("自我感觉", psyche.selfWorth),
      meter("张力：写那本书", psyche.book),
      meter("张力：被他看见", psyche.seen),
    ),
    h("span", { class: "lin-field-hint" }, `模拟心率 ${inner.heartRate ?? "-"}（模拟值，不是生理测量）`),
    h("span", { class: "lin-field-hint" }, `生病/事件：${inner.sick ? `${SICK_TEXT[inner.sick.kind] ?? inner.sick.kind}，到 ${inner.sick.until}` : "无"}`),
    h("span", { class: "lin-field-hint" }, `档位：${bandText(inner.bands)}`),
    h("span", { class: "lin-field-hint" }, inner.prompt ? `当前提示词：${inner.prompt.split("\n").slice(2).join(" / ")}` : "当前提示词：无（不注入状态小节）"),
  ];
}

const MODE_TEXT = { opening: "刚搭上话", chatting: "闲扯", discussing: "认真聊一件事", heart: "他在说心里的事", flirting: "没正经" };
const PASSING_TEXT = { interrupted: "被叫走", freed: "刚好空下来", around: "身边有点动静" };

/** 聊天状态的一行说明：处在哪种状态、聊了几轮、判断来自决策模型还是粗略猜测、最近一次碰巧发生的事。 */
function conversationText(conversation) {
  if (!conversation) return "这会儿没在聊";
  const parts = [`${MODE_TEXT[conversation.mode] ?? conversation.mode}，第 ${conversation.turns} 轮`, conversation.source === "decision" ? "决策模型判断" : "粗略猜测（决策模型没用上）"];
  if (conversation.passing) parts.push(`刚才：${PASSING_TEXT[conversation.passing.kind] ?? conversation.passing.kind}（${conversation.passing.line}）`);
  return parts.join("；");
}

export function renderInner(container) {
  const draw = async () => {
    try {
      const inner = await api.getInner();
      mount(
        container,
        h(
          "div",
          { class: "lin-form" },
          h("span", { class: "lin-field-label" }, "她的内心（只给你看）"),
          stateBlock(inner),
          h("span", { class: "lin-field-hint" }, `现在：${inner.slot?.label ?? "-"}（${inner.slot?.tag ?? "空闲"}，${inner.availability ?? "-"}）`),
          h("span", { class: "lin-field-hint" }, `她此刻的处境：${inner.situation?.text ?? "读不到日程，不写"}`),
          h("span", { class: "lin-field-hint" }, `这段聊天：${conversationText(inner.conversation)}`),
          h("span", { class: "lin-field-hint" }, inner.nextReply ? `下一条待回复：${new Date(inner.nextReply.dueAt).toLocaleString("zh-CN")}` : "没有待回复的消息"),
          inner.consolidationSkipped?.length ? h("span", { class: "lin-field-hint" }, `跳过的整理：${inner.consolidationSkipped.join("、")}`) : null,
          thoughtsBlock(),
        ),
      );
    } catch {
      mount(container, h("div", { class: "lin-form" }, h("span", { class: "lin-field-hint" }, "她的内心：暂时读不到。")));
    }
  };
  void draw();
  const timer = setInterval(() => void draw(), REFRESH_MS);
  return () => clearInterval(timer);
}
