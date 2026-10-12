// 设置 → 高级 →「她的内心」：只读调试面板。
//   旧版五个体征、两条张力、防线；新内核四维、档位、模拟心率、控制模式；
//   念头池默认折叠（docs/13 第 4 节：他看到池子，黑箱就没了），点开才读。
// 这是给你看的后台，不进她的认知。接口不可用时只显示提示。
import { api } from "../api.js";
import { h, mount } from "../ui.js";

const REFRESH_MS = 30_000;
const VITAL_LABELS = { energy: "精力", fullness: "饱腹", stress: "压力", missing: "想念", selfWorth: "自我感觉" };
const TENSION_LABELS = { book: "写那本书", seen: "被他看见" };
const BODY_LABELS = { valence: "愉悦", activation: "激活", energy: "精力", tension: "张力" };
const MODE_TEXT = { legacy: "旧版控制", shadow: "旧版控制，新内核只观察", body: "新内核控制" };
const SOURCE_TEXT = { him: "他", life: "她的生活", world: "外面", infer: "她的判断" };

function meter(label, value, min = 0) {
  const number = Math.round(Number(value) || 0);
  const percent = min < 0 ? (number - min) / 2 : number;
  return [h("span", null, `${label} ${number}`), h("div", { class: "lin-meter" }, h("span", { style: { width: `${Math.max(0, Math.min(100, percent))}%` } }))];
}

function bodyBlock(body) {
  if (!body?.values) return h("span", { class: "lin-field-hint" }, `新内核：${body?.status === "unavailable" ? "不可用" : "还在恢复"}（${MODE_TEXT[body?.mode] ?? "-"}）`);
  const bands = [body.bands?.lowEnergy ? "低精力" : null, body.bands?.highTension ? "高张力" : null, body.bands?.highActivation ? "高激活" : null, body.bands?.valence === "relaxed" ? "轻松余韵" : body.bands?.valence === "subdued" ? "低落余韵" : null].filter(Boolean);
  return h(
    "div",
    { class: "lin-form" },
    h("span", { class: "lin-field-label" }, `新内核（${MODE_TEXT[body.mode] ?? body.mode}）`),
    h("div", { class: "lin-inner-grid" }, Object.entries(BODY_LABELS).flatMap(([key, label]) => meter(label, body.values[key], key === "valence" ? -100 : 0))),
    h("span", { class: "lin-field-hint" }, `模拟心率 ${body.derived?.heartRate ?? "-"}（模拟值，不是生理测量）${body.derived?.asleep ? " · 睡着" : ""}`),
    h("span", { class: "lin-field-hint" }, `档位：${bands.length ? bands.join("、") : "正常"}${body.stale ? " · 快照过旧" : ""}`),
  );
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

export function renderInner(container) {
  const draw = async () => {
    try {
      const [inner, body] = await Promise.all([api.getInner(), api.getBody().catch(() => null)]);
      mount(
        container,
        h(
          "div",
          { class: "lin-form" },
          h("span", { class: "lin-field-label" }, "她的内心（只给你看）"),
          h(
            "div",
            { class: "lin-inner-grid" },
            Object.entries(VITAL_LABELS).flatMap(([key, label]) => meter(label, inner.vitals?.[key])),
            Object.entries(TENSION_LABELS).flatMap(([key, label]) => meter(`张力：${label}`, inner.tensions?.[key])),
            meter("防线", inner.guard),
          ),
          h("span", { class: "lin-field-hint" }, `现在：${inner.slot?.label ?? "-"}（${inner.slot?.tag ?? "空闲"}，${inner.availability ?? "-"}）`),
          inner.sick ? h("span", { class: "lin-field-hint" }, `生病/事件：${inner.sick.kind}，到 ${inner.sick.until}`) : null,
          inner.hints?.length ? h("span", { class: "lin-field-hint" }, `给她的提示：${inner.hints.join(" / ")}`) : h("span", { class: "lin-field-hint" }, "给她的提示：无"),
          h("span", { class: "lin-field-hint" }, inner.nextReply ? `下一条待回复：${new Date(inner.nextReply.dueAt).toLocaleString("zh-CN")}` : "没有待回复的消息"),
          inner.consolidationSkipped?.length ? h("span", { class: "lin-field-hint" }, `跳过的整理：${inner.consolidationSkipped.join("、")}`) : null,
          bodyBlock(body),
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
