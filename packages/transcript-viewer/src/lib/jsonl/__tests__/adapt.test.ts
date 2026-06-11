import { describe, expect, test } from 'bun:test'
import { chainToThreadEntries } from '../adapt'
import type { RawEntry } from '../types'

describe('chainToThreadEntries', () => {
  test('maps user string content to user_message', () => {
    const chain: RawEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: '修复测试' },
      },
    ]
    const entries = chainToThreadEntries(chain)
    expect(entries).toEqual([
      { type: 'user_message', id: 'u1', content: '修复测试' },
    ])
  })

  test('maps assistant text and thinking to chunks', () => {
    const chain: RawEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: '我来检查。' },
          ],
        },
      },
    ]
    const entries = chainToThreadEntries(chain)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      type: 'assistant_message',
      id: 'a1',
      chunks: [
        { type: 'thought', text: 'hmm' },
        { type: 'message', text: '我来检查。' },
      ],
    })
  })

  test('merges consecutive assistant messages into one entry', () => {
    const chain: RawEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'text', text: 'part 1' }] },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        message: { content: [{ type: 'text', text: 'part 2' }] },
      },
    ]
    const entries = chainToThreadEntries(chain)
    expect(entries).toHaveLength(1)
    expect((entries[0] as { chunks: unknown[] }).chunks).toHaveLength(2)
  })

  test('pairs tool_use with tool_result across messages', () => {
    const chain: RawEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'ls -la', description: 'List files' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'file1\nfile2',
            },
          ],
        },
      },
    ]
    const entries = chainToThreadEntries(chain)
    expect(entries).toHaveLength(1)
    const tool = entries[0]
    expect(tool.type).toBe('tool_call')
    if (tool.type === 'tool_call') {
      expect(tool.toolCall.title).toBe('Bash: List files')
      expect(tool.toolCall.status).toBe('complete')
      expect(tool.toolCall.output).toBe('file1\nfile2')
    }
  })

  test('marks errored tool_result as error', () => {
    const chain: RawEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'boom' }],
              is_error: true,
            },
          ],
        },
      },
    ]
    const entries = chainToThreadEntries(chain)
    if (entries[0].type === 'tool_call') {
      expect(entries[0].toolCall.status).toBe('error')
      expect(entries[0].toolCall.output).toBe('boom')
    } else {
      throw new Error('expected tool_call')
    }
  })

  test('tool_use without result is canceled', () => {
    const chain: RawEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          ],
        },
      },
    ]
    const entries = chainToThreadEntries(chain)
    if (entries[0].type === 'tool_call') {
      expect(entries[0].toolCall.status).toBe('canceled')
    } else {
      throw new Error('expected tool_call')
    }
  })

  test('TodoWrite becomes plan entry', () => {
    const chain: RawEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'step 1', status: 'completed' },
                  { content: 'step 2', status: 'in_progress' },
                  { content: 'step 3', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
    ]
    const entries = chainToThreadEntries(chain)
    expect(entries[0]).toEqual({
      type: 'plan',
      id: 'toolu_1',
      items: [
        { content: 'step 1', status: 'completed' },
        { content: 'step 2', status: 'in_progress' },
        { content: 'step 3', status: 'pending' },
      ],
    })
  })

  test('compact boundary becomes divider', () => {
    const chain: RawEntry[] = [
      { type: 'system', subtype: 'compact_boundary', uuid: 'b1' },
    ]
    expect(chainToThreadEntries(chain)).toEqual([
      { type: 'divider', id: 'b1', label: '上下文已压缩' },
    ])
  })

  test('skips meta/compact-summary user messages and command stdout', () => {
    const chain: RawEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        isMeta: true,
        message: { content: 'internal' },
      },
      {
        type: 'user',
        uuid: 'u2',
        isCompactSummary: true,
        message: { content: 'summary...' },
      },
      {
        type: 'user',
        uuid: 'u3',
        message: {
          content: '<local-command-stdout>out</local-command-stdout>',
        },
      },
    ]
    expect(chainToThreadEntries(chain)).toEqual([])
  })

  test('slash command becomes command entry', () => {
    const chain: RawEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        message: {
          content:
            '<command-name>/model</command-name><command-message>model</command-message>',
        },
      },
    ]
    expect(chainToThreadEntries(chain)).toEqual([
      { type: 'command', id: 'u1', name: '/model' },
    ])
  })

  test('strips system-reminder noise from user text', () => {
    const chain: RawEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        message: {
          content: '<system-reminder>noise</system-reminder>真正的输入',
        },
      },
    ]
    expect(chainToThreadEntries(chain)).toEqual([
      { type: 'user_message', id: 'u1', content: '真正的输入' },
    ])
  })

  test('user array content with text and image', () => {
    const chain: RawEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        message: {
          content: [
            { type: 'text', text: '看这张截图' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
            },
          ],
        },
      },
    ]
    const entries = chainToThreadEntries(chain)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      type: 'user_message',
      id: 'u1',
      content: '看这张截图',
      images: [{ mimeType: 'image/png', data: 'AAAA' }],
    })
  })

  test('whitespace-only assistant text is dropped', () => {
    const chain: RawEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'text', text: '  \n ' }] },
      },
    ]
    expect(chainToThreadEntries(chain)).toEqual([])
  })
})
