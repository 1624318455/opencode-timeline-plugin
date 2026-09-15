// 时间线核心类型：线性消息列表（MVP），预留 parentId/children 给未来树状扩展。

/** 消息角色：用户 / AI / 工具调用 / 系统 */
export type MessageRole = "user" | "assistant" | "tool" | "system";

/** 单条会话消息的归一化视图（与 OpenCode 原始消息结构解耦，转换逻辑在阶段 4 的 api/opencode.ts） */
export interface TimelineNode {
  /** 消息唯一 ID（对应 OpenCode 的 messageID） */
  readonly id: string;
  readonly role: MessageRole;
  /** 正文摘要（已截断到 30 字符，见 truncateSummary） */
  readonly summary: string;
  /** Unix 毫秒时间戳 */
  readonly timestamp: number;
  /** 会话内序号（可选，用于排序/跳转） */
  readonly seq?: number;
  /** 所属会话（Sidebar slot 按 session_id 挂载时使用） */
  readonly sessionId?: string;
  // —— 树状扩展预留（对标 opencode-tree），MVP 可忽略 ——
  readonly parentId?: string;
  readonly children?: readonly string[];
}

/** 摘要最大长度（需求：截断到 30 字符） */
export const MAX_SUMMARY_LENGTH = 30;

/** 按字符截断（含 CJK/emoji 安全处理），超长补 "…" */
export function truncateSummary(text: string, max: number = MAX_SUMMARY_LENGTH): string {
  const chars = Array.from(text.trim().replace(/\s+/g, " "));
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`;
}

/** 角色标记（纯几何符号，无 emoji，保证终端观感克制统一） */
export function roleIcon(role: MessageRole): string {
  switch (role) {
    case "user":
      return "○";
    case "assistant":
      return "●";
    case "tool":
      return "◇";
    case "system":
      return "□";
  }
}

/** 时间戳 → "HH:MM"（本地时区） */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
