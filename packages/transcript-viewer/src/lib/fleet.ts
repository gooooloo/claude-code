import { useEffect, useState } from 'react'
import { listSessions } from './api'
import type { ConnectionConfig } from './connections'

// =============================================================================
// 舰队状态 —— 首页并行轮询每台机器，汇总在线 / 会话数 / 待办
// =============================================================================

export interface MachineStatus {
  loading: boolean
  online: boolean
  sessionCount: number
  attentionCount: number // elicitation + plan_review，即「等你回答」
  error?: string
}

const POLL_INTERVAL_MS = 15000
const EMPTY: MachineStatus = {
  loading: true,
  online: false,
  sessionCount: 0,
  attentionCount: 0,
}

export function useFleetStatus(
  connections: ConnectionConfig[],
): Map<string, MachineStatus> {
  const [statuses, setStatuses] = useState<Map<string, MachineStatus>>(
    new Map(),
  )

  // 连接列表的稳定签名，避免每次渲染都重启轮询
  const signature = connections
    .map(c => `${c.id}:${c.baseUrl}:${c.token}`)
    .join('|')

  useEffect(() => {
    let cancelled = false

    async function probe(conn: ConnectionConfig): Promise<MachineStatus> {
      try {
        const sessions = await listSessions(conn)
        return {
          loading: false,
          online: true,
          sessionCount: sessions.length,
          attentionCount: sessions.filter(
            s =>
              s.state === 'elicitation' ||
              s.state === 'plan_review' ||
              s.state === 'permission',
          ).length,
        }
      } catch (err) {
        return {
          loading: false,
          online: false,
          sessionCount: 0,
          attentionCount: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    async function pollAll() {
      const results = await Promise.all(
        connections.map(async conn => [conn.id, await probe(conn)] as const),
      )
      if (cancelled) return
      setStatuses(new Map(results))
    }

    // 初始把所有机器置为 loading
    setStatuses(new Map(connections.map(c => [c.id, EMPTY])))
    pollAll()
    const timer = setInterval(pollAll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // signature 是 connections 的内容指纹，变化时即重启轮询
  }, [signature])

  return statuses
}
