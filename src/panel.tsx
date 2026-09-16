/** @jsxImportSource @opentui/solid */
import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import { TimelinePanel } from "./components/TimelinePanel";
import { diagLog } from "./api/diag"; // TEMP-DIAG: 结论出来后删除

export const id = "timeline.viewer";

let loadCount = 0; // TEMP-DIAG: entry 被调几次（重复加载/泄漏一眼看穿）

interface TimelinePluginOptions {
  readonly maxItems?: number;
  /** 诊断行开关（默认关闭：dbg 快照行只在排查时打开，避免打扰普通用户） */
  readonly debug?: boolean;
}

function readOptions(options: PluginOptions | undefined): TimelinePluginOptions {
  if (!options || typeof options !== "object") return {};
  const raw = options as Record<string, unknown>;
  const maxItems = raw["maxItems"];
  const debug = raw["debug"];
  return {
    ...(typeof maxItems === "number" ? { maxItems } : {}),
    ...(debug === true ? { debug: true } : {}),
  };
}

/**
 * 插件入口（瘦入口：只做 slots.register，渲染逻辑全在 components/TimelinePanel，
 * 入口文件在宿主里常驻不刷新，逻辑放这里会越改越旧）。
 * 挂载点：sidebar_content（按 session_id 区分会话）。
 * 快捷键图层由面板内的 useKeybind 注册，随面板卸载自动注销。
 */
export async function tui(
  api: TuiPluginApi,
  options: PluginOptions | undefined,
  _meta: TuiPluginMeta,
): Promise<void> {
  const { maxItems = 50, debug = false } = readOptions(options);
  loadCount++;
  diagLog(`tui() entry #${loadCount}`); // TEMP-DIAG

  let disposeSlot: unknown;
  try {
    disposeSlot = api.slots.register({
      // 原生区块 order：context 100 / lsp 300 / todo 400 / files 500；timeline 排最后做锦上添花
      order: 600,
      slots: {
        sidebar_content: (_ctx, props) => (
          <TimelinePanel api={api} sessionID={props.session_id} maxItems={maxItems} debug={debug} />
        ),
      },
    });
  } catch {
    disposeSlot = undefined;
  }
  // 宿主 register 返回注销函数（按 key 摘除本次注册，避免热重载叠加旧面板）；
  // 类型声明写的是 string，以运行时为准，做 typeof 防御。
  if (typeof disposeSlot === "function") {
    try {
      const off = disposeSlot as () => void;
      api.lifecycle.onDispose(() => {
        try {
          off();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }
}

export default { id, tui };
