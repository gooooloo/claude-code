// =============================================================================
// 连接配置管理 — localStorage 持久化
// =============================================================================

export interface ConnectionConfig {
  id: string
  name: string
  baseUrl: string // 例如 https://xxx.devtunnels.ms
  token: string
}

const STORAGE_KEY = 'transcript-viewer-connections'

export function loadConnections(): ConnectionConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c): c is ConnectionConfig =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as ConnectionConfig).id === 'string' &&
        typeof (c as ConnectionConfig).baseUrl === 'string',
    )
  } catch {
    return []
  }
}

export function saveConnections(connections: ConnectionConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connections))
}

export function newConnectionId(): string {
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 规范化 baseUrl：去尾部斜杠，无协议时补 https:// */
export function normalizeBaseUrl(url: string): string {
  let trimmed = url.trim().replace(/\/+$/, '')
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`
  }
  return trimmed
}
