/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, Show } from "solid-js";
import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import { Timeline } from "./components/Timeline";
import { useMessages } from "./hooks/useMessages";
import { useKeybind } from "./hooks/useKeybind";

export const id = "timeline.viewer";

interface TimelinePluginOptions {
  readonly maxItems?: number;
}

function readOptions(options: PluginOptions | undefined): TimelinePluginOptions {
  if (!options || typeof options !== "object") return {};
  const maxItems = (options as Record<string, unknown>)["maxItems"];
  return typeof maxItems === "number" ? { maxItems } : {};
}

/**
 * 侧边栏面板：hooks 接线 + 可见性开关 + Timeline 纯展示。
 * 追加式挂载规范（对齐原生 sidebar 区块）：
 * - 空会话时渲染 null，零占位，不挤压原生内容；
 * - 固定 maxHeight，不 flexGrow 抢空间；order 排最后。
 */
function TimelinePanel(props: { api: TuiPluginApi; sessionID: string; maxItems: number }) {
  const store = useMessages(props.api, props.sessionID, { maxItems: props.maxItems });
  const [open, setOpen] = createSignal(true);
  const active = () => store.visible() && store.nodes().length > 0;
  // 边界：列表最多取 maxItems 条消息（数据源层已截尾），面板最多占 8 行、内部滚动
  const maxHeight = 8;
  const count = () => store.nodes().length;
  // 超 maxItems 被截掉的老消息数（按原始 message 数估算，tool 子节点不计入）
  const hiddenOlder = () => {
    try {
      const total = props.api.state.session.messages(props.sessionID)?.length ?? count();
      return Math.max(0, total - props.maxItems);
    } catch {
      return 0;
    }
  };
  const theme = () => props.api.theme.current;
  const disposeKeys = useKeybind(props.api, {
    isActive: () => active() && open(),
    onToggle: store.toggle,
    onUp: () => store.moveSelection(-1),
    onDown: () => store.moveSelection(1),
    onConfirm: store.confirmSelection,
    onClose: () => {
      if (store.visible()) store.toggle();
    },
  });
  onCleanup(disposeKeys);

  return (
    <Show when={active()}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Timeline</b>
          </text>
          <text fg={theme().textMuted}>
            {count()} · Alt+U
          </text>
        </box>
        <Show when={open()}>
          <Timeline
            nodes={store.nodes()}
            selectedId={store.selectedId()}
            maxHeight={maxHeight}
            emptyText="暂无消息"
            onSelect={(messageID) => store.setSelectedId(messageID)}
          />
          <Show when={hiddenOlder() > 0}>
            <text fg={theme().textMuted}>仅显示最近 {props.maxItems} 条 · {hiddenOlder()} 条旧消息已收起</text>
          </Show>
          <Show when={count() > maxHeight}>
            <text fg={theme().textMuted}>↑/↓ 移动 · Enter 跳转 · Esc 关闭 · 列表内滚动</text>
          </Show>
          <Show when={count() <= maxHeight}>
            <text fg={theme().textMuted}>↑/↓ 移动 · Enter 跳转 · Esc 关闭</text>
          </Show>
        </Show>
      </box>
    </Show>
  );
}

/**
 * 插件入口（阶段 4）。
 * 挂载点：sidebar_content（按 session_id 区分会话）。
 * 快捷键图层由面板内的 useKeybind 注册，随面板卸载自动注销。
 */
export async function tui(
  api: TuiPluginApi,
  options: PluginOptions | undefined,
  _meta: TuiPluginMeta,
): Promise<void> {
  const { maxItems = 50 } = readOptions(options);

  api.slots.register({
    // 原生区块 order：context 100 / lsp 300 / todo 400 / files 500；timeline 排最后做锦上添花
    order: 600,
    slots: {
      sidebar_content: (_ctx, props) => (
        <TimelinePanel api={api} sessionID={props.session_id} maxItems={maxItems} />
      ),
    },
  });
}

export default { id, tui };
