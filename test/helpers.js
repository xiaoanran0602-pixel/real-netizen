// 测试公用：临时数据目录、安静日志。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDir } from "../src/config/paths.js";
import { invalidateAllCaches } from "../src/store/files.js";
import { setLogQuiet } from "../src/util/log.js";

setLogQuiet(true);

/**
 * 递归删除临时目录；Windows 上文件句柄或延迟写入会让 `fs.rm` 偶发 ENOTEMPTY/EBUSY，
 * 重试几次即可，避免测试因为清理时序而 flaky。
 */
async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const transient = error?.code === "ENOTEMPTY" || error?.code === "EBUSY" || error?.code === "EPERM";
      if (!transient || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** 建一个临时 data 目录并切过去；返回目录与清理函数。 */
export async function useTempData(prefix = "lin-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  setDataDir(dir);
  invalidateAllCaches();
  return { dir, cleanup: () => removeTempDir(dir) };
}

/** 本地时间构造：month 从 1 开始。 */
export function at(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute);
}
