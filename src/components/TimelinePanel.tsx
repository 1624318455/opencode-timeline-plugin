/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, onCleanup, Show } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { Timeline } from "./Timeline";
import { useMessages } from "../hooks/useMessages";
import { useKeybind } from "../hooks/useKeybind";
import { createTapHandler } from "../hooks/useMouseTap";
import { countUserMessages, getSessionNodes, getTimelineDebugLine } from "../api/opencode";

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
  // sessionID 传 accessor：sidebar 切会话时组件不重挂，hook 内 effect 才能跟随切会话重拉历史
  const store = useMessages(props.api, () => props.sessionID, { maxItems: props.maxItems });
  const [open, setOpen] = createSignal(true);
  // 标题栏点按：macOS 部分终端只送达 release，双通道 tap 兜底（Windows 下等价于纯 down）
  const headerTap = createTapHandler(() => setOpen((x) => !x));
  // —— 显示层唯一真相源：宿主跟踪读 ——
  // api.state 背后是宿主的响应式 store。本组件由宿主 Solid 运行时渲染，
  // render 期间直读 api.state 会在宿主侧建立订阅：同步数据一变宿主自动重画
  // 本子树——原生 Context/MCP/LSP 区块就是这么刷新的。
  // 插件自有 memo/signal 的变更调度不到宿主帧（实测：数据到了也不画，
  // 要手动点一下借宿主事件帧才刷出来），所以列表/计数/空态必须走这里直读；
  // store 只管选中、跳转、回到底部等后台记账。
  // 注意：必须是 render 期间调用的普通函数（不能包插件侧 createMemo——跨运行时
  // memo 缓存会断掉宿主订阅）；单次 render 读几次快照开销可忽略（≤maxItems 条）。
  const liveNodes = () => getSessionNodes(props.api, props.sessionID, props.maxItems);
  const liveEmptyText = () => {
    if (liveNodes().length > 0) return "";
    try {
      return props.api.state.session.get(props.sessionID) === undefined
        ? "加载历史中…"
        : "暂无用户消息";
    } catch {
      return "加载历史中…";
    }
  };
  // 标题栏永远渲染（空会话显示 0 + 空态文案），避免“插件缺失”和“暂无用户消息”无法区分
  const active = () => store.visible();
  const hasNodes = () => liveNodes().length > 0;
  // 边界：列表最多取 maxItems 条消息（数据源层已截尾），面板最多占 8 行、内部滚动
  const maxHeight = 8;
  const count = () => liveNodes().length;
  // 标题靠“签名变化 → 整块卸了重挂”更新：等尺寸原地文本替换在本环境疑似不重绘，
  // 而卸载/挂载（折叠再展开同款链路）已被证实能画出最新值。开关由 store.paintKey()
  // 驱动——paintKey 在 useMessages 的 follow effect 里随签名递增。
  // 两分支故意结构不同（裸 text ↔ box 包 text），渲染器无法复用旧节点，只能新鲜挂载。
  const titleFull = () =>
    `Timeline ${count()} · Alt+U${store.paintKey() % 2 === 0 ? "" : " ·"}`;
  const titleLine1 = () => `Timeline ${count()}`;
  const titleLine2 = () => `· Alt+U${store.paintKey() % 2 === 0 ? "" : " ·"}`;
  const TitleEven = () => {
    return <text fg={theme().textMuted}>{titleFull()}</text>;
  };
  const TitleOdd = () => {
    return (
      <box flexDirection="column">
        <text fg={theme().textMuted}>{titleLine1()}</text>
        <text fg={theme().textMuted}>{titleLine2()}</text>
      </box>
    );
  };
  // 超 maxItems 被截掉的老用户消息数（render 内直读宿主 store，同样被宿主跟踪）
  const hiddenOlder = () => {
    try {
      return Math.max(0, countUserMessages(props.api, props.sessionID) - props.maxItems);
    } catch {
      return 0;
    }
  };
  // “回到底部”点按：同样走双通道 tap（liveNodes 在此之后已定义，调用时才求值）
  const bottomTap = createTapHandler(() => store.backToBottom(liveNodes().map((n) => n.id)));
  // 诊断行（默认关闭，debug: true 时才渲染）：同步快照，排查“宿主没给 vs 过滤吃掉”用。
  // 全部防御式读取，永不抛错。
  const debugLine = createMemo(() => getTimelineDebugLine(props.api, props.sessionID));
  const theme = () => props.api.theme.current;
  // 输入框聚焦时裸键（↑/↓/Enter/Esc）必须让给编辑器：我们的全局图层优先级抢不过
  // prompt 的聚焦层，硬抢会劫持输入历史/提交。所以键盘导航只在非编辑时生效，
  // 主交互是鼠标点击（NodeItem onMouseDown → selectAndJump）。
  const isEditing = () => {
    try {
      return props.api.renderer.currentFocusedEditor != null;
    } catch {
      return false;
    }
  };
  const disposeKeys = useKeybind(props.api, {
    isActive: () => active() && open() && hasNodes() && !isEditing(),
    onToggle: store.toggle,
    onUp: () => store.moveSelection(-1),
    onDown: () => store.moveSelection(1),
    onConfirm: store.confirmSelection,
    onClose: () => {
      if (store.visible()) store.toggle();
    },
    // macOS 无鼠标终端的展开/收起唯一路径（等价于点击标题栏）；Windows 下是纯加法
    onExpand: () => setOpen(true),
    onCollapse: () => setOpen(false),
  });
  onCleanup(disposeKeys);

  return (
    <Show when={active()}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} onMouseDown={headerTap.onMouseDown} onMouseUp={headerTap.onMouseUp}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Timeline</b>
          </text>
          <Show when={store.paintKey() % 2 === 0}>
            <TitleEven />
          </Show>
          <Show when={store.paintKey() % 2 !== 0}>
            <TitleOdd />
          </Show>
        </box>
        <Show when={open()}>
          <Show when={props.debug}>
            <text fg={theme().textMuted}>{debugLine()}</text>
          </Show>
          <Timeline
            nodes={liveNodes()}
            selectedId={store.selectedId()}
            maxHeight={maxHeight}
            emptyText={liveEmptyText()}
            onSelect={(messageID) => store.selectAndJump(messageID)}
          />
          <Show when={hiddenOlder() > 0}>
            <text fg={theme().textMuted}>仅显示最近 {props.maxItems} 条 · {hiddenOlder()} 条旧消息已收起</text>
          </Show>
          <Show when={hasNodes()}>
            <box flexDirection="row" onMouseDown={bottomTap.onMouseDown} onMouseUp={bottomTap.onMouseUp}>
              <text fg={theme().textMuted}>⤓ 回到底部</text>
            </box>
          </Show>
          <Show when={count() > maxHeight}>
            <text fg={theme().textMuted}>↑/↓ 移动 · Enter 跳转 · ←/→ 展开收起 · Ctrl/Alt+U 开关</text>
          </Show>
          <Show when={count() <= maxHeight}>
            <text fg={theme().textMuted}>↑/↓ 移动 · Enter 跳转 · ←/→ 展开收起</text>
          </Show>
        </Show>
      </box>
    </Show>
  );
}
