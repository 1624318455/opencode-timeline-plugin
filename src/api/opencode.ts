import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { truncateSummary, type TimelineNode } from "../types";
import { diagLog } from "./diag"; // TEMP-DIAG: 结论出来后删除本行及下文 diagLog 调用

/**
 * 与 OpenCode 核心交互的封装。
 *
 * 数据源：`api.state.session.messages(sessionID)` + `api.state.part(messageID)`。
 * 注意（宿主真相）：`api.state` 经函数封装后是快照语义，在 memo 内读取并不会
 * 像原生 `sync.data.message[sessionID]` 那样自动订阅（实测诊断行刷出 total=100
 * 时纯 memo 派生的 nodes 仍是 0）。因此实时性靠 `subscribeTimeline` 事件订阅
 * 驱动快照重读；宿主负责历史回填（进会话时 `sync.session.sync`）与事件推送。
 */

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

/** 消息第一段文本（用户节点只取 text / file / agent，忽略 tool / reasoning 等噪音） */
function firstText(parts: readonly Part[]): string {
  if (!Array.isArray(parts)) return "";
  for (const p of parts) {
    try {
      if (!p || typeof p !== "object") continue;
      const t = (p as Part).type;
      if (t !== "text" && t !== "file" && t !== "agent") continue;
      const s = partText(p as Part);
      if (typeof s !== "string") continue;
      const trimmed = s.trim();
      if (trimmed) return trimmed;
    } catch {
      continue; // 单个脏 part 只跳过该 part，绝不连累整条消息
    }
  }
  return "";
}

/**
 * 单条消息分类（归一化与诊断共用同一口径，避免两边规则分叉）：
 * - kind=user：role 或 type 任一为 "user"；
 * - id：id → messageID → message_id 回退，取不到为 null。
 */
export function describeMessage(m: unknown): { kind: "user" | "other"; id: string | null } {
  try {
    if (!m || typeof m !== "object") return { kind: "other", id: null };
    const raw = m as unknown as Record<string, unknown>;
    if (raw["role"] !== "user" && raw["type"] !== "user") return { kind: "other", id: null };
    const idRaw = raw["id"] ?? raw["messageID"] ?? raw["message_id"];
    return { kind: "user", id: typeof idRaw === "string" && idRaw ? idRaw : null };
  } catch {
    return { kind: "other", id: null };
  }
}

/** 用户消息标题回退（DB 实测：UserMessage 自带 summary.title，parts 缺失时仍可显示） */
function summaryTitle(raw: Record<string, unknown>): string {
  try {
    const s = raw["summary"] as { title?: unknown } | undefined;
    return typeof s?.title === "string" ? s.title.trim() : "";
  } catch {
    return "";
  }
}

/**
 * SDK Message[] → TimelineNode[]（线性 MVP）。
 * 只保留用户消息节点，assistant / tool / system 全部过滤掉，
 * 解决侧边栏出现 step-start / todos JSON / 文件路径等乱七八糟条目的问题。
 *
 * 形态兼容（防宿主版本漂移）：
 * - v1 store：`{ id, role: "user", time: { created }, ... }`，正文从 parts 取；
 * - v2 projected：`{ id, type: "user", text, time: { created } }`，正文直接取 text。
 * 单条解析失败只跳过该条，不让整列表崩掉（memo 抛错会导致整面板挂掉）。
 */
export function toTimelineNodes(
  messages: readonly Message[],
  getParts: (messageID: string) => readonly Part[],
  sessionId: string,
  maxItems = 50,
): TimelineNode[] {
  const users: Array<{ id: string; created: number; text: string }> = [];
  for (const m of messages) {
    try {
      const desc = describeMessage(m);
      if (desc.kind !== "user") continue;
      // 无任何可用 id 时才放弃该条（宿主侧连 id 都没给，选中/跳转无从谈起）
      if (!desc.id) continue;
      const id = desc.id;
      const raw = m as unknown as Record<string, unknown>;
      const time = raw["time"] as { created?: unknown } | undefined;
      const created = typeof time?.created === "number" ? time.created : 0;
      // 正文回退链：内联 text → parts → summary.title → "(empty)"，缺正文也保留节点
      let text = "";
      const inline = raw["text"];
      if (typeof inline === "string" && inline.trim()) {
        text = inline;
      } else {
        let parts: readonly Part[] = [];
        try {
          const got = getParts(id);
          parts = Array.isArray(got) ? got : [];
        } catch {
          parts = [];
        }
        text = firstText(parts) || summaryTitle(raw) || "(empty)";
      }
      users.push({ id, created, text });
    } catch {
      continue;
    }
  }
  const tail = users.slice(Math.max(0, users.length - maxItems));
  let seq = users.length - tail.length;

  return tail.map((u) => ({
    id: u.id,
    role: "user" as const,
    summary: truncateSummary(u.text),
    timestamp: u.created,
    seq: seq++,
    sessionId,
  }));
}

// 订阅实时刷新需要监听的事件（对齐 SDK v2 Event type 字符串，按 properties.sessionID 过滤）。
// - 离散事件：message/part 增改删、session 创建/更新/空闲/状态；
// - 即时事件：session.next.prompted / prompt.admitted（用户回车后第一时间触发，不等 idle）；
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

/**
 * 订阅事件 → 有新消息/part 变化时回调（返回取消订阅函数）。
 *
 * 背景（宿主真相）：`api.state.session.messages()` 经函数封装返回的是快照语义，
 * 在 memo 内读取并不会像原生 `sync.data.message[sessionID]` 那样建立细粒度订阅
 * （实测：诊断 memo 靠 session.get 更新到了 total=100，而纯 memo 派生的 nodes
 * 一直卡在 0）。因此必须显式订阅事件再读快照，不赌宿主的响应式语义。
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
          diagLog(`evt ${type} sub=${sessionID.slice(0, 13)} evt=${e.properties?.sessionID ?? "-"}`); // TEMP-DIAG
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

/** 用户消息总数（与 describeMessage 同口径，不读 parts，专供 hiddenOlder / 空态判断） */
export function countUserMessages(api: TuiPluginApi, sessionID: string): number {
  try {
    const list = (api.state.session.messages(sessionID) ?? []) as ReadonlyArray<unknown>;
    let n = 0;
    for (const m of list) {
      if (describeMessage(m).kind === "user") n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 读取某会话当前全量节点（同步快照）。
 * 注意：调用方必须自己保证刷新时机（事件订阅/version 信号），不要指望 memo 自动订阅。
 */
export function getSessionNodes(
  api: TuiPluginApi,
  sessionID: string,
  maxItems = 50,
): TimelineNode[] {
  // 先读 ready：即使 messages() 抛错，memo 也至少订阅了这个随启动翻转的 key，
  // 避免零依赖导致永不重算、“重启还是空”卡死。
  try {
    void api.state.ready;
  } catch {
    return [];
  }
  let messages: readonly Message[];
  try {
    messages = api.state.session.messages(sessionID) ?? [];
  } catch {
    return [];
  }
  return toTimelineNodes(
    messages,
    (id) => {
      try {
        return api.state.part(id) ?? [];
      } catch {
        return [];
      }
    },
    sessionID,
    maxItems,
  );
}

/**
 * 面板诊断行：结论式，一眼定位“宿主没给”还是“过滤吃掉”。
 * - user：role/type 任一为 user 的条数；kept：归一化后保留的节点数；
 * - noId：user 但无任何可用 id 而被迫放弃的条数；
 * - part：首条 user 消息的 part() 探针（arr:N / empty / err / 非数组typeof）。
 * 全部防御式读取，永不抛错。
 */
export function getTimelineDebugLine(api: TuiPluginApi, sessionID: string): string {
  try {
    const ready = api.state.ready ? 1 : 0;
    let hasSession = 0;
    try {
      hasSession = api.state.session.get(sessionID) === undefined ? 0 : 1;
    } catch {
      hasSession = -1;
    }
    let total = -1;
    let user = 0;
    let noId = 0;
    let firstUserId: string | null = null;
    try {
      const list = (api.state.session.messages(sessionID) ?? []) as ReadonlyArray<unknown>;
      total = list.length;
      for (const m of list) {
        const d = describeMessage(m);
        if (d.kind !== "user") continue;
        user++;
        if (d.id) firstUserId ??= d.id;
        else noId++;
      }
    } catch {
      total = -1;
    }
    let kept = -1;
    try {
      kept = getSessionNodes(api, sessionID, Number.MAX_SAFE_INTEGER).length;
    } catch {
      kept = -1;
    }
    let part = "?";
    if (!firstUserId) {
      part = user === 0 ? "n/a" : "no-id";
    } else {
      try {
        const got = api.state.part(firstUserId) as unknown;
        part = Array.isArray(got) ? (got.length === 0 ? "empty" : `arr:${got.length}`) : `typeof:${typeof got}`;
      } catch {
        part = "err";
      }
    }
    const shortId = String(sessionID ?? "?").slice(0, 13);
    return `dbg r=${ready} s=${hasSession} total=${total} user=${user} kept=${kept} noId=${noId} part=${part} ${shortId}`;
  } catch {
    return "dbg unavailable";
  }
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
