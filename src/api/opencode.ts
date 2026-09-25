import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { truncateSummary, type TimelineNode } from "../types";

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
 * 显示顺序：最新的在最上面（数组 index 0 = 最新），与原生 `/timeline`
 * 对话框一致。seq 仍是全局 chronological 序号（越老越小），仅用于排序/跳转，
 * 不代表显示位置。
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
  // 宿主同步过渡态可能给出非数组：直接放弃本轮，绝不抛错（抛错会杀死上游 effect）。
  if (!Array.isArray(messages)) return [];
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
  const base = users.length - tail.length;

  const chronological = tail.map((u, i) => ({
    id: u.id,
    role: "user" as const,
    summary: truncateSummary(u.text),
    timestamp: u.created,
    seq: base + i,
    sessionId,
  }));
  // 最新在最上面：反转 chronological（index 0 = 最新），seq 保持原 chronological 序号
  return chronological.reverse();
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
 * 跳转到对应消息（对齐原生 `/timeline` 的做法）。
 *
 * 原生实现（`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` 的
 * `session.timeline` 命令）：session 视图持有一个模块内的 `ScrollBoxRenderable`，
 * 每条渲染的消息行 renderable 的 `id === messageID`，跳转就是
 * `scroll.getChildren().find((c) => c.id === messageID)` 找到后
 * `scroll.scrollBy(child.y - scroll.y - 1)`（另见社区插件
 * `asukaneko/opencode-user-message-jumper` 的 README：宿主未暴露公开滚动 API
 * 前，只能用这套“找渲染节点 + 滚容器”的内部思路 best-effort 实现）。
 *
 * 本函数按以下优先级赋能：
 * 1) 官方 API（若宿主已合并 `api.state.scrollToMessage(messageID): boolean`，
 *    见上游 PR `feat(tui): expose scrollToMessage to TUI plugins`）：直接调用；
 * 2) 渲染树 best-effort：从 `api.renderer.root.findDescendantById(messageID)`
 *    找到消息行，沿 `parent` 链找到包围它的 ScrollBox，调
 *    `scrollChildIntoView(messageID)`（等价于原生 scrollBy 数学），找不到则
 *    DFS 全树搜 ScrollBox 逐个试；
 * 3) 兜底：kv 持久化 + toast（保持 MVP 行为，不抛错）。
 *
 * 注意：TUI 本地只加载最近 ~20 条消息做分页（上游 issue #44618），太老的消息
 * 可能根本没有渲染节点，此时返回 false 并 toast 说明。
 *
 * @returns 是否真正滚动到了目标（kv 持久化成功与否不计入）。
 */
export function jumpToMessage(api: TuiPluginApi, sessionID: string, messageID: string): boolean {
  try {
    api.kv.set(`timeline.viewer:last:${sessionID}`, messageID);
  } catch {
    // kv 未就绪时忽略（api.kv.ready 为 false 的启动阶段）
  }
  const short = messageID.slice(0, 8);

  // 1) 官方 API（未来宿主）：scrollToMessage(messageID): boolean
  try {
    const state = api.state as unknown as { scrollToMessage?: unknown };
    if (typeof state.scrollToMessage === "function") {
      const ret = (state.scrollToMessage as (id: string) => unknown).call(state, messageID);
      if (ret === true || ret === undefined || ret === null) {
        api.ui.toast({ message: `timeline: jump → ${short}…`, variant: "success" });
        return true;
      }
      // === false：宿主说没滚成，继续走渲染树 best-effort
    }
  } catch {
    /* 官方 API 异常就继续 best-effort，不抛给调用方 */
  }

  // 2) 渲染树 best-effort（复刻原生 /timeline 跳转数学）
  if (tryRendererTreeJump(api, messageID)) {
    api.ui.toast({ message: `timeline: jump → ${short}…`, variant: "success" });
    return true;
  }

  // 3) 兜底：保持 MVP 行为（kv 已记）+ 诚实提示
  api.ui.toast({ message: `timeline: 宿主无滚动 API，已记住 ${short}…` });
  return false;
}

type RenderableLike = {
  readonly id?: unknown;
  readonly y?: unknown;
  parent?: unknown;
  findDescendantById?: unknown;
  getChildren?: unknown;
  scrollChildIntoView?: unknown;
  scrollBy?: unknown;
  scrollTo?: unknown;
  scrollTop?: unknown;
  scrollHeight?: unknown;
  content?: unknown;
  viewport?: unknown;
  wrapper?: unknown;
};

/** 沿 parent 链向上找最近的 ScrollBox（有 scrollChildIntoView / scrollBy / scrollTo 即认）。 */
function isScrollBox(node: RenderableLike): boolean {
  return (
    typeof node.scrollChildIntoView === "function" ||
    typeof node.scrollBy === "function" ||
    typeof node.scrollTo === "function"
  );
}

function findScrollBoxAncestor(target: RenderableLike): RenderableLike | null {
  let cur: unknown = target.parent ?? null;
  let hops = 0;
  while (cur && typeof cur === "object" && hops < 64) {
    const node = cur as RenderableLike;
    if (isScrollBox(node)) {
      return node;
    }
    cur = node.parent ?? null;
    hops++;
  }
  return null;
}

/** 在单个 ScrollBox 内尝试滚动到 messageID（优先 scrollChildIntoView，回退 scrollBy 数学）。 */
function scrollBoxToMessage(scrollBox: RenderableLike, target: RenderableLike, messageID: string): boolean {
  try {
    if (typeof scrollBox.scrollChildIntoView === "function") {
      (scrollBox.scrollChildIntoView as (id: string) => void).call(scrollBox, messageID);
      return true;
    }
    // 原生 /timeline 数学：scroll.scrollBy(child.y - scroll.y - 1)
    if (typeof scrollBox.scrollBy === "function") {
      const childY = (target as { y?: unknown }).y;
      const scrollY = (scrollBox as { y?: unknown }).y;
      if (typeof childY === "number" && typeof scrollY === "number") {
        (scrollBox.scrollBy as (delta: number) => void).call(scrollBox, childY - scrollY - 1);
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** DFS 全树收集 ScrollBox 候选（parent 链断裂时的备用路径）。 */
function collectScrollBoxes(root: RenderableLike): RenderableLike[] {
  const out: RenderableLike[] = [];
  const seen = new Set<object>();
  const stack: RenderableLike[] = [root];
  let steps = 0;
  while (stack.length > 0 && steps < 5000) {
    steps++;
    const node = stack.pop()!;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (isScrollBox(node)) {
      out.push(node);
    }
    try {
      const kids =
        typeof node.getChildren === "function"
          ? (node.getChildren as () => unknown).call(node)
          : null;
      if (Array.isArray(kids)) {
        for (const k of kids) {
          if (k && typeof k === "object") stack.push(k as RenderableLike);
        }
      }
      for (const key of ["content", "viewport", "wrapper"] as const) {
        const sub = node[key];
        if (sub && typeof sub === "object") stack.push(sub as RenderableLike);
      }
    } catch {
      continue;
    }
  }
  return out;
}

function nodeContains(root: RenderableLike, messageID: string): boolean {
  try {
    if (typeof root.findDescendantById === "function") {
      return (
        (root.findDescendantById as (id: string) => unknown).call(root, messageID) != null
      );
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 主会话视图回到底部：用本会话一条已知消息 id 定位到 transcript 的 ScrollBox，
 * 然后 scrollTo(scrollHeight)。成功返回 true，找不到渲染节点返回 false。
 */
export function scrollSessionToBottom(
  api: TuiPluginApi,
  knownIds: readonly string[],
): boolean {
  const box = findSessionScrollBox(api, knownIds);
  if (!box) {
    api.ui.toast({ message: "timeline: 找不到会话视图，回不到底部" });
    return false;
  }
  if (!scrollBoxToBottom(box)) {
    api.ui.toast({ message: "timeline: 回到底部失败" });
    return false;
  }
  try {
    const renderer = api.renderer as unknown as { requestRender?: unknown };
    if (typeof renderer.requestRender === "function") {
      (renderer.requestRender as () => void).call(renderer);
    }
  } catch {
    /* 忽略 */
  }
  api.ui.toast({ message: "timeline: 已回到底部", variant: "success" });
  return true;
}

/** 用已知消息 id 找到主会话 transcript 的 ScrollBox（parent 链优先，DFS 兜底）。 */
function findSessionScrollBox(api: TuiPluginApi, knownIds: readonly string[]): RenderableLike | null {
  try {
    const renderer = api.renderer as unknown as { root?: unknown };
    const root = renderer?.root as RenderableLike | undefined;
    if (!root || typeof root.findDescendantById !== "function") return null;
    const find = root.findDescendantById as (id: string) => unknown;
    for (const id of knownIds) {
      let target: unknown = null;
      try {
        target = find.call(root, id);
      } catch {
        continue;
      }
      if (!target || typeof target !== "object") continue;
      const t = target as RenderableLike;
      const ancestor = findScrollBoxAncestor(t);
      if (ancestor) return ancestor;
      // parent 链断了：DFS 找包含该 id 的 ScrollBox
      for (const box of collectScrollBoxes(root)) {
        try {
          if (nodeContains(box, id)) return box;
        } catch {
          continue;
        }
      }
      // 找到消息行但找不到容器就换下一个 id 试
    }
  } catch {
    return null;
  }
  return null;
}

/** ScrollBox 滚到底：scrollTo(scrollHeight)，没有则 scrollTop = scrollHeight。 */
function scrollBoxToBottom(scrollBox: RenderableLike): boolean {
  try {
    const h = scrollBox.scrollHeight;
    if (typeof h !== "number") return false;
    if (typeof scrollBox.scrollTo === "function") {
      (scrollBox.scrollTo as (pos: number) => void).call(scrollBox, h);
      return true;
    }
    if ("scrollTop" in (scrollBox as object)) {
      (scrollBox as { scrollTop: number }).scrollTop = h;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 渲染树跳转：findDescendantById 定位消息行 → parent 链找 ScrollBox →
 * scrollChildIntoView；parent 链断裂时 DFS 全树兜底。成功返回 true。
 */
function tryRendererTreeJump(api: TuiPluginApi, messageID: string): boolean {
  try {
    const renderer = api.renderer as unknown as { root?: unknown; requestRender?: unknown };
    const root = renderer?.root as RenderableLike | undefined;
    if (!root || typeof root.findDescendantById !== "function") return false;
    const target = (root.findDescendantById as (id: string) => unknown).call(
      root,
      messageID,
    ) as RenderableLike | null | undefined;
    if (!target || typeof target !== "object") return false;

    // 路径 A：parent 链（message 行 → content → viewport → … → ScrollBox）
    const ancestor = findScrollBoxAncestor(target);
    if (ancestor && scrollBoxToMessage(ancestor, target, messageID)) {
      try {
        if (typeof renderer.requestRender === "function") {
          (renderer.requestRender as () => void).call(renderer);
        }
      } catch {
        /* 忽略 */
      }
      return true;
    }

    // 路径 B：DFS 全树找“包含该 id 的 ScrollBox”逐个试
    for (const box of collectScrollBoxes(root)) {
      try {
        if (!nodeContains(box, messageID)) continue;
        if (scrollBoxToMessage(box, target, messageID)) {
          try {
            if (typeof renderer.requestRender === "function") {
              (renderer.requestRender as () => void).call(renderer);
            }
          } catch {
            /* 忽略 */
          }
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}
