/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { formatTime, roleIcon, truncateSummary, type TimelineNode } from "../types";
import { createTapHandler } from "../hooks/useMouseTap";

export interface NodeItemProps {
  readonly node: TimelineNode;
  readonly selected: boolean;
  /** 选中行背景/边框色（阶段 4 由 Timeline 从 api.theme.current 传入，默认走宿主主题） */
  readonly selectedBackground?: string;
  readonly borderColor?: string;
  /** 鼠标点击回调（面板层接 selectAndJump：选中 + 跳转主视图） */
  readonly onSelect?: (id: string) => void;
}

/** 单个消息节点：`[角色图标] 消息摘要（30字） HH:MM`，选中时加粗 + 左边框 + ▸ 标记；点击直接跳转 */
export function NodeItem(props: NodeItemProps) {
  // macOS 适配：部分终端只送达 release 不送达 press，双通道 tap 兜底（Windows 下 up 被去重，等价于纯 down）
  const tap = createTapHandler(() => props.onSelect?.(props.node.id));
  return (
    <box
      id={props.node.id}
      width="100%"
      flexDirection="row"
      backgroundColor={props.selected ? props.selectedBackground : undefined}
      border={props.selected ? ["left"] : undefined}
      borderColor={props.selected ? props.borderColor : undefined}
      onMouseDown={tap.onMouseDown}
      onMouseUp={tap.onMouseUp}
    >
      <text
        wrapMode="none"
        attributes={props.selected ? TextAttributes.BOLD : undefined}
      >
        {`${props.selected ? "▸" : " "}${roleIcon(props.node.role)} ${truncateSummary(props.node.summary)}`}
      </text>
      <text wrapMode="none">{` ${formatTime(props.node.timestamp)}`}</text>
    </box>
  );
}
