import type {
  AssistantMessageEntry,
  PlanItem,
  PlanItemStatus,
  ThreadEntry,
  ToolCallData,
  UserMessageImage,
} from '../types'
import { truncate } from '../utils'
import type { RawContentBlock, RawEntry } from './types'

// =============================================================================
// 链 -> ThreadEntry[] 投影 — 只读 UI scrollback 视图
// =============================================================================

interface ToolResultInfo {
  text: string
  isError: boolean
}

export function chainToThreadEntries(chain: RawEntry[]): ThreadEntry[] {
  // 第一遍：收集 tool_result，按 tool_use_id 配对
  const toolResults = new Map<string, ToolResultInfo>()
  for (const entry of chain) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        toolResults.set(block.tool_use_id, {
          text: extractResultText(block.content),
          isError: block.is_error === true,
        })
      }
    }
  }

  // 第二遍：按链路顺序生成视图条目
  const result: ThreadEntry[] = []

  for (const entry of chain) {
    switch (entry.type) {
      case 'assistant':
        appendAssistantEntry(result, entry, toolResults)
        break
      case 'user':
        appendUserEntry(result, entry)
        break
      case 'system':
        if (entry.subtype === 'compact_boundary') {
          result.push({
            type: 'divider',
            id: entryId(entry),
            label: '上下文已压缩',
          })
        }
        break
      default:
        // attachment 及未知类型不参与展示
        break
    }
  }

  return result
}

// =============================================================================
// assistant 消息 — text/thinking 聚合为 chunks，tool_use 展开为工具卡片
// =============================================================================

function appendAssistantEntry(
  result: ThreadEntry[],
  entry: RawEntry,
  toolResults: Map<string, ToolResultInfo>,
): void {
  const content = entry.message?.content
  if (!Array.isArray(content)) return

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.trim()) {
        currentAssistant(result, entry).chunks.push({
          type: 'message',
          text: block.text,
        })
      }
    } else if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string'
    ) {
      if (block.thinking.trim()) {
        currentAssistant(result, entry).chunks.push({
          type: 'thought',
          text: block.thinking,
        })
      }
    } else if (block.type === 'tool_use' && typeof block.id === 'string') {
      const planItems = extractPlanItems(block)
      if (planItems) {
        result.push({ type: 'plan', id: block.id, items: planItems })
      } else {
        result.push({
          type: 'tool_call',
          toolCall: buildToolCall(block, toolResults.get(block.id)),
        })
      }
    }
  }
}

/** 取当前正在聚合的 assistant 条目；若上一条不是 assistant 则新开一条 */
function currentAssistant(
  result: ThreadEntry[],
  entry: RawEntry,
): AssistantMessageEntry {
  const last = result[result.length - 1]
  if (last && last.type === 'assistant_message') return last
  const created: AssistantMessageEntry = {
    type: 'assistant_message',
    id: entryId(entry),
    chunks: [],
  }
  result.push(created)
  return created
}

// =============================================================================
// 工具调用映射
// =============================================================================

function buildToolCall(
  block: RawContentBlock,
  resultInfo: ToolResultInfo | undefined,
): ToolCallData {
  const rawName = typeof block.name === 'string' ? block.name : 'Tool'
  const name = simplifyToolName(rawName)
  const input = (block.input ?? {}) as Record<string, unknown>

  return {
    id: block.id as string,
    title: buildToolTitle(name, input),
    // 无 tool_result 视为被中断/取消
    status: resultInfo
      ? resultInfo.isError
        ? 'error'
        : 'complete'
      : 'canceled',
    rawInput: Object.keys(input).length > 0 ? input : undefined,
    output: resultInfo?.text || undefined,
  }
}

/** MCP 工具名缩短：mcp__server__tool_name -> tool_name */
function simplifyToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const segments = name.split('__')
  return segments[segments.length - 1] || name
}

/** 工具标题：名称 + 最有信息量的参数摘要 */
function buildToolTitle(name: string, input: Record<string, unknown>): string {
  const KEY_PARAMS = [
    'description',
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'query',
    'prompt',
    'skill',
  ]
  for (const key of KEY_PARAMS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return `${name}: ${truncate(value.trim().replace(/\s+/g, ' '), 80)}`
    }
  }
  return name
}

/** TodoWrite / 任务列表快照 -> Plan 条目 */
function extractPlanItems(block: RawContentBlock): PlanItem[] | null {
  if (block.name !== 'TodoWrite') return null
  const input = block.input as Record<string, unknown> | undefined
  const todos = input?.todos
  if (!Array.isArray(todos) || todos.length === 0) return null

  const items: PlanItem[] = []
  for (const todo of todos) {
    if (!todo || typeof todo !== 'object') continue
    const record = todo as Record<string, unknown>
    if (typeof record.content !== 'string') continue
    items.push({
      content: record.content,
      status: normalizePlanStatus(record.status),
    })
  }
  return items.length > 0 ? items : null
}

function normalizePlanStatus(status: unknown): PlanItemStatus {
  if (status === 'completed' || status === 'in_progress') return status
  return 'pending'
}

// =============================================================================
// user 消息 — 字符串 prompt / 内容块数组 / 命令与系统噪音过滤
// =============================================================================

function appendUserEntry(result: ThreadEntry[], entry: RawEntry): void {
  // 内部控制消息不展示；compact summary 由 boundary 分隔线代表
  if (entry.isMeta || entry.isCompactSummary) return

  const content = entry.message?.content

  if (typeof content === 'string') {
    appendUserText(result, entry, content)
    return
  }

  if (Array.isArray(content)) {
    // tool_result 已在第一遍配对，这里只取 text/image 块（如带图粘贴）
    const texts: string[] = []
    const images: UserMessageImage[] = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        images.push({
          mimeType: block.source.media_type ?? 'image/png',
          data: block.source.data ?? '',
        })
      }
    }
    const joined = texts.join('\n').trim()
    const cleaned = stripTranscriptNoise(joined)
    if (cleaned || images.length > 0) {
      result.push({
        type: 'user_message',
        id: entryId(entry),
        content: cleaned,
        images: images.length > 0 ? images : undefined,
      })
    }
  }
}

function appendUserText(
  result: ThreadEntry[],
  entry: RawEntry,
  raw: string,
): void {
  // 斜杠命令调用 -> 紧凑命令行
  const commandName = matchTag(raw, 'command-name')
  if (commandName) {
    result.push({
      type: 'command',
      id: entryId(entry),
      name: commandName,
    })
    return
  }
  // 本地命令输出 -> 不展示
  if (raw.includes('<local-command-stdout>')) return

  const cleaned = stripTranscriptNoise(raw)
  if (!cleaned) return
  result.push({ type: 'user_message', id: entryId(entry), content: cleaned })
}

/** 去掉注入的系统噪音标签，保留用户真正输入的文本 */
function stripTranscriptNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim()
}

function matchTag(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  const value = match?.[1]?.trim()
  return value ? value : null
}

// =============================================================================
// 工具
// =============================================================================

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as RawContentBlock).type === 'text' &&
      typeof (block as RawContentBlock).text === 'string'
    ) {
      texts.push((block as RawContentBlock).text as string)
    }
  }
  return texts.join('\n')
}

let fallbackId = 0
function entryId(entry: RawEntry): string {
  if (typeof entry.uuid === 'string') return entry.uuid
  fallbackId += 1
  return `entry-${fallbackId}`
}
