// 回档：存档去重、清单原子性、恢复后文件与清单一致且多余文件被删、重复执行结果相同、
// 中断后启动进入失败态、删除更早存档后剩余存档仍可恢复、范围外文件（settings/secrets/persona/core）不受影响。
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { createChatService } from "../src/chat/chat-service.js";
import { archiveBytes, listArchiveDays, readManifest, snapshot } from "../src/archive/snapshot.js";
import { applyManifest, createRestorer, deleteArchivesBefore } from "../src/archive/restore.js";
import { getMainConversationId, invalidateConversations, readConversation } from "../src/store/conversation.js";
import { readState, updateState } from "../src/store/state.js";
import { useTempData } from "./helpers.js";

const deps = { boundaryHour: 4, companionName: "林澈", userName: "阿澄" };
const memory = (body) => `---\nname: x\nmetadata:\n  type: self\n---\n${body}\n`;

let clock = new Date(2026, 9, 1, 20);

async function setup() {
  const ctx = await useTempData();
  const service = createChatService({ complete: async (o) => `回：${o.messages.at(-1).content}`, buildPrompt: async () => ({ system: "S" }), now: () => clock });
  await mkdir(paths.memory(), { recursive: true });
  await mkdir(paths.secrets(), { recursive: true });
  await writeFile(paths.settings(), JSON.stringify({ companionName: "林澈" }));
  await writeFile(paths.persona(), "人设 v1");
  await writeFile(paths.core(), "基石 v1");
  await writeFile(paths.modelSecrets(), JSON.stringify({ apiKey: "k1" }));
  return { ...ctx, service };
}

async function day(service, n, text) {
  clock = new Date(2026, 9, n, 20, 1);
  await service.sendUserMessage(text, { source: "web", at: new Date(2026, 9, n, 20).getTime() });
  await writeFile(join(paths.memory(), `day${n}.md`), memory(`第${n}天记住的`));
  await writeFile(paths.momentsProfile(), JSON.stringify({ signature: { text: `签名${n}` }, history: [] }));
  await writeFile(paths.inner(), JSON.stringify({ vitals: { energy: n * 10 } }));
  return snapshot(`2026-10-0${n}`, deps);
}

test("snapshots dedupe objects and write complete manifests with summary", async () => {
  const { cleanup, service } = await setup();
  try {
    const first = await day(service, 1, "第一天");
    assert.equal(first.summary.messages, 2);
    assert.equal(first.summary.lastLine, "林澈：回：第一天");
    assert.equal(first.summary.newMemories, 1);
    assert.ok(first.files["profile.json"] && first.files["inner.json"]);
    assert.equal(Object.keys(first.files).some((rel) => rel.startsWith("secrets") || rel === "settings.json" || rel === "persona.md" || rel === "core.md"), false);
    const bytes = await archiveBytes();
    await snapshot("2026-10-02", deps);
    // 内容没变：只多一个清单文件。
    const after = await archiveBytes();
    const manifestSize = (await readFile(join(paths.archiveDays(), "2026-10-02.json"))).length;
    assert.equal(after - bytes, manifestSize);
    assert.equal((await readdir(paths.archiveDays())).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await cleanup();
  }
});

test("restore makes files equal the manifest, deletes extras, keeps settings/persona/core/secrets, is idempotent", async () => {
  const { cleanup, service } = await setup();
  try {
    await day(service, 1, "第一天");
    await day(service, 2, "第二天");
    await day(service, 3, "第三天");
    await writeFile(paths.persona(), "人设 v2");
    await writeFile(paths.settings(), JSON.stringify({ companionName: "改了" }));
    await writeFile(paths.modelSecrets(), JSON.stringify({ apiKey: "k2" }));
    const restorer = createRestorer({ chatService: service });
    const status = await restorer.restore("2026-10-01", "10-01");
    assert.equal(status.status, "done");
    invalidateConversations();
    const messages = await readConversation(await getMainConversationId());
    assert.deepEqual(messages.map((m) => m.text), ["第一天", "回：第一天"]);
    assert.deepEqual((await readdir(paths.memory())).filter((n) => n.endsWith(".md")), ["day1.md"]);
    assert.equal(JSON.parse(await readFile(paths.momentsProfile(), "utf8")).signature.text, "签名1");
    assert.equal(JSON.parse(await readFile(paths.inner(), "utf8")).vitals.energy, 10);
    assert.equal(await readFile(paths.persona(), "utf8"), "人设 v2");
    assert.equal(await readFile(paths.core(), "utf8"), "基石 v1");
    assert.equal(JSON.parse(await readFile(paths.settings(), "utf8")).companionName, "改了");
    assert.equal(JSON.parse(await readFile(paths.modelSecrets(), "utf8")).apiKey, "k2");
    // 她觉得你两天没来：上次聊天时间回到第一天。
    const state = await readState();
    assert.equal(state.lastUserMessageAt, new Date(2026, 9, 1, 20).getTime());
    assert.equal(state.lastSnapshotDay, "2026-10-01");
    assert.equal(state.restoring, undefined);
    assert.deepEqual(await listArchiveDays(), ["2026-10-01"]);
    // 再执行一次恢复步骤，结果不变。
    const again = await applyManifest(await readManifest("2026-10-01"));
    assert.deepEqual(again, { written: 0, removed: 0 });
  } finally {
    await cleanup();
  }
});

test("interrupted restore → failed on startup, chat blocked; retry completes", async () => {
  const { cleanup, service } = await setup();
  try {
    await day(service, 1, "第一天");
    await day(service, 2, "第二天");
    await updateState({ restoring: { day: "2026-10-01", startedAt: Date.now() } });
    const restorer = createRestorer({ chatService: service });
    assert.equal(await restorer.checkOnStartup(), true);
    assert.equal(restorer.status().status, "failed");
    const pending = service.submitUserMessage("回档中发的", { source: "web" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    invalidateConversations();
    assert.equal((await readConversation(await getMainConversationId())).some((m) => m.text === "回档中发的"), false);
    assert.equal((await restorer.restore("2026-10-01", "10-01")).status, "done");
    await pending.done;
    invalidateConversations();
    const texts = (await readConversation(await getMainConversationId())).map((m) => m.text);
    assert.deepEqual(texts, ["第一天", "回：第一天", "回档中发的", "回：回档中发的"]);
  } finally {
    await cleanup();
  }
});

test("wrong confirmation or missing archive is rejected; failing restore enters failed state", async () => {
  const { cleanup, service } = await setup();
  try {
    await day(service, 1, "第一天");
    const restorer = createRestorer({ chatService: service });
    await assert.rejects(restorer.restore("2026-10-01", "10-02"), /确认日期/u);
    await assert.rejects(restorer.restore("2026-10-09", "10-09"), /没有/u);
    // 让恢复必然失败：删掉 day1.md 对应的对象，并把当前文件改掉（迫使恢复去读那个对象）。
    const manifest = await readManifest("2026-10-01");
    const hash = manifest.files["memory/day1.md"];
    const { rm } = await import("node:fs/promises");
    await rm(join(paths.archiveObjects(), hash.slice(0, 2), hash));
    await writeFile(join(paths.memory(), "day1.md"), "改坏了");
    const status = await restorer.restore("2026-10-01", "10-01");
    assert.equal(status.status, "failed");
    assert.ok((await readState()).restoring);
  } finally {
    await cleanup();
  }
});

test("delete older archives keeps the rest restorable and frees unreferenced objects", async () => {
  const { cleanup, service } = await setup();
  try {
    await day(service, 1, "第一天");
    await day(service, 2, "第二天");
    await day(service, 3, "第三天");
    const before = await archiveBytes();
    const result = await deleteArchivesBefore("2026-10-03");
    assert.equal(result.removedDays, 2);
    assert.ok(result.freedBytes > 0);
    assert.ok((await archiveBytes()) < before);
    assert.deepEqual(await listArchiveDays(), ["2026-10-03"]);
    await assert.rejects(deleteArchivesBefore("2026-10-09"), /至少要留一份/u);
    const restorer = createRestorer({ chatService: service });
    assert.equal((await restorer.restore("2026-10-03", "10-03")).status, "done");
  } finally {
    await cleanup();
  }
});
