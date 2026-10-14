// 她的日子：文件命名、解析、只补缺写入、同日单飞、零点预生成时刻。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { buildLifeGenerationPrompt, lifeFileNames, lifePath, missingLifeLayers, parseLifeGeneration, readLife, writeMissingLifeFiles, formatLife } from "../src/companion/life.js";
import { ensureLife, msUntilNextLifePrewarm, setLifeFactsProvider } from "../src/companion/life-scheduler.js";
import { lifeKeys } from "../src/util/time.js";
import { useFakeModel } from "./fake-model.js";
import { at, useTempData } from "./helpers.js";

const now = at(2026, 10, 10, 14, 30);

test("life keys use ISO week", () => {
  const keys = lifeKeys(now);
  assert.equal(keys.today, "2026-10-10");
  assert.equal(keys.weekday, "星期六");
  assert.equal(keys.week, "2026-W41");
  assert.equal(keys.month, "2026-10");
  assert.deepEqual(lifeFileNames(keys), { year: "year-2026.md", month: "month-2026-10.md", week: "week-2026-W41.md", day: "day-2026-10-10.md", future: "future.md" });
});

test("parse life generation sections", () => {
  const parsed = parseLifeGeneration("=== WEEK ===\n周一上班\n=== DAY ===\n08:30 [起床] 起床\n09:00 [出门] 出门\n");
  assert.equal(parsed.week, "周一上班");
  assert.equal(parsed.day, "08:30 [起床] 起床\n09:00 [出门] 出门");
});

test("generation prompt asks for tags and includes facts", () => {
  const prompt = buildLifeGenerationPrompt({ persona: "P", companionName: "林澈", userName: "阿澄", keys: lifeKeys(now), missing: ["day"], existing: { recentDays: [] }, selfMemories: "", facts: ["她今天感冒了"] });
  assert.match(prompt, /=== DAY ===/u);
  assert.match(prompt, /\[起床\]/u);
  assert.match(prompt, /她今天感冒了/u);
  assert.doesNotMatch(prompt, /=== YEAR ===/u);
});

test("life prewarm fires just after next local midnight", () => {
  assert.equal(msUntilNextLifePrewarm(at(2026, 10, 10, 23, 59)), 60_000 + 2 * 60_000);
});

test("write only missing files; never overwrite existing", async () => {
  const { cleanup } = await useTempData();
  try {
    await mkdir(paths.life(), { recursive: true });
    await writeFile(lifePath("day-2026-10-10.md"), "原日程\n");
    const written = await writeMissingLifeFiles(lifeKeys(now), { day: "新日程", week: "这一周" });
    assert.deepEqual(written, ["week"]);
    assert.equal(await readFile(lifePath("day-2026-10-10.md"), "utf8"), "原日程\n");
    assert.deepEqual(await missingLifeLayers(now), ["year", "month", "future"]);
    await writeFile(lifePath("day-2026-10-09.md"), "昨天\n去天文台");
    const life = await readLife(now);
    assert.equal(life.recentDays[0].date, "2026-10-09");
    assert.match(formatLife(life, lifeKeys(now)), /她最近几天：\n- 2026-10-09：昨天 去天文台/u);
  } finally {
    await cleanup();
  }
});

test("ensureLife generates once per day even with concurrent callers, using the background model", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: "=== YEAR ===\n今年\n=== MONTH ===\n本月\n=== WEEK ===\n本周\n=== DAY ===\n08:30 [起床] 起来了\n=== FUTURE ===\n以后" }));
  setLifeFactsProvider(async () => ["她这几天加班"]);
  try {
    const [a, b] = await Promise.all([ensureLife(now), ensureLife(now)]);
    assert.deepEqual(a, ["year", "month", "week", "day", "future"]);
    assert.deepEqual(b, a);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].body.model, "bg-m");
    assert.match(fake.requests[0].body.messages[0].content, /她这几天加班/u);
    assert.deepEqual(await ensureLife(now), []);
    assert.equal(fake.requests.length, 1);
  } finally {
    setLifeFactsProvider(async () => []);
    await fake.close();
    await cleanup();
  }
});
