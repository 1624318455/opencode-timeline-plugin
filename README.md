# opencode-timeline-plugin

OpenCode TUI 对话历史节点查看器：在侧边栏以可滚动列表展示当前会话的消息节点，支持键盘导航与选中跳转（MVP 为线性时间线，预留树状扩展字段）。

> 技术栈：TypeScript + Solid + OpenTUI，运行于 OpenCode TUI 插件宿主（`@opencode-ai/plugin/tui`）。注意：宿主实际是 Solid/OpenTUI，不是 React/Ink。

## 功能

- 侧边栏时间线：`[角色图标] 摘要（30字符截断） HH:MM`，tool 调用展开为子节点
- `Alt+U` 切换面板，`↑/↓` 移动选中，`Enter` 跳转（见已知问题），`Esc` 关闭
- 数据源走宿主响应式 store（对齐官方 sidebar TODO）：进会话时宿主自动回填历史，SSE 到后约一帧延迟自动刷新；选中失效时跟随到末尾
- 上次选中经 `api.kv` 持久化，重启可恢复

| 按键 | 动作 |
| ---- | ---- |
| `Alt+U` | 显示 / 隐藏面板 |
| `↑` / `↓` | 移动 `▸` 选中行 |
| `Enter` | 跳转（当前为 toast + kv 持久化） |
| `Esc` | 关闭面板 |

## 环境要求

- `opencode >= 1.0`（已验证 `1.18.30` / `1.18.31`）
- Node 18+，npm 9+（或 bun 1.0+）
- macOS / Linux / WSL 均可，Windows 原生终端注意 `Alt+U` 可能被占用

## 新机器 5 分钟初始化（复制粘贴即用）

```bash
# 1. 克隆（按你实际地址替换，已创建后就是下面这个）
git clone https://github.com/1624318455/opencode-timeline-plugin.git
cd opencode-timeline-plugin

# 2. 安装依赖
npm install

# 3. 类型检查（期望：无输出即通过）
npm run typecheck

# 4. 取本仓库绝对路径（下一步要用）
pwd
# 假设输出 /Users/xxx/opencode-timeline-plugin

# 5. 注册到 OpenCode 全局 TUI 配置（没有就新建）
# 编辑 ~/.config/opencode/tui.json，写入：
```

`~/.config/opencode/tui.json` 示例（**路径必须改成你上一步 `pwd` 的绝对路径**）：

```jsonc
{
  // JSONC：允许注释
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["/绝对路径/opencode-timeline-plugin/src/panel.tsx", { "maxItems": 50 }]
  ]
}
```

一键写入（macOS / Linux，把路径换成你自己的再执行）：

```bash
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/tui.json <<'EOF'
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["/绝对路径/opencode-timeline-plugin/src/panel.tsx", { "maxItems": 50 }]
  ]
}
EOF
cat ~/.config/opencode/tui.json
```

```bash
# 6. 启动验证
opencode
# 进入一个会话，看侧边栏是否出现 Timeline (Alt+U)
# 发一条新消息，列表应自动追加并跟随到末尾
```

> 本仓库自带的 `tui.json` 只是**本地调试示例**，OpenCode 不会读它。真正生效的是上面第 5 步的 `~/.config/opencode/tui.json`（全局）或 `<你的项目>/.opencode/tui.json`（项目级）。

## 配置说明

| 方式 | 文件位置 | 路径基准 | 适用场景 |
| ---- | -------- | -------- | -------- |
| 全局（推荐） | `~/.config/opencode/tui.json` | 绝对路径 | 所有项目共用，换机器只改一次 |
| 项目级 | `<你的项目>/.opencode/tui.json` | 以该文件为基准解析 | 只给单个项目用 |

可选参数：

```jsonc
{
  "plugin": [
    ["/绝对路径/opencode-timeline-plugin/src/panel.tsx", {
      "maxItems": 50 // 过长会话的截断窗口，默认 50
    }]
  ],
  // 按插件 id 开关，默认全启用。关闭本插件：
  // "plugin_enabled": { "timeline.viewer": false }
}
```

## 使用

1. `opencode` 启动 TUI 并进入一个会话，侧边栏出现 `Timeline (Alt+U)` 面板。
2. `Alt+U` 显示/隐藏；`↑/↓` 移动 `▸` 选中行；`Enter` 跳转；`Esc` 关闭。
3. 发一条新消息，列表应自动追加并跟随到末尾。

冒烟实测（2026-09-13，`opencode 1.18.30`，PTY 非交互启动约 20s 后超时结束）：

- `loading tui config` + `applying tui config` 均出现，无 ERROR
- 仅有与本插件无关的既有 WARN（duplicate skill name）
- TUI 正常渲染到 home 画面（`Ask anything…`）

## 他机更新流程

```bash
cd opencode-timeline-plugin
git pull
npm install        # 依赖有变化时才需要
npm run typecheck
# 重启 opencode 即可（tui.json 改了也要重启，不热重载）
```

## 排错 FAQ

| 现象 | 检查 |
| ---- | ---- |
| 面板没出现 | `tui.json` 路径是否为**绝对路径**；插件 `id` 是否为 `timeline.viewer`；启动日志有无 `loading tui config` / ERROR |
| 快捷键无效 | 终端是否吞掉了 `Alt+U`（换个终端或改绑定，见 `src/hooks/useKeybind.ts`）；输入框聚焦时导航键不劫持是预期行为 |
| 列表不刷新 | 看是否进了会话；数据源是 `api.state` 快照 + 事件订阅/轮询混合驱动（见 `src/hooks/useMessages.ts` 三路驱动注释），宿主历史回填靠进会话时的 catch-up bump 兜住 |
| `npm run build` 失败 | 预期行为，当前只有 `typecheck`，`build` 是占位脚本 |

## 项目结构

```
├── package.json          # exports["./tui"] 指向 ./src/panel.tsx
├── tsconfig.json         # jsxImportSource @opentui/solid
├── tui.json              # 本地调试示例（非真实配置，见上）
└── src/
    ├── index.tsx         # 插件入口：slots.register(sidebar_content) + 面板接线
    ├── types.ts          # TimelineNode / truncate / roleIcon / formatTime
    ├── components/
    │   ├── Timeline.tsx  # scrollbox 列表 + 选中自动滚入视口
    │   └── NodeItem.tsx  # 单节点行渲染
    ├── hooks/
    │   ├── useMessages.ts# 快照+订阅+选中/可见性状态
    │   └── useKeybind.ts # keymap 图层注册与注销
    └── api/
        └── opencode.ts   # state/event/kv/toast 封装，含 3 个 TODO
```

## 已知问题 / TODO

1. **Enter 跳转目前是 toast + kv 持久化**，宿主暂无公开“滚动到 messageID” API（`src/api/opencode.ts:jumpToMessage`）。待向 opencode 确认 session 视图滚动接口后补全。
2. **keymap schema 按最小结构类型编写**（`src/hooks/useKeybind.ts`），`alt+u` 等键名字符串待对照本地 `@opentui/keymap` 文档确认；若冲突可改 `timeline.*` 命令名或键位。
3. **主题色当前走宿主默认**（`src/panel.tsx`），`RGBA → ColorInput` 映射待确认后接入 `selectedBackground/borderColor`。
4. 树状视图：`TimelineNode.parentId/children` 已预留，UI 仍为线性；对标 `opencode-tree` 的折叠/缩进尚未实现。
5. 鼠标滚轮：TUI 无点击语义，`Timeline` 用 `scrollbox`，滚轮行为跟随宿主实现，未单独处理。
