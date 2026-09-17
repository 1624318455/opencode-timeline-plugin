/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, onCleanup, Show } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { Timeline } from "./Timeline";
import { useMessages } from "../hooks/useMessages";
import { useKeybind } from "../hooks/useKeybind";
import { getTimelineDebugLine } from "../api/opencode";
import { diagLog } from "../api/diag"; // TEMP-DIAG: 结论出来后删除

export interface TimelinePanelProps {
  readonly api: TuiPluginApi;
  readonly sessionID: string;
  readonly maxItems: number;
  readonly debug: boolean;
}

/**
 * 侧边栏面板：hooks 接线 + 可见性开关 + Timeline 纯展示。
 * 追加式挂载规范（对齐原生 sidebar 区块）：
 * - 标题栏永远渲染（0 节点时显示空态文案），避免与“插件未加载”混淆；
 * - 固定 maxHeight，不 flexGrow 抢空间；order 排最后。
 *
 * 注意：本组件放在入口之外——入口文件在宿主里常驻不刷新，
 * 渲染逻辑必须全部走依赖文件才能热更新。
 */
export function TimelinePanel(props: TimelinePanelProps) {
  diagLog(`panel body sid=${String(props.sessionID).slice(0, 13)}`); // TEMP-DIAG: 组件函数是否执行
  // sessionID 传 accessor：sidebar 切会话时组件不重挂，hook 内 effect 才能跟随切会话重拉历史
  const store = useMessages(props.api, () => props.sessionID, { maxItems: props.maxItems });
  const [open, setOpen] = createSignal(true);
  // 标题栏永远渲染（空会话显示 0 + 空态文案），避免“插件缺失”和“暂无用户消息”无法区分
  const active = () => store.visible();
  const hasNodes = () => store.nodes().length > 0;
  // 边界：列表最多取 maxItems 条消息（数据源层已截尾），面板最多占 8 行、内部滚动
  const maxHeight = 8;
  const count = () => store.nodes().length;
  // 标题靠“签名变化 → 整块卸了重挂”更新：等尺寸原地文本替换在本环境疑似不重绘，
  // 而卸载/挂载（折叠再展开同款链路）已被证实能画出最新值。开关由 store.paintKey()
  // 驱动——paintKey 在 useMessages 的 follow effect 里递增，而该 effect 已被日志证实每次
  // nodes 变化都跑（上一轮 R7 断掉的原因正是面板本地 effect 跟踪 sig memo 不再执行）。
  // 两分支故意结构不同（裸 text ↔ box 包 text），渲染器无法复用旧节点，只能新鲜挂载。
  // R15 标记（改号以便截图验 reload），结论后删除。
  // 本轮两件事：① 依赖对齐宿主（@opentui/* 0.5.11 → 0.4.5，见 package.json；
  // 宿主 1.18.31 锁的就是 0.4.5，我方子树之前是 0.5.11 的 renderable 混进 0.4.5 宿主树）；
  // ② 每次快照重读后调 api.renderer.requestRender() 显式要一帧（插件自有信号不走宿主调度）。
  // 标题仍是双独立 Show + 1 行/2 行高度交替 + pN。
  const titleFull = () =>
    `Timeline ${count()} · Alt+U · R15${store.paintKey() % 2 === 0 ? "" : " ·"} · p${store.paintKey()}`;
  const titleLine1 = () => `Timeline ${count()}`;
  const titleLine2 = () =>
    `· Alt+U · R15${store.paintKey() % 2 === 0 ? "" : " ·"} · p${store.paintKey()}`;
  // 超 maxItems 被截掉的老用户消息数（走事件驱动的 userTotal 快照，不在 render 内直读宿主 store）
  const hiddenOlder = () => Math.max(0, store.userTotal() - props.maxItems);
  // 诊断行（默认关闭，debug: true 时才渲染）：同步快照，排查“宿主没给 vs 过滤吃掉”用。
  // 全部防御式读取，永不抛错。
  const debugLine = createMemo(() => getTimelineDebugLine(props.api, props.sessionID));
  const theme = () => props.api.theme.current;
  const disposeKeys = useKeybind(props.api, {
    isActive: () => active() && open() && hasNodes(),
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
          <Show when={store.paintKey() % 2 === 0}>
            <text fg={theme().textMuted}>{titleFull()}</text>
          </Show>
          <Show when={store.paintKey() % 2 !== 0}>
            <box flexDirection="column">
              <text fg={theme().textMuted}>{titleLine1()}</text>
              <text fg={theme().textMuted}>{titleLine2()}</text>
            </box>
          </Show>
        </box>
        <Show when={open()}>
          <Show when={props.debug}>
            <text fg={theme().textMuted}>{debugLine()}</text>
          </Show>
          <Timeline
            nodes={store.nodes()}
            selectedId={store.selectedId()}
            maxHeight={maxHeight}
            emptyText={store.loading() ? "加载历史中…" : "暂无用户消息"}
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
