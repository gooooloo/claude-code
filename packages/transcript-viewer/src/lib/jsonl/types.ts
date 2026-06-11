// =============================================================================
// JSONL transcript 原始条目类型 — 宽容定义，未知字段一律保留为 unknown
// 参考 docs/internals/session-transcript-persistence.md
// =============================================================================

export interface RawContentBlock {
  type?: string
  // text block
  text?: string
  // thinking block
  thinking?: string
  // tool_use block
  id?: string
  name?: string
  input?: Record<string, unknown>
  // tool_result block
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  // image block
  source?: {
    type?: string
    media_type?: string
    data?: string
  }
  [key: string]: unknown
}

export interface RawMessage {
  role?: string
  content?: string | RawContentBlock[]
  [key: string]: unknown
}

export interface RawEntry {
  type?: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  logicalParentUuid?: string | null
  sessionId?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  timestamp?: string
  message?: RawMessage
  // session metadata entries
  customTitle?: string
  aiTitle?: string
  summary?: string
  compactMetadata?: Record<string, unknown>
  [key: string]: unknown
}

// 参与 parentUuid 链路的 transcript message 类型
export const TRANSCRIPT_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
])

export function isTranscriptMessage(entry: RawEntry): boolean {
  return (
    typeof entry.type === 'string' &&
    TRANSCRIPT_TYPES.has(entry.type) &&
    typeof entry.uuid === 'string'
  )
}
