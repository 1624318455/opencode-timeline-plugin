import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { TimelineNode } from "../types";
import { getSessionNodes, jumpToMessage, subscribeTimeline } from "../api/opencode";

export interface UseMessagesOptions {
  readonly maxItems?: number;
}

export interface UseMessagesResult {
  readonly nodes: () => readonly TimelineNode[];
  readonly selectedId: () => string | null;
  readonly setSelectedId: (id: string | null) => void;
  readonly visible: () => boolean;
  readonly toggle: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly confirmSelection: () => void;
  readonly refresh: () => void;
}

/**
 * 会话消息列表 Hook（阶段 4）。
 * - 数据源：getSessionNodes（同步快照），事件驱动 refresh（实时更新需求）。
 * - selectedId 受控，Timeline 纯展示；confirmSelection 接 Enter 跳转。
 */
export function useMessages(
  api: TuiPluginApi,
  sessionID: string,
  options: UseMessagesOptions = {},
): UseMessagesResult {
  const maxItems = options.maxItems ?? 50;
  const [nodes, setNodes] = createSignal<readonly TimelineNode[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [visible, setVisible] = createSignal(true);

  const refresh = () => {
    const next = getSessionNodes(api, sessionID, maxItems);
    setNodes(next);
    // 选中失效时回退到末尾（新消息产生时自动跟随）
    if (next.length > 0 && !next.some((n) => n.id === selectedId())) {
      setSelectedId(next[next.length - 1]!.id);
    } else if (next.length === 0) {
      setSelectedId(null);
    }
  };

  const toggle = () => setVisible((v) => !v);

  const moveSelection = (delta: number) => {
    const list = nodes();
    if (list.length === 0) return;
    const idx = list.findIndex((n) => n.id === selectedId());
    const next = Math.min(list.length - 1, Math.max(0, (idx < 0 ? list.length - 1 : idx) + delta));
    setSelectedId(list[next]!.id);
  };

  const confirmSelection = () => {
    const id = selectedId();
    if (id) jumpToMessage(api, sessionID, id);
  };

  // 初次加载 + kv 恢复上次选中
  refresh();
  try {
    const last = api.kv.get<string | null>(`timeline.viewer:last:${sessionID}`, null);
    if (last && nodes().some((n) => n.id === last)) setSelectedId(last);
  } catch {
    // kv 未就绪则跳过
  }

  // 订阅实时更新；sessionID 变化时重建订阅。
  // refresh 内部读写 selectedId 信号，用 untrack 包裹避免 effect 反复重订阅。
  createEffect(() => {
    untrack(() => refresh());
    const off = subscribeTimeline(api, sessionID, refresh);
    onCleanup(off);
    return off;
  });
  onCleanup(() => {});

  return { nodes, selectedId, setSelectedId, visible, toggle, moveSelection, confirmSelection, refresh };
}
