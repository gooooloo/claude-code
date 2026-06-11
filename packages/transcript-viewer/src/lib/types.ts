// =============================================================================
// 视图层数据模型 — 从 RCS Web UI 的 ThreadEntry 精简而来（只读场景）
// =============================================================================

// 工具调用状态（只读回放场景下不存在 running/waiting）
export type ToolCallStatus = 'complete' | 'error' | 'canceled'

export interface ToolCallData {
  id: string
  title: string
  status: ToolCallStatus
  rawInput?: Record<string, unknown>
  output?: string
}

// 助手消息块 — 普通消息或思考过程
export type AssistantChunk =
  | { type: 'message'; text: string }
  | { type: 'thought'; text: string }

// 用户消息中的图片
export interface UserMessageImage {
  mimeType: string
  data: string // base64 encoded
}

export interface UserMessageEntry {
  type: 'user_message'
  id: string
  content: string
  images?: UserMessageImage[]
}

export interface AssistantMessageEntry {
  type: 'assistant_message'
  id: string
  chunks: AssistantChunk[]
}

export interface ToolCallEntry {
  type: 'tool_call'
  toolCall: ToolCallData
}

// 执行计划（TodoWrite / 任务列表快照）
export type PlanItemStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanItem {
  content: string
  status: PlanItemStatus
}

export interface PlanDisplayEntry {
  type: 'plan'
  id: string
  items: PlanItem[]
}

// 分隔线 — compact boundary 等会话级事件
export interface DividerEntry {
  type: 'divider'
  id: string
  label: string
}

// 斜杠命令调用（<command-name> 消息）
export interface CommandEntry {
  type: 'command'
  id: string
  name: string
}

export type ThreadEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | PlanDisplayEntry
  | DividerEntry
  | CommandEntry

// 解析完成的会话
export interface ParsedSession {
  id: string
  fileName: string
  title?: string
  entries: ThreadEntry[]
  messageCount: number
  lastTimestamp?: string
}
