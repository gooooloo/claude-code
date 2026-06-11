import { type RawEntry, isTranscriptMessage } from './types'

// =============================================================================
// 链路重建 — uuid -> message map、leaf 选择、parentUuid 回溯
//
// JSONL 文件顺序只代表写入顺序；rewind/branch 会留下死分支。
// 有效链 = 从最新 leaf 沿 parentUuid 回溯到根的世界线。
// =============================================================================

export function buildActiveChain(entries: RawEntry[]): RawEntry[] {
  // uuid -> message（同 uuid 后写覆盖先写）
  const messages = new Map<string, RawEntry>()
  // uuid -> 文件顺序（用于选最新 leaf）
  const fileOrder = new Map<string, number>()

  let index = 0
  for (const entry of entries) {
    if (!isTranscriptMessage(entry) || entry.isSidechain) continue
    const uuid = entry.uuid as string
    messages.set(uuid, entry)
    fileOrder.set(uuid, index)
    index += 1
  }

  if (messages.size === 0) return []

  // 被引用为 parent 的 uuid 集合
  const referencedAsParent = new Set<string>()
  for (const msg of messages.values()) {
    if (typeof msg.parentUuid === 'string') {
      referencedAsParent.add(msg.parentUuid)
    }
  }

  // leaf 候选 = 没有子节点的消息；取文件顺序最靠后的
  let leaf: RawEntry | undefined
  let leafOrder = -1
  for (const [uuid, msg] of messages) {
    if (referencedAsParent.has(uuid)) continue
    const order = fileOrder.get(uuid) ?? -1
    if (order > leafOrder) {
      leaf = msg
      leafOrder = order
    }
  }
  if (!leaf) {
    // 全部成环的退化情况：退回文件顺序最后一条
    let maxOrder = -1
    for (const [uuid, msg] of messages) {
      const order = fileOrder.get(uuid) ?? -1
      if (order > maxOrder) {
        leaf = msg
        maxOrder = order
      }
    }
  }
  if (!leaf) return []

  // 沿 parentUuid 回溯，cycle guard 防止死循环
  const chain: RawEntry[] = []
  const visited = new Set<string>()
  let current: RawEntry | undefined = leaf
  while (current) {
    const uuid = current.uuid as string
    if (visited.has(uuid)) break
    visited.add(uuid)
    chain.push(current)
    const parentUuid: string | null | undefined =
      current.parentUuid ?? current.logicalParentUuid
    current =
      typeof parentUuid === 'string' ? messages.get(parentUuid) : undefined
  }

  chain.reverse()
  return chain
}

// =============================================================================
// 会话标题 — custom-title / ai-title / summary metadata，last-wins
// =============================================================================

export function extractSessionTitle(entries: RawEntry[]): string | undefined {
  // 优先级：custom-title（用户手动设置）> ai-title > summary
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let summary: string | undefined
  for (const entry of entries) {
    if (
      entry.type === 'custom-title' &&
      typeof entry.customTitle === 'string'
    ) {
      if (entry.customTitle.trim()) customTitle = entry.customTitle.trim()
    } else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      if (entry.aiTitle.trim()) aiTitle = entry.aiTitle.trim()
    } else if (entry.type === 'summary' && typeof entry.summary === 'string') {
      if (entry.summary.trim()) summary = entry.summary.trim()
    }
  }
  return customTitle ?? aiTitle ?? summary
}

export function extractSessionId(entries: RawEntry[]): string | undefined {
  for (const entry of entries) {
    if (typeof entry.sessionId === 'string' && entry.sessionId) {
      return entry.sessionId
    }
  }
  return undefined
}
