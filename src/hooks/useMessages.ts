import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { TimelineNode } from "../types";
import { countUserMessages, getSessionNodes, jumpToMessage, subscribeTimeline } from "../api/opencode";
import { diagLog, diagReset } from "../api/diag"; // TEMP-DIAG: 结论出来后删除

export interface UseMessagesOptions {
  readonly maxItems?: number;
}

export interface UseMessagesResult {
  readonly nodes: () => readonly TimelineNode[];
  /** 快照签名（长度+首尾 id），面板层据此翻转标题重挂开关 */
  readonly sig: () => string;
  /** 标题重挂钥匙：follow effect（已证实每次都跑）里签名一变就 +1，面板用 <Key> 整块重挂标题 */
  readonly paintKey: () => number;
  readonly userTotal: () => number;
  readonly selectedId: () => string | null;
  readonly setSelectedId: (id: string | null) => void;
  readonly visible: () => boolean;
  readonly loading: () => boolean;
  readonly toggle: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly confirmSelection: () => void;
  readonly refresh: () => void;
}

/** sessionID 支持传值或 accessor（sidebar 切会话时 props 更新但组件不重挂，必须响应式跟随） */
type SessionIDSource = string | (() => string);
function readSessionID(src: SessionIDSource): string {
  return typeof src === "function" ? (src as () => string)() : src;
}

/** 快照签名：长度 + 首尾 id,轮询比对用（命中则跳过 bump,避免无谓重算） */
function sigOf(list: readonly TimelineNode[]): string {
  return list.length === 0
    ? "0"
    : `${list.length}:${list[0]!.id.slice(0, 8)}..${list[list.length - 1]!.id.slice(0, 8)}`;
}

/**
 * 会话消息列表 Hook（混合模式）。
 *
 * 宿主真相：`api.state.session.messages()` 是快照语义，纯 memo 派生不会自动
 * 订阅更新（诊断行能刷出 total=100 时 nodes 照样是 0）。所以这里三路驱动：
 * 1) `api.event.on(...)` 事件 → trailing 合并 → bump（主链路）；
 * 2) 切会话/挂载后的延迟 catch-up bump（兜住历史回填直接写 store、不经过事件的窗口）；
 * 3) 2s 轮询签名比对（兜住冷启动回填晚到、外部写入、漏事件；命中签名则不 bump）。
 */
let mountCounter = 0; // TEMP-DIAG: 实例计数,与随机前缀一起区分“双实例”与“会话抖动”

export function useMessages(
  api: TuiPluginApi,
  sessionID: SessionIDSource,
  options: UseMessagesOptions = {},
): UseMessagesResult {
  const maxItems = options.maxItems ?? 50;
  const id = () => readSessionID(sessionID);
  const iid = `${Math.random().toString(36).slice(2, 6)}:${++mountCounter}`; // TEMP-DIAG

  diagReset(`mount iid=${iid} sid=${id()}`); // TEMP-DIAG
  onCleanup(() => diagLog(`[${iid}] unmount sid=${id()}`)); // TEMP-DIAG: 进程退出/热重载泄漏都能看见

  // 显式刷新令牌：事件/切会话/轮询都经由此驱动快照重读
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  // 快照派生：只依赖 version + 会话 id，不赌宿主响应式语义
  const nodes = createMemo(() => {
    version();
    const sid = id();
    const list = getSessionNodes(api, sid, maxItems);
    diagLog(`[${iid}] nodes recompute sid=${sid.slice(0, 13)} len=${list.length} sig=${sigOf(list)}`); // TEMP-DIAG
    return list;
  });
  const userTotal = createMemo(() => {
    version();
    return countUserMessages(api, id());
  });
  // R16 探针：宿主信号是否对我方 memo 可见（单副本?）——故意不读 version，
  // 只读 api.state 快照。若它在宿主数据变化时自发重跑（无 bump），说明跨副本订阅是通的，
  // 下轮可删掉整套 version/事件/轮询机器，改走原生纯 memo 写法（mcp.tsx 同款）。
  const probeNodes = createMemo(() => getSessionNodes(api, id(), maxItems));
  createEffect(() => {
    const l = probeNodes();
    diagLog(`[${iid}] HOST-PROBE len=${l.length} sig=${sigOf(l)}`); // TEMP-DIAG R16
  });
  // 与 nodes 同源同拍的签名（不另读快照），标题重挂开关跟踪它
  const sig = createMemo(() => {
    const s = sigOf(nodes());
    diagLog(`[${iid}] sig recompute -> ${s}`); // TEMP-DIAG: 验证 memo→effect 链是否断掉
    return s;
  });
  // 标题重挂钥匙：由下面已证实可靠的 follow effect 驱动（不赌 sig memo→面板 effect 链）。
  // follow effect 每次 nodes 变化都跑（日志实锤），在这里比对签名，变了就 +1。
  const [paintKey, setPaintKey] = createSignal(0);
  let prevPaintSig = "";
  // 空态区分：有节点就不算加载中；节点为空时，store 未就绪或会话尚未同步即“加载中”。
  // session.get 抛错时按加载中处理，绝不把异常抛给渲染层（否则整面板挂掉变“空”）。
  const loading = createMemo(() => {
    if (nodes().length > 0) return false;
    try {
      if (!api.state.ready) return true;
    } catch {
      return true;
    }
    try {
      return api.state.session.get(id()) === undefined;
    } catch {
      return true;
    }
  });

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [visible, setVisible] = createSignal(true);
  const [kvRestored, setKvRestored] = createSignal(false);

  const restoreKv = (list: readonly TimelineNode[]): boolean => {
    try {
      const last = api.kv.get<string | null>(`timeline.viewer:last:${id()}`, null);
      if (last && list.some((n) => n.id === last)) {
        setSelectedId(last);
        return true;
      }
    } catch {
      // kv 未就绪则跳过
    }
    return false;
  };

  const followSelection = (list: readonly TimelineNode[]) => {
    if (list.length === 0) {
      setSelectedId(null);
      return;
    }
    // on() 的 fn 不跟踪内部读取，读 selectedId 安全
    if (list.some((n) => n.id === selectedId())) return; // 保持用户当前选中，不抢夺
    if (!kvRestored()) {
      setKvRestored(true);
      if (restoreKv(list)) return;
    }
    setSelectedId(list[list.length - 1]!.id);
  };

  // 事件订阅：按当前会话过滤，随会话切换重建，随面板卸载注销。
  // subscribeTimeline 内部已做 100ms trailing 合并。
  // 注意：不用 on() 包——实测 on() 包的效果在宿主里不触发，改普通 effect + 手动比对。
  createEffect(() => {
    const sid = id();
    diagLog(`[${iid}] subscribe sid=${sid.slice(0, 13)}`); // TEMP-DIAG
    const off = subscribeTimeline(api, sid, () => {
      diagLog(`[${iid}] bump by event`); // TEMP-DIAG
      bump();
    });
    onCleanup(off);
    return off;
  });

  // 切会话/挂载：重置选中与 kv 恢复标记，并补延迟 bump，
  // 兜住“宿主历史回填直接写 store、不经过事件”的窗口（回填完成前读到的都是空快照）。
  // 冷启动时回填可能要几秒，所以拉到 6s。
  // 不用 on()：同上，普通 effect + prev 比对（mount 即第一次 switch）。
  const CATCH_UP_DELAYS = [0, 500, 1500, 3000, 6000];
  let prevSid: string | null = null;
  createEffect(() => {
    const sid = id();
    if (prevSid === sid) return;
    prevSid = sid;
    setKvRestored(false);
    setSelectedId(null);
    diagLog(`[${iid}] switch sid=${sid}`); // TEMP-DIAG
    const timers = CATCH_UP_DELAYS.map((ms) =>
      setTimeout(() => {
        diagLog(`[${iid}] bump catchup +${ms}ms`); // TEMP-DIAG
        bump();
      }, ms),
    );
    onCleanup(() => timers.forEach((t) => clearTimeout(t)));
  });

  // 兜底轮询：签名变化才 bump。覆盖冷启动回填晚到、外部写入、漏事件等一切“无事件但有数据”的时机。
  // 宿主侧可借用的更新时机就这三类：api.event 事件流、切会话（slot props）、lifecycle（仅卸载）——
  // 除此之外没有“数据到达”回调，所以轮询是最后的确定性手段。
  let lastSig = "";
  // 不用 on()：同上。followSelection 内部读 selectedId/kvRestored，用 untrack 包住避免循环跟踪。
  // 顺带驱动 paintKey：签名一变就 +1（面板用 <Key> 整块重挂标题，不赌 sig memo→面板 effect 链）。
  // R15：每次快照重读后显式请求宿主重绘——插件副本的自有信号变更不会经过宿主的渲染调度，
  // 靠 api.renderer.requestRender() 把新值刷上屏（折叠/挂载能画，就是宿主渲染触发的；这里手动触发同款）。
  createEffect(() => {
    const list = nodes();
    lastSig = sigOf(list);
    const s = lastSig;
    if (prevPaintSig !== s) {
      prevPaintSig = s;
      diagLog(`[${iid}] paintKey bump -> ${s}`); // TEMP-DIAG
      untrack(() => setPaintKey((k) => k + 1));
    }
    diagLog(`[${iid}] follow len=${list.length} sel=${selectedId() ?? "-"}`); // TEMP-DIAG
    untrack(() => {
      followSelection(list);
      try {
        api.renderer.requestRender();
      } catch {
        /* 渲染器不可用时忽略，下轮还会再试 */
      }
    });
  });
  const pollTimer = setInterval(() => {
    try {
      const next = getSessionNodes(api, id(), maxItems);
      const sig = sigOf(next);
      if (sig !== lastSig) {
        diagLog(`[${iid}] bump poll sig ${lastSig || "-"} -> ${sig}`); // TEMP-DIAG
        bump();
      }
    } catch {
      /* 快照读失败就等下一轮 */
    }
  }, 2000);
  onCleanup(() => clearInterval(pollTimer));

  const toggle = () => setVisible((v) => !v);

  const moveSelection = (delta: number) => {
    const list = nodes();
    if (list.length === 0) return;
    const idx = list.findIndex((n) => n.id === selectedId());
    const next = Math.min(list.length - 1, Math.max(0, (idx < 0 ? list.length - 1 : idx) + delta));
    setSelectedId(list[next]!.id);
  };

  const confirmSelection = () => {
    const selected = selectedId();
    if (selected) jumpToMessage(api, id(), selected);
  };

  // 手动刷新位：事件驱动下通常不需要，保留给外部调用方（兜底重读一次快照）
  const refresh = () => {
    bump();
    followSelection(nodes());
  };

  return {
    nodes,
    sig,
    paintKey,
    userTotal,
    selectedId,
    setSelectedId,
    visible,
    loading,
    toggle,
    moveSelection,
    confirmSelection,
    refresh,
  };
}
