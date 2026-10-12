// 设置 →「聊天渠道」：按服务端给出的 fields 自动渲染每个渠道的凭据卡片（启用开关 + 字段 + 测试消息）。
// 她在所有已启用的渠道上和网页上是同一段对话、同一份记忆；主动消息由动态调度器统一发出。
import { api } from '../api.js';
import { errorText, field, h, mount, statusLine } from '../ui.js';
import { runBusy } from './form.js';

const SECRET_PLACEHOLDER = '已填写，留空不改';

export function renderChannels(container) {
  const status = statusLine();
  /** @type {Map<string, {enabled: HTMLInputElement, inputs: Map<string, HTMLInputElement>, fields: any[]}>} */
  const cards = new Map();

  function apply(channel) {
    const card = cards.get(channel.id);
    if (!card) return;
    const values = channel.values ?? { enabled: false };
    card.enabled.checked = Boolean(values.enabled);
    for (const def of channel.fields) {
      const input = card.inputs.get(def.key);
      if (def.secret) {
        const masked = values[def.key];
        input.value = '';
        input.placeholder = masked?.set ? `${SECRET_PLACEHOLDER}（末 4 位 ${masked.tail ?? ''}）` : '';
      } else {
        input.value = typeof values[def.key] === 'string' ? values[def.key] : '';
      }
    }
  }

  function buildCard(channel) {
    const inputs = new Map();
    for (const def of channel.fields) {
      inputs.set(def.key, h('input', { class: 'lin-text-input', type: def.secret ? 'password' : 'text', autocomplete: 'off' }));
    }
    const enabled = h('input', { type: 'checkbox' });
    const saveButton = h('button', { type: 'button', class: 'lin-primary' }, '保存');
    const testButton = h('button', { type: 'button', class: 'lin-secondary' }, '发送测试消息');
    const buttons = [saveButton, testButton];
    cards.set(channel.id, { enabled, inputs, fields: channel.fields });

    saveButton.addEventListener('click', () =>
      void runBusy(buttons, status, '正在保存', async () => {
        const patch = { enabled: enabled.checked };
        for (const def of channel.fields) {
          const value = inputs.get(def.key).value.trim();
          if (def.secret && !value) continue;
          patch[def.key] = value;
        }
        const result = await api.saveChannels({ [channel.id]: patch });
        if (result.values?.[channel.id]) channel.values = result.values[channel.id];
        apply(channel);
        return '已保存';
      }),
    );
    testButton.addEventListener('click', () =>
      void runBusy(buttons, status, '正在测试', async () => {
        const result = await api.testChannel(channel.id);
        return result.ok ? `连通了，${channel.label} 上应该收到一句「在吗」` : `没连上：${result.error ?? ''}`;
      }),
    );

    return h(
      'div',
      { class: 'lin-card' },
      h('div', { class: 'lin-card-title' }, channel.label),
      channel.hint ? h('span', { class: 'lin-field-hint' }, channel.hint) : null,
      ...channel.fields.map((def) => field(def.label, inputs.get(def.key), def.hint)),
      field('启用', enabled),
      h('div', { class: 'lin-form-actions' }, ...buttons),
    );
  }

  async function build() {
    const spec = await api.getChannels();
    const proactiveButton = h('button', { type: 'button', class: 'lin-secondary' }, '让她现在找你');
    proactiveButton.addEventListener('click', () =>
      void runBusy([proactiveButton], status, '她在想发什么', async () => {
        const result = await api.tickMoments('message');
        return result.action === 'message' ? `她发了：${result.detail ?? ''}` : `这次没发（${result.detail ?? result.action}）`;
      }),
    );
    const body = h(
      'div',
      { class: 'lin-form' },
      h('span', { class: 'lin-field-hint' }, '填好一个渠道，她就能在那个平台上和你聊天；可以同时启用多个，她会同时在线。'),
      ...spec.channels.map((channel) => buildCard(channel)),
      h('div', { class: 'lin-form-actions' }, proactiveButton),
      status.el,
    );
    spec.channels.forEach(apply);
    mount(container, body);
  }

  mount(container, status.el, h('span', { class: 'lin-field-hint' }, '正在读取渠道…'));
  void build().catch((error) => status.set(errorText(error)));
}
