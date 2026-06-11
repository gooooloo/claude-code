import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionConfig } from './connections'
import { streamUrl } from './api'
import {
  buildActiveChain,
  chainToThreadEntries,
  parseJsonlLines,
} from './jsonl'
import { type PendingQuestion, extractPendingQuestions } from './jsonl/adapt'
import type { RawEntry } from './jsonl/types'
import type {
  AppendEvent,
  RemoteSessionState,
  SnapshotEvent,
  StateEvent,
} from './protocol'
import type { ThreadEntry } from './types'

// =============================================================================
// 实时会话 — SSE 订阅 + 增量链重建
//
// 服务端只推原始 JSONL 行，解析/链重建/投影全在端上完成
// （transcript = single source of truth，服务端保持「哑」）
// =============================================================================

export type LiveConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'error'

export interface LiveSession {
  entries: ThreadEntry[]
  pendingQuestions: PendingQuestion[]
  sessionState: RemoteSessionState
  connectionStatus: LiveConnectionStatus
}

export function useLiveSession(
  conn: ConnectionConfig,
  projectKey: string,
  sessionId: string,
): LiveSession {
  const rawEntriesRef = useRef<RawEntry[]>([])
  const [version, setVersion] = useState(0)
  const [sessionState, setSessionState] =
    useState<RemoteSessionState>('unknown')
  const [connectionStatus, setConnectionStatus] =
    useState<LiveConnectionStatus>('connecting')

  useEffect(() => {
    rawEntriesRef.current = []
    setVersion(0)
    setSessionState('unknown')
    setConnectionStatus('connecting')

    const source = new EventSource(streamUrl(conn, projectKey, sessionId))
    let snapshotBuffer: RawEntry[] = []

    source.addEventListener('snapshot', event => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as SnapshotEvent
        // EventSource 自动重连后服务端会重发 snapshot，第一块即重置缓冲
        if (snapshotBuffer.length === 0 && data.offset === 0) {
          rawEntriesRef.current = []
        }
        snapshotBuffer.push(...parseJsonlLines(data.lines.join('\n')))
        if (data.done) {
          rawEntriesRef.current = snapshotBuffer
          snapshotBuffer = []
          setConnectionStatus('live')
          setVersion(v => v + 1)
        }
      } catch {
        // 忽略坏事件
      }
    })

    source.addEventListener('append', event => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as AppendEvent
        const parsed = parseJsonlLines(data.lines.join('\n'))
        if (parsed.length > 0) {
          rawEntriesRef.current.push(...parsed)
          setVersion(v => v + 1)
        }
      } catch {
        // 忽略坏事件
      }
    })

    source.addEventListener('state', event => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as StateEvent
        setSessionState(data.state)
      } catch {
        // 忽略坏事件
      }
    })

    source.onopen = () => {
      // 重连时清空 snapshot 缓冲，等待服务端重发
      snapshotBuffer = []
    }
    source.onerror = () => {
      setConnectionStatus(prev => (prev === 'live' ? 'reconnecting' : 'error'))
    }

    return () => {
      source.close()
    }
  }, [conn, projectKey, sessionId])

  const { entries, pendingQuestions } = useMemo(() => {
    const chain = buildActiveChain(rawEntriesRef.current)
    return {
      entries: chainToThreadEntries(chain),
      pendingQuestions: extractPendingQuestions(chain),
    }
    // version 驱动重算：rawEntriesRef 是可变引用，version 即数据版本号
  }, [version])

  return { entries, pendingQuestions, sessionState, connectionStatus }
}
