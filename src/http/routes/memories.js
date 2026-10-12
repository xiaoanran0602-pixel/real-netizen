// ============================================================
// 她记得的事（memory/*.md）与她的日子（memory/life/*.md）。
//   GET    /api/lin/memories             每条附清晰度、上次想起、重要程度、记牢、概括
//   PUT    /api/lin/memories/:file       过去的 event/day 403；手动编辑视为想起一次
//   DELETE /api/lin/memories/:file       过去的 403；同时清掉强度记录
//   PUT    /api/lin/memories/:file/pin   {pinned}
//   GET    /api/lin/life                 每份附 editable
//   PUT    /api/lin/life/:file           只有未来的和 future.md 能改
// 规则全部来自 companion/write-guard.js（与记忆整理同一套）。
// ============================================================

import { join } from "node:path";
import { paths } from "../../config/paths.js";
import { evaluateWebLifeEdit, evaluateWebMemoryEdit, isEditableLifeFile } from "../../companion/write-guard.js";
import { invalidateMemoryCache, MEMORY_FILE_PATTERN, parseMemoryFile, readMemories } from "../../companion/memory.js";
import { annotate, forgetRecord, readStrengthTable, recallMemories, setPinned, syncStrength } from "../../companion/strength.js";
import { listDir, readText, removeFile, writeTextAtomic } from "../../store/files.js";
import { formatLocalDate } from "../../util/time.js";
import { HttpError } from "../router.js";

export const MEMORY_MAX_CHARS = 20_000;
const INDEX_FILE = "MEMORY.md";

function memoryFile(ctx) {
  const file = ctx.params.file;
  if (!MEMORY_FILE_PATTERN.test(file) || file === INDEX_FILE) throw new HttpError(400, "invalid file name");
  return file;
}

async function contentOf(ctx) {
  const body = await ctx.body();
  if (typeof body.content !== "string" || body.content.length > MEMORY_MAX_CHARS) throw new HttpError(400, "invalid content");
  return body.content;
}

/** @param {ReturnType<import("../router.js").createRouter>} router */
export function registerMemoryRoutes(router) {
  router.get("/api/lin/memories", async () => {
    const memories = await readMemories();
    await syncStrength(memories);
    const table = await readStrengthTable();
    const annotated = annotate(memories, table, formatLocalDate());
    const items = await Promise.all(
      annotated.map(async (entry) => ({
        file: entry.file,
        content: (await readText(join(paths.memory(), entry.file))) ?? "",
        clarity: entry.clarity,
        lastRecalled: entry.record.lastRecalled ?? null,
        importance: entry.record.importance,
        pinned: Boolean(entry.record.pinned),
        gist: entry.record.gist || "",
      })),
    );
    return { memories: items };
  });

  router.put("/api/lin/memories/:file/pin", async (ctx) => {
    const file = memoryFile(ctx);
    const body = await ctx.body();
    if (typeof body.pinned !== "boolean") throw new HttpError(400, "invalid pinned");
    const entry = (await readMemories()).find((item) => item.file === file);
    if (!entry) throw new HttpError(404, "not found");
    await setPinned(entry, body.pinned);
    return { ok: true, pinned: body.pinned };
  });

  router.put("/api/lin/memories/:file", async (ctx) => {
    const file = memoryFile(ctx);
    const decision = evaluateWebMemoryEdit({ file, op: "write" });
    if (!decision.allowed) throw new HttpError(403, decision.reason);
    const content = await contentOf(ctx);
    const parsed = parseMemoryFile(content);
    if (!parsed) throw new HttpError(400, "记忆格式不对（需要 --- 开头的文件头）");
    await writeTextAtomic(join(paths.memory(), file), content);
    invalidateMemoryCache();
    // 网页手动编辑一条记忆，视为想起一次（design §11.6）。
    await recallMemories([{ ...parsed, file }], formatLocalDate());
    return { ok: true };
  });

  router.delete("/api/lin/memories/:file", async (ctx) => {
    const file = memoryFile(ctx);
    const decision = evaluateWebMemoryEdit({ file, op: "delete" });
    if (!decision.allowed) throw new HttpError(403, decision.reason);
    await removeFile(join(paths.memory(), file));
    invalidateMemoryCache();
    await forgetRecord(file);
    return { ok: true };
  });

  router.get("/api/lin/life", async () => {
    const names = (await listDir(paths.life())).filter((name) => name.endsWith(".md"));
    const files = await Promise.all(names.map(async (name) => ({ file: name, content: (await readText(join(paths.life(), name))) ?? "", editable: isEditableLifeFile(name) })));
    files.sort((a, b) => b.file.localeCompare(a.file));
    return { files };
  });

  router.put("/api/lin/life/:file", async (ctx) => {
    const file = ctx.params.file;
    if (!MEMORY_FILE_PATTERN.test(file)) throw new HttpError(400, "invalid file name");
    const decision = evaluateWebLifeEdit(file);
    if (!decision.allowed) throw new HttpError(403, decision.reason);
    await writeTextAtomic(join(paths.life(), file), await contentOf(ctx));
    return { ok: true };
  });
}
