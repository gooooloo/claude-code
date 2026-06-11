import type { ParsedSession } from '../types'
import { chainToThreadEntries } from './adapt'
import {
  buildActiveChain,
  extractSessionId,
  extractSessionTitle,
} from './chain'
import { parseJsonlLines } from './parse'

export { chainToThreadEntries } from './adapt'
export {
  buildActiveChain,
  extractSessionId,
  extractSessionTitle,
} from './chain'
export { parseJsonlLines } from './parse'
export type { RawContentBlock, RawEntry, RawMessage } from './types'

// =============================================================================
// 入口：JSONL 文本 -> ParsedSession
// =============================================================================

export function parseSessionFile(
  fileName: string,
  text: string,
): ParsedSession {
  const entries = parseJsonlLines(text)
  const chain = buildActiveChain(entries)
  const threadEntries = chainToThreadEntries(chain)

  let lastTimestamp: string | undefined
  for (let i = chain.length - 1; i >= 0; i--) {
    const ts = chain[i].timestamp
    if (typeof ts === 'string') {
      lastTimestamp = ts
      break
    }
  }

  return {
    id: extractSessionId(entries) ?? fileName,
    fileName,
    title: extractSessionTitle(entries),
    entries: threadEntries,
    messageCount: chain.filter(e => e.type === 'user' || e.type === 'assistant')
      .length,
    lastTimestamp,
  }
}
