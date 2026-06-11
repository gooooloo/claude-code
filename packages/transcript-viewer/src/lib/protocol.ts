// =============================================================================
// 手机 App <-> 远端 relay server 的通信协议类型
// 服务端参考实现见 server/transcript_relay.py，协议文档见 docs/protocol.md
// =============================================================================

// 会话状态 — 由服务端从 transcript 尾部推导（与 claude-code-webui 同思路）
export type RemoteSessionState =
  | 'idle'
  | 'busy'
  | 'elicitation' // AskUserQuestion 等待回答
  | 'plan_review' // ExitPlanMode 等待审批
  | 'unknown'

// GET /api/sessions 返回的会话摘要
export interface RemoteSessionInfo {
  projectKey: string
  sessionId: string
  title?: string
  state: RemoteSessionState
  mtime: number // epoch 秒
  size: number // 字节
  cwd?: string
  boundPid?: number
}

// SSE 事件（GET /api/session/{projectKey}/{sessionId}/stream）
// event: snapshot —— 初始全量（可分多条，done 标记最后一条）
export interface SnapshotEvent {
  lines: string[]
  offset: number
  done: boolean
}

// event: append —— 文件增量
export interface AppendEvent {
  lines: string[]
  offset: number
}

// event: state —— 状态变化
export interface StateEvent {
  state: RemoteSessionState
}

// POST /api/session/{projectKey}/{sessionId}/input 请求体
// 服务端将语义动作翻译为具体按键序列（便于在 Windows 端调按键不动 App）
export type InputAction =
  | { type: 'prompt'; text: string } // 普通输入 + Enter
  | { type: 'option'; index: number } // AskUserQuestion 选项（0-based）
  | { type: 'text_answer'; text: string } // AskUserQuestion 自由文本回答
  | { type: 'interrupt' } // Ctrl-C

export interface InputResponse {
  ok: boolean
  error?: string
}

// GET /api/processes 返回（用于把会话绑定到终端进程）
export interface ProcessCandidate {
  pid: number
  name: string
  title?: string
}
