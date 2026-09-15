import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { truncateSummary, type MessageRole, type TimelineNode } from "../types";

/**
 * 与 OpenCode 核心交互的封装（阶段 4）。
 *
 * 数据源：`api.state.session.messages(sessionID)`（同步快照）+
 * `api.state.part(messageID)`（各消息的 parts）。
 * 实时性：靠 `api.event.on(...)` 订阅 message/part 事件后重新快照。
 */

// 订阅实时刷新需要监听的事件（对齐 SDK v2 Event type 字符串，均为 properties.sessionID 过滤）。
// - 离散事件：message/part 增改删、session 创建/更新/空闲/状态（发送后 state 落盘靠它们）。
// - 即时事件：session.next.prompted / prompt.admitted（用户回车后第一时间触发，不等 idle）。
// - 流式事件：message.part.delta + session.next.text.* / step.* / tool.*（助手流式输出时跟随）。
const REFRESH_EVENTS = [
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "session.created",
  "session.updated",
  "session.idle",
  "session.status",
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.text.ended",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.tool.called",
  "session.next.tool.success",
  "session.next.tool.failed",
] as const;

function baseRole(role: Message["role"]): MessageRole {
  return role === "user" ? "user" : "assistant";
}

/** 从单个 part 提取可展示文本（text / reasoning / tool input 摘要） */
export function partText(part: Part): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "reasoning":
      return part.text;
    case "tool": {
      const st = part.state;
      const title = st.status === "completed" ? st.title : part.tool;
      const input = "input" in st ? st.input : undefined;
      return input ? `${title}: ${truncateSummary(JSON.stringify(input), 60)}` : title;
    }
    case "file":
      return part.filename ?? part.url ?? "file";
    case "agent":
      return part.name;
    default:
      return part.type;
  }
}

/** 消息第一段文本（无 part 时回退为空，由调用方用 summary 兜底） */
function firstText(parts: readonly Part[]): string {
  for (const p of parts) {
    const t = partText(p).trim();
    if (t) return t;
  }
  return "";
}

/**
 * SDK Message[] → TimelineNode[]（线性 MVP）。
 * 工具调用展开为独立子节点 `messageID#partID`，role=tool，便于区分显示。
 */
export function toTimelineNodes(
  messages: readonly Message[],
  getParts: (messageID: string) => readonly Part[],
  sessionId: string,
  maxItems = 50,
): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  const tail = messages.slice(Math.max(0, messages.length - maxItems));
  let seq = messages.length - tail.length;

  for (const m of tail) {
    const parts = getParts(m.id);
    const text = firstText(parts) || "(empty)";
    nodes.push({
      id: m.id,
      role: baseRole(m.role),
      summary: truncateSummary(text),
      timestamp: m.time.created,
      seq: seq++,
      sessionId,
    });
    // 工具调用展开为子节点（MVP：只展开 tool 类型 part）
    for (const p of parts) {
      if (p.type !== "tool") continue;
      nodes.push({
        id: `${m.id}#${p.id}`,
        role: "tool",
        summary: truncateSummary(partText(p)),
        timestamp: m.time.created,
        seq: seq++,
        sessionId,
        parentId: m.id,
      });
    }
  }
  return nodes;
}

/** 读取某会话当前全量节点（同步快照，无 IO） */
export function getSessionNodes(
  api: TuiPluginApi,
  sessionID: string,
  maxItems = 50,
): TimelineNode[] {
  const messages = api.state.session.messages(sessionID) ?? [];
  return toTimelineNodes(messages, (id) => api.state.part(id) ?? [], sessionID, maxItems);
}

/** 订阅事件 → 有新消息/part 变化时回调（返回取消订阅函数）。
 * - 事件先于 api.state 落盘是已知竞态，故统一延迟到下一 tick 再读快照；
 * - 流式 delta 高频触发，用 trailing 合并（100ms 内只刷一次），避免重渲染风暴。
 */
export function subscribeTimeline(
  api: TuiPluginApi,
  sessionID: string,
  onChange: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const schedule = () => {
    if (disposed) return;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) onChange();
    }, 100);
  };
  const offs = REFRESH_EVENTS.map((type) =>
    // TuiEventBus.on 是泛型按 type 收窄；此处用最小结构断言绕过联合分发
    (api.event.on as (t: string, h: (e: { properties?: { sessionID?: string } }) => void) => () => void)(
      type,
      (e) => {
        if (!e.properties || e.properties.sessionID === undefined || e.properties.sessionID === sessionID) {
          schedule();
        }
      },
    ),
  );
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    offs.forEach((off) => off());
  };
}

/**
 * 跳转到对应消息。
 * MVP 现状：TUI 宿主暂无公开的“滚动到 messageID” API（TODO：向 opencode 确认
 * 是否有 session 视图 scroll/scrollChildIntoView 之类的内部 API 可复用）。
 * 当前行为：把选中 id 持久化到 kv（供下次打开恢复）+ toast 提示。
 */
export function jumpToMessage(api: TuiPluginApi, sessionID: string, messageID: string): void {
  try {
    api.kv.set(`timeline.viewer:last:${sessionID}`, messageID);
  } catch {
    // kv 未就绪时忽略（api.kv.ready 为 false 的启动阶段）
  }
  // TODO: 宿主支持消息级滚动后，在此 dispatch 对应 command（如 session.message.goto）。
  api.ui.toast({ message: `timeline: ${messageID.slice(0, 8)}…` });
}
