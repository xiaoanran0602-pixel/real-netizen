// ============================================================
// 串行任务队列：聊天轮次、主动消息写入、日结任务、回档都排在同一条队列里，保证顺序、
// 保证整理和存档时没有聊天在写文件。
//   - enqueue(fn, {kind, front})  加入队列；front=true 插到最前（回档用）
//   - abortCurrent()             作废正在进行的任务（传给任务的 AbortSignal 触发）
//   - block(reason) / unblock()  阻塞：只有 kind="system" 且 force 的任务能跑（回档失败态）
// ============================================================

/**
 * @typedef {{fn: (signal: AbortSignal) => Promise<any>, kind: string, force: boolean, resolve: (v: any) => void, reject: (e: any) => void}} Task
 */

export function createTaskQueue({ onError } = {}) {
  /** @type {Task[]} */
  const tasks = [];
  let running = null;
  let controller = null;
  let blocked = null;
  let idleWaiters = [];

  function nextRunnable() {
    if (!blocked) return tasks.length > 0 ? 0 : -1;
    return tasks.findIndex((task) => task.force);
  }

  async function pump() {
    if (running) return;
    const index = nextRunnable();
    if (index < 0) {
      for (const resolve of idleWaiters.splice(0)) resolve();
      return;
    }
    const [task] = tasks.splice(index, 1);
    controller = new AbortController();
    running = task;
    try {
      task.resolve(await task.fn(controller.signal));
    } catch (error) {
      onError?.(error, task);
      task.reject(error);
    } finally {
      running = null;
      controller = null;
      queueMicrotask(() => void pump());
    }
  }

  return {
    /**
     * @template T
     * @param {(signal: AbortSignal) => Promise<T>} fn
     * @param {{kind?: string, front?: boolean, force?: boolean}} [options]
     * @returns {Promise<T>}
     */
    enqueue(fn, options = {}) {
      return new Promise((resolve, reject) => {
        const task = { fn, kind: options.kind ?? "turn", force: Boolean(options.force), resolve, reject };
        if (options.front) tasks.unshift(task);
        else tasks.push(task);
        void pump();
      });
    },
    abortCurrent() {
      controller?.abort();
    },
    /** 丢掉还在排队、尚未开始的某类任务。 */
    drop(kind, reason = "dropped") {
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        if (tasks[index].kind !== kind) continue;
        const [task] = tasks.splice(index, 1);
        task.reject(Object.assign(new Error(reason), { kind: "dropped" }));
      }
    },
    block(reason) {
      blocked = reason || "blocked";
    },
    unblock() {
      blocked = null;
      void pump();
    },
    blockedReason: () => blocked,
    size: () => tasks.length + (running ? 1 : 0),
    busy: () => Boolean(running),
    /** 队列空了（或只剩被阻塞的任务）时 resolve。 */
    idle() {
      if (!running && nextRunnable() < 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
