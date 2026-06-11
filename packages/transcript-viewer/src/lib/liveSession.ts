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
  PermissionRequestEvent,
  PermissionRequestInfo,
  PermissionResolvedEvent,
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

// 待决/已决权限请求的视图
export interface PermissionView extends PermissionRequestInfo {
  resolved?: { behavior: 'allow' | 'deny'; by: string }
}

export interface LiveSession {
  entries: ThreadEntry[]
  pendingQuestions: PendingQuestion[]
  permissions: PermissionView[]
  sessionState: RemoteSessionState
  connectionStatus: LiveConnectionStatus
}

// 已解决的权限卡片保留多久（让用户看到"已由 X 处理"再消失）
const RESOLVED_LINGER_MS = 4000

export function useLiveSession(
  conn: ConnectionConfig,
  projectKey: string,
  sessionId: string,
): LiveSession {
  const rawEntriesRef = useRef<RawEntry[]>([])
  const [version, setVersion] = useState(0)
  const [permissions, setPermissions] = useState<PermissionView[]>([])
  const [sessionState, setSessionState] =
    useState<RemoteSessionState>('unknown')
  const [connectionStatus, setConnectionStatus] =
    useState<LiveConnectionStatus>('connecting')

  useEffect(() => {
    rawEntriesRef.current = []
    setVersion(0)
    setPermissions([])
    setSessionState('unknown')
    setConnectionStatus('connecting')

    let cancelled = false
    const removalTimers: ReturnType<typeof setTimeout>[] = []
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

    // 新权限请求 —— 按 id upsert（重连补发时不重复）
    source.addEventListener('permission_request', event => {
      try {
        const data = JSON.parse(
          (event as MessageEvent).data,
        ) as PermissionRequestEvent
        setPermissions(prev =>
          prev.some(p => p.id === data.permission.id)
            ? prev
            : [...prev, data.permission],
        )
      } catch {
        // 忽略坏事件
      }
    })

    // 权限已被某端解决 —— 置灰显示"已由 X 处理"，稍后移除
    source.addEventListener('permission_resolved', event => {
      try {
        const data = JSON.parse(
          (event as MessageEvent).data,
        ) as PermissionResolvedEvent
        setPermissions(prev =>
          prev.map(p =>
            p.id === data.id
              ? { ...p, resolved: { behavior: data.behavior, by: data.by } }
              : p,
          ),
        )
        const timer = setTimeout(() => {
          if (cancelled) return
          setPermissions(prev => prev.filter(p => p.id !== data.id))
        }, RESOLVED_LINGER_MS)
        removalTimers.push(timer)
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
      cancelled = true
      for (const timer of removalTimers) clearTimeout(timer)
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

  return {
    entries,
    pendingQuestions,
    permissions,
    sessionState,
    connectionStatus,
  }
}
