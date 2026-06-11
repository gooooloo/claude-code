import { describe, expect, test } from 'bun:test'
import { buildActiveChain, extractSessionTitle } from '../chain'
import type { RawEntry } from '../types'

function msg(
  type: string,
  uuid: string,
  parentUuid: string | null,
  extra: Partial<RawEntry> = {},
): RawEntry {
  return { type, uuid, parentUuid, ...extra }
}

describe('buildActiveChain', () => {
  test('rebuilds linear chain in order', () => {
    const entries = [
      msg('user', 'u1', null),
      msg('assistant', 'a1', 'u1'),
      msg('user', 'u2', 'a1'),
      msg('assistant', 'a2', 'u2'),
    ]
    const chain = buildActiveChain(entries)
    expect(chain.map(e => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  test('chain order is independent of file order', () => {
    const entries = [
      msg('assistant', 'a1', 'u1'),
      msg('user', 'u2', 'a1'),
      msg('user', 'u1', null),
      msg('assistant', 'a2', 'u2'),
    ]
    const chain = buildActiveChain(entries)
    expect(chain.map(e => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  test('picks latest leaf and drops dead branches (rewind scenario)', () => {
    // u1 -> a1 -> u2(dead) ; rewind 后追加 u3 -> a3
    const entries = [
      msg('user', 'u1', null),
      msg('assistant', 'a1', 'u1'),
      msg('user', 'u2', 'a1'),
      msg('user', 'u3', 'a1'),
      msg('assistant', 'a3', 'u3'),
    ]
    const chain = buildActiveChain(entries)
    expect(chain.map(e => e.uuid)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })

  test('ignores sidechain and metadata entries', () => {
    const entries = [
      msg('user', 'u1', null),
      msg('user', 's1', null, { isSidechain: true }),
      { type: 'ai-title', title: 'Hello' } as RawEntry,
      { type: 'file-history-snapshot', messageId: 'x' } as RawEntry,
      msg('assistant', 'a1', 'u1'),
    ]
    const chain = buildActiveChain(entries)
    expect(chain.map(e => e.uuid)).toEqual(['u1', 'a1'])
  })

  test('survives parent cycles', () => {
    const entries = [
      msg('user', 'u1', 'a1'),
      msg('assistant', 'a1', 'u1'),
      msg('user', 'u2', 'a1'),
    ]
    const chain = buildActiveChain(entries)
    // u2 是 leaf；回溯 a1 -> u1 -> a1 终止于 cycle guard
    expect(chain[chain.length - 1]?.uuid).toBe('u2')
    expect(chain.length).toBeGreaterThanOrEqual(2)
  })

  test('handles missing parent (orphan chain head)', () => {
    const entries = [
      msg('user', 'u2', 'missing-uuid'),
      msg('assistant', 'a2', 'u2'),
    ]
    const chain = buildActiveChain(entries)
    expect(chain.map(e => e.uuid)).toEqual(['u2', 'a2'])
  })

  test('empty input returns empty chain', () => {
    expect(buildActiveChain([])).toEqual([])
  })
})

describe('extractSessionTitle', () => {
  test('custom title beats ai title regardless of order', () => {
    const entries = [
      { type: 'custom-title', customTitle: 'Custom' },
      { type: 'ai-title', aiTitle: 'AI' },
    ] as RawEntry[]
    expect(extractSessionTitle(entries)).toBe('Custom')
  })

  test('latest ai title wins among ai titles', () => {
    const entries = [
      { type: 'ai-title', aiTitle: 'First' },
      { type: 'ai-title', aiTitle: 'Second' },
    ] as RawEntry[]
    expect(extractSessionTitle(entries)).toBe('Second')
  })

  test('summary used as fallback only', () => {
    const entries = [
      { type: 'summary', summary: 'Summary title' },
      { type: 'ai-title', aiTitle: 'AI title' },
    ] as RawEntry[]
    expect(extractSessionTitle(entries)).toBe('AI title')
  })

  test('returns undefined when no title', () => {
    expect(extractSessionTitle([{ type: 'user', uuid: 'u1' }])).toBeUndefined()
  })
})
