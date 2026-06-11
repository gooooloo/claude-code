import { describe, expect, test } from 'bun:test'
import { parseJsonlLines } from '../parse'

describe('parseJsonlLines', () => {
  test('parses valid JSONL lines', () => {
    const text = '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}'
    const entries = parseJsonlLines(text)
    expect(entries).toHaveLength(2)
    expect(entries[0].type).toBe('user')
    expect(entries[1].uuid).toBe('a1')
  })

  test('skips empty lines and whitespace', () => {
    const text =
      '\n{"type":"user","uuid":"u1"}\n\n  \n{"type":"assistant","uuid":"a1"}\n'
    expect(parseJsonlLines(text)).toHaveLength(2)
  })

  test('skips corrupted/truncated lines without throwing', () => {
    const text =
      '{"type":"user","uuid":"u1"}\n{"type":"assist\nnot json at all\n123\n"bare string"\n[1,2,3]'
    const entries = parseJsonlLines(text)
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBe('u1')
  })

  test('handles empty input', () => {
    expect(parseJsonlLines('')).toEqual([])
  })

  test('handles CRLF line endings', () => {
    const text =
      '{"type":"user","uuid":"u1"}\r\n{"type":"assistant","uuid":"a1"}\r\n'
    expect(parseJsonlLines(text)).toHaveLength(2)
  })
})
