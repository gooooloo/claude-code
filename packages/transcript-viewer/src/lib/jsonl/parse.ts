import type { RawEntry } from './types'

// =============================================================================
// 宽容的 JSONL 解析 — 坏行/未知结构直接跳过，绝不抛错
// =============================================================================

export function parseJsonlLines(text: string): RawEntry[] {
  const entries: RawEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(parsed as RawEntry)
      }
    } catch {
      // 宽容解析：跳过截断/损坏的行（如同步中断导致的半行）
    }
  }
  return entries
}
