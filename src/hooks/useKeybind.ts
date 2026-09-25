import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

export interface TimelineKeyHandlers {
  /** 面板是否处于可交互状态；确认/关闭键只在 active 时生效，避免劫持输入框 */
  readonly isActive: () => boolean;
  readonly onToggle: () => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

// keymap 包类型随宿主版本浮动，此处用最小结构类型避免硬依赖具体版本。
// TODO: 对照你本地 opencode 内置的 @opentui/keymap 文档确认 registerLayer 入参
// （commands[].name 需全局唯一，建议 timeline.* 前缀）。
type KeymapLike = {
  registerLayer?: (layer: {
    commands: Array<{ name: string; title: string; onSelect?: () => void }>;
    bindings: Array<{ command: string; keys: string[] }>;
  }) => () => void;
};

/**
 * 键盘绑定 Hook。
 * - Alt+U / Ctrl+T 切换面板；Enter 确认、Esc 关闭（全局图层裸键）。
 * - 侧边栏交互以鼠标为主：上下左右导航键已删除——实测键盘只到输入框，
 *   侧边栏选中/展开收起走鼠标点击（NodeItem tap / 标题栏 tap）。
 * - macOS 说明：系统默认 Option+U 输出 `¨` 而非 ESC u（除非终端开了 Option as Meta），
 *   所以 Alt+U 在 Mac 默认键位下是死键，Ctrl+T（t = timeline）是 Mac 主用开关；
 *   Windows 保持 Alt+U 不变。Ctrl+T 选它是因为 readline 的 transpose 语义只在
 *   输入框聚焦时有意义，而聚焦时 prompt 层优先、本层收不到，不会双重语义。
 * - 注意：输入框聚焦时 prompt 的聚焦层优先，裸键到不了我们这里；调用方须在
 *   isActive 里排除编辑态（见 TimelinePanel.isEditing），否则会劫持输入历史/提交。
 * - 基于宿主 keymap 图层，dispose 时自动注销，避免污染全局快捷键。
 */
export function useKeybind(api: TuiPluginApi, handlers: TimelineKeyHandlers): () => void {
  const keymap = api.keymap as unknown as KeymapLike;
  if (typeof keymap.registerLayer !== "function") {
    // 宿主不支持图层 API 时退化为空操作（TODO：查 keymap 版本差异）
    return () => {};
  }

  const dispose = keymap.registerLayer({
    commands: [
      { name: "timeline.toggle", title: "Timeline: toggle panel", onSelect: handlers.onToggle },
      { name: "timeline.confirm", title: "Timeline: jump to message", onSelect: () => handlers.isActive() && handlers.onConfirm() },
      { name: "timeline.close", title: "Timeline: close panel", onSelect: () => handlers.isActive() && handlers.onClose() },
    ],
    bindings: [
      // Windows 主用 Alt+U；macOS 默认键位下 Option+U 是死键，用 Ctrl+T 代替
      { command: "timeline.toggle", keys: ["alt+u", "ctrl+t"] },
      { command: "timeline.confirm", keys: ["enter"] },
      { command: "timeline.close", keys: ["escape"] },
    ],
  });

  api.lifecycle.onDispose(() => {
    dispose();
  });

  return dispose;
}
