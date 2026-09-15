/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { formatTime, roleIcon, truncateSummary, type TimelineNode } from "../types";

export interface NodeItemProps {
  readonly node: TimelineNode;
  readonly selected: boolean;
  /** 选中行背景/边框色（阶段 4 由 Timeline 从 api.theme.current 传入，默认走宿主主题） */
  readonly selectedBackground?: string;
  readonly borderColor?: string;
}

/** 单个消息节点：`[角色图标] 消息摘要（30字） HH:MM`，选中时加粗 + 左边框 + ▸ 标记 */
export function NodeItem(props: NodeItemProps) {
  return (
    <box
      id={props.node.id}
      width="100%"
      flexDirection="row"
      backgroundColor={props.selected ? props.selectedBackground : undefined}
      border={props.selected ? ["left"] : undefined}
      borderColor={props.selected ? props.borderColor : undefined}
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
