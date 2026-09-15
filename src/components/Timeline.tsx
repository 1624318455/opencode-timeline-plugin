/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, on, onCleanup, Show } from "solid-js";
import type { TimelineNode } from "../types";
import { NodeItem } from "./NodeItem";

export interface TimelineProps {
  readonly nodes: readonly TimelineNode[];
  /** 当前选中节点的 id（受控状态，阶段 4 的 useMessages 持有） */
  readonly selectedId: string | null;
  /** 主题色（阶段 4 从 api.theme.current 映射后传入，缺省用宿主默认） */
  readonly selectedBackground?: string;
  readonly borderColor?: string;
  readonly emptyText?: string;
  /** 列表最大高度（行数）。侧边栏是共享空间，禁止 flexGrow 抢占其他区块 */
  readonly maxHeight?: number;
  /** 选中确认回调（阶段 4 接 Enter 跳转；TUI 无点击，鼠标支持为可选 TODO） */
  readonly onSelect?: (id: string) => void;
}

/** 时间线列表：可滚动（scrollbox）+ 空态 + 选中行自动滚入视口 */
export function Timeline(props: TimelineProps) {
  let scroll: ScrollBoxRenderable | undefined;
  let pendingScroll: ReturnType<typeof setTimeout> | undefined;

  const clearPendingScroll = () => {
    if (pendingScroll === undefined) return;
    clearTimeout(pendingScroll);
    pendingScroll = undefined;
  };

  // 选中行自动滚入视口（模式照抄 opencode-tree 的 TreeView：找不到子节点时下一 tick 重试）
  const scrollToSelected = (id: string | null) => {
    clearPendingScroll();
    if (!id) return;
    const tryScroll = () => {
      pendingScroll = undefined;
      if (!scroll) return;
      const child = scroll.content.findDescendantById(id);
      if (!child || scroll.viewport.height <= 0 || child.height <= 0) {
        pendingScroll = setTimeout(tryScroll, 0);
        return;
      }
      scroll.scrollChildIntoView(id);
    };
    pendingScroll = setTimeout(tryScroll, 0);
  };

  createEffect(
    on(
      () => props.selectedId,
      (id) => scrollToSelected(id ?? null),
      { defer: true },
    ),
  );

  onCleanup(() => clearPendingScroll());

  return (
    <scrollbox
      ref={(renderable: ScrollBoxRenderable) => (scroll = renderable)}
      width="100%"
      flexGrow={0}
      flexShrink={1}
      minHeight={0}
      maxHeight={props.maxHeight ?? 10}
      scrollbarOptions={{ visible: false }}
    >
      <Show
        when={props.nodes.length > 0}
        fallback={<text>{props.emptyText ?? "暂无消息"}</text>}
      >
        <box flexDirection="column" gap={0} width="100%">
          <For each={props.nodes}>
            {(node: TimelineNode) => (
              <NodeItem
                node={node}
                selected={node.id === props.selectedId}
                selectedBackground={props.selectedBackground}
                borderColor={props.borderColor}
              />
            )}
          </For>
        </box>
      </Show>
    </scrollbox>
  );
}
