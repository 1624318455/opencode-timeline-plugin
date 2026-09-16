// TEMP-DIAG: “标题 0 但列表有数”的运行时定位日志,结论出来后整个文件删除.
// 日志路径见 diagPath()(Windows 下一般是 %TEMP%\timeline-debug.log).
// 所有写操作都是异步 fire-and-forget + 全吞错,fs 不可用时退化到 console.debug,绝不影响面板.

type FsLike = {
  appendFileSync(path: string, data: string): void;
  writeFileSync(path: string, data: string): void;
};

let fs: FsLike | null = null;
let tmp = "";
let primed = false;

// TEMP-DIAG: 日志按进程隔离（多进程同写一个文件会在 Windows 下互相顶掉单发日志行）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PID: string = (() => {
  try {
    const g = globalThis as { process?: { pid?: unknown } };
    if (typeof g.process?.pid === "number") return String(g.process.pid);
  } catch {
    /* ignore */
  }
  return `r${Math.random().toString(36).slice(2, 6)}`;
})();

async function ensure(): Promise<void> {
  if (primed) return;
  primed = true;
  try {
    // @ts-expect-error TEMP-DIAG: 宿主具备 node 内置模块,只是本仓库缺 @types/node
    const m = await import("node:fs");
    // @ts-expect-error TEMP-DIAG: 同上
    const o = await import("node:os");
    fs = m as FsLike;
    tmp = (o as { tmpdir(): string }).tmpdir();
  } catch {
    fs = null;
  }
}

/** 日志文件绝对路径(问用户要日志时把这个贴给他). */
export function diagPath(): string {
  return tmp ? `${tmp}/timeline-debug-${PID}.log` : "<tmpdir unknown>/timeline-debug.log";
}

/** 挂载时另起一段（追加,而非截断：同一进程重挂/多实例并存时截断会吃掉前一段日志）. */
export function diagReset(tag: string): void {
  void ensure().then(() => {
    const head = `=== ${new Date().toISOString()} ${tag} ===\n`;
    try {
      if (fs) fs.appendFileSync(diagPath(), head);
      else console.debug(`[timeline-diag] reset ${tag}`);
    } catch {
      /* ignore */
    }
  });
}

export function diagLog(msg: string): void {
  void ensure().then(() => {
    try {
      if (fs) fs.appendFileSync(diagPath(), `${new Date().toISOString()} ${msg}\n`);
      else console.debug(`[timeline-diag] ${msg}`);
    } catch {
      /* ignore */
    }
  });
}
