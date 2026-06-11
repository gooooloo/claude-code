// =============================================================================
// 手机 App <-> 远端服务端的通信协议类型
//
// 两类服务端，客户端协议兼容：
//  - relay（transcript_relay.py）：tail 已有 JSONL + 按键注入，只读/历史为主
//  - daemon（bridge-daemon.ts）：用 Agent SDK 跑会话，canUseTool 结构化权限,
//    权限请求广播全端、第一个客户端决定原子胜出（解决多端并发）
// 协议文档见 server/protocol.md
// =============================================================================

// 会话状态
export type RemoteSessionState =
  | 'idle'
  | 'busy'
  | 'elicitation' // AskUserQuestion 等待回答
  | 'plan_review' // ExitPlanMode 等待审批
  | 'permission' // 工具权限等待批准（daemon 的 canUseTool 在等）
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

// =============================================================================
// 权限请求（daemon canUseTool）—— 结构化、可被任意客户端回应
// =============================================================================

export interface PermissionRequestInfo {
  id: string // 本次权限请求的唯一 id（仲裁键）
  toolName: string
  title?: string // SDK 渲染的完整提示句（优先用它）
  displayName?: string // 简短动作名，适合按钮
  description?: string // 副标题
  input?: Record<string, unknown> // 工具入参（命令、文件路径等）
  toolUseID: string
  createdAt: number // epoch ms
}

// event: permission_request —— 新的待决权限（连接时也会把当前 pending 的补发）
export interface PermissionRequestEvent {
  permission: PermissionRequestInfo
}

// event: permission_resolved —— 某权限已被解决（第一个响应者胜出），全端据此置灰
export interface PermissionResolvedEvent {
  id: string
  behavior: 'allow' | 'deny'
  by: string // 解决者的客户端标识（label）
}

// POST /api/session/{projectKey}/{sessionId}/permission/{permissionId}
export interface PermissionDecision {
  decision: 'allow' | 'deny'
  clientId: string // 客户端标识，用于回显"由谁处理"
}

export interface PermissionDecisionResponse {
  ok: boolean
  // 抢答失败时返回已由谁处理
  alreadyResolvedBy?: string
  error?: string
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
