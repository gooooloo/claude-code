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

// =============================================================================
// 导入 / 导出 —— 十几台机器的配置一次设好，跨 iOS / iPad / Windows 同步
// =============================================================================

interface ConnectionsBundle {
  type: 'transcript-viewer-connections'
  version: 1
  connections: ConnectionConfig[]
}

export function exportConnections(connections: ConnectionConfig[]): string {
  const bundle: ConnectionsBundle = {
    type: 'transcript-viewer-connections',
    version: 1,
    connections,
  }
  return JSON.stringify(bundle, null, 2)
}

/** 解析导入文本，返回合法连接列表；解析失败返回 null */
export function parseConnectionsImport(
  text: string,
): ConnectionConfig[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  // 兼容两种格式：bundle 包裹 或 裸数组
  const raw = Array.isArray(parsed)
    ? parsed
    : (parsed as ConnectionsBundle)?.connections
  if (!Array.isArray(raw)) return null

  const result: ConnectionConfig[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Partial<ConnectionConfig>
    if (typeof c.baseUrl !== 'string' || !c.baseUrl.trim()) continue
    result.push({
      id: typeof c.id === 'string' && c.id ? c.id : newConnectionId(),
      name: typeof c.name === 'string' ? c.name : '',
      baseUrl: normalizeBaseUrl(c.baseUrl),
      token: typeof c.token === 'string' ? c.token : '',
    })
  }
  return result
}

/** 按 baseUrl 去重合并：导入项覆盖同地址的旧项，其余追加 */
export function mergeConnections(
  existing: ConnectionConfig[],
  incoming: ConnectionConfig[],
): ConnectionConfig[] {
  const byUrl = new Map<string, ConnectionConfig>()
  for (const conn of existing) byUrl.set(conn.baseUrl, conn)
  for (const conn of incoming) {
    const prev = byUrl.get(conn.baseUrl)
    // 保留旧 id，避免打断正在查看的连接引用
    byUrl.set(conn.baseUrl, prev ? { ...conn, id: prev.id } : conn)
  }
  return [...byUrl.values()]
}
