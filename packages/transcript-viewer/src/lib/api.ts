import type { ConnectionConfig } from './connections'
import type {
  InputAction,
  InputResponse,
  PermissionDecisionResponse,
  ProcessCandidate,
  RemoteSessionInfo,
} from './protocol'

// =============================================================================
// relay server HTTP API 客户端
// token 统一走 query 参数：EventSource 无法自定义 header，保持一致最省心
// =============================================================================

function buildUrl(
  conn: ConnectionConfig,
  path: string,
  params: Record<string, string> = {},
): string {
  const url = new URL(path, `${conn.baseUrl}/`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  if (conn.token) url.searchParams.set('token', conn.token)
  return url.toString()
}

async function getJson<T>(conn: ConnectionConfig, path: string): Promise<T> {
  const res = await fetch(buildUrl(conn, path), {
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export function listSessions(
  conn: ConnectionConfig,
): Promise<RemoteSessionInfo[]> {
  return getJson<RemoteSessionInfo[]>(conn, 'api/sessions')
}

export function listProcesses(
  conn: ConnectionConfig,
): Promise<ProcessCandidate[]> {
  return getJson<ProcessCandidate[]>(conn, 'api/processes')
}

export async function sendInput(
  conn: ConnectionConfig,
  projectKey: string,
  sessionId: string,
  action: InputAction,
): Promise<InputResponse> {
  const res = await fetch(
    buildUrl(conn, `api/session/${projectKey}/${sessionId}/input`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  return (await res.json()) as InputResponse
}

export async function bindPid(
  conn: ConnectionConfig,
  projectKey: string,
  sessionId: string,
  pid: number,
): Promise<InputResponse> {
  const res = await fetch(
    buildUrl(conn, `api/session/${projectKey}/${sessionId}/bind`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  return (await res.json()) as InputResponse
}

export async function decidePermission(
  conn: ConnectionConfig,
  projectKey: string,
  sessionId: string,
  permissionId: string,
  decision: 'allow' | 'deny',
  clientId: string,
  answers?: Record<string, string>,
): Promise<PermissionDecisionResponse> {
  const res = await fetch(
    buildUrl(
      conn,
      `api/session/${projectKey}/${sessionId}/permission/${permissionId}`,
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, clientId, answers }),
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  return (await res.json()) as PermissionDecisionResponse
}

export function streamUrl(
  conn: ConnectionConfig,
  projectKey: string,
  sessionId: string,
): string {
  return buildUrl(conn, `api/session/${projectKey}/${sessionId}/stream`)
}
