import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { normalizeSettings, readSettings, updateSettings, validateSettingsPatch } from "../src/config/settings.js";
import {
  ensureAccessToken,
  isChannelReady,
  maskChannelSecrets,
  maskModelSecrets,
  mergeModelPatch,
  normalizeModelSecrets,
  pickChannelPatch,
  readChannelSecrets,
  readModelSecrets,
  updateModelSecrets,
  writeChannelSecrets,
} from "../src/config/secrets.js";
import { useTempData } from "./helpers.js";

test("settings defaults: low reasoning, clamped tokens, day boundary 4, can get sick", () => {
  const settings = normalizeSettings({ reasoningLevel: "ultra", maxOutputTokens: 999999 });
  assert.equal(settings.reasoningLevel, "low");
  assert.equal(settings.maxOutputTokens, 8192);
  assert.equal(settings.dayBoundaryHour, 4);
  assert.equal(settings.canGetSick, true);
  assert.equal(settings.backgroundReasoningLevel, "medium");
  assert.equal(settings.sickMissCap, 85);
  assert.equal(settings.userName, "");
  assert.equal(settings.imageModel, "gpt-image-1");
  assert.equal(settings.imagesEnabled, true);
});

test("settings: userName 可以为空，imageModel / imagesEnabled 可改", () => {
  const settings = normalizeSettings({ userName: "  ", imageModel: "gpt-image-2", imagesEnabled: false });
  assert.equal(settings.userName, "");
  assert.equal(settings.imageModel, "gpt-image-2");
  assert.equal(settings.imagesEnabled, false);
  const patch = validateSettingsPatch({ imageModel: "gpt-image-1", imagesEnabled: true, userName: "阿澄" });
  assert.deepEqual(patch.rejected, []);
  assert.equal(patch.accepted.imageModel, "gpt-image-1");
  assert.equal(validateSettingsPatch({ imageModel: 123 }).rejected[0], "imageModel");
});

test("settings: legacy memoryReasoningLevel maps to backgroundReasoningLevel; mainTaskId dropped", () => {
  const settings = normalizeSettings({ memoryReasoningLevel: "high", mainTaskId: "x", memoryModelId: "m" });
  assert.equal(settings.backgroundReasoningLevel, "high");
  assert.equal("mainTaskId" in settings, false);
  assert.equal("memoryModelId" in settings, false);
});

test("settings patch validation rejects unknown and invalid fields", () => {
  const { accepted, rejected } = validateSettingsPatch({ theme: "dark", dayBoundaryHour: 9, foo: 1, reasoningLevel: "off" });
  assert.deepEqual(accepted, { theme: "dark", reasoningLevel: "off" });
  assert.deepEqual(rejected.sort(), ["dayBoundaryHour", "foo"]);
});

test("settings read/write roundtrip in data dir", async () => {
  const { cleanup } = await useTempData();
  try {
    assert.equal((await readSettings()).companionName, "林澈");
    const result = await updateSettings({ companionName: "澈", canGetSick: false });
    assert.deepEqual(result.rejected, []);
    const settings = await readSettings();
    assert.equal(settings.companionName, "澈");
    assert.equal(settings.canGetSick, false);
    assert.equal((await updateSettings({ fontSize: 99 })).rejected[0], "fontSize");
  } finally {
    await cleanup();
  }
});

test("model secrets: mask never returns full key; blank key keeps old one", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateModelSecrets({ protocol: "openai", baseUrl: "https://example.test/v1", apiKey: "sk-abcdef123456", chatModel: "m1" });
    let secrets = await readModelSecrets();
    const masked = maskModelSecrets(secrets);
    assert.equal(masked.hasApiKey, true);
    assert.equal(masked.apiKeyTail, "3456");
    assert.equal(JSON.stringify(masked).includes("sk-abcdef"), false);
    await updateModelSecrets({ apiKey: "", chatModel: "m2", backgroundModel: "" });
    secrets = await readModelSecrets();
    assert.equal(secrets.apiKey, "sk-abcdef123456");
    assert.equal(secrets.chatModel, "m2");
    assert.equal(secrets.protocol, "openai");
    await updateModelSecrets({ apiKey: "new-key-9999" });
    assert.equal((await readModelSecrets()).apiKey, "new-key-9999");
  } finally {
    await cleanup();
  }
});

test("model secrets: invalid protocol / url rejected", () => {
  const current = normalizeModelSecrets({});
  assert.deepEqual(mergeModelPatch(current, { protocol: "grpc" }).rejected, ["protocol"]);
  assert.deepEqual(mergeModelPatch(current, { baseUrl: "ftp://x" }).rejected, ["baseUrl"]);
});

test("channel secrets: blank secret fields keep old values, mask hides them", async () => {
  const { cleanup } = await useTempData();
  try {
    await writeChannelSecrets({ telegram: { enabled: true, botToken: "sk-tok-123456", ownerChatId: "10086" } });
    const patch = pickChannelPatch({ telegram: { botToken: "", ownerChatId: "  42  ", unknownField: "x" } });
    await writeChannelSecrets(patch);
    const config = await readChannelSecrets();
    assert.equal(config.telegram.botToken, "sk-tok-123456");
    assert.equal(config.telegram.ownerChatId, "42");
    assert.equal(config.telegram.enabled, true);
    assert.equal(isChannelReady("telegram", config), true);
    const masked = maskChannelSecrets(config);
    assert.equal(masked.telegram.botToken.set, true);
    assert.equal(masked.telegram.botToken.tail, "3456");
    assert.equal(JSON.stringify(masked).includes("sk-tok-123456"), false);
  } finally {
    await cleanup();
  }
});

test("access token is generated once and reused", async () => {
  const { cleanup } = await useTempData();
  try {
    await mkdir(paths.secrets(), { recursive: true });
    const first = await ensureAccessToken();
    assert.ok(first.length >= 24);
    assert.equal(await ensureAccessToken(), first);
    await writeFile(paths.accessToken(), "fixed-token\n");
    assert.equal(await ensureAccessToken(), "fixed-token");
    assert.equal((await readFile(paths.accessToken(), "utf8")).trim(), "fixed-token");
  } finally {
    await cleanup();
  }
});
