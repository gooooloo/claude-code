// =============================================================================
// 客户端标识 —— 用于权限「由谁处理」的回显，按设备持久化
// =============================================================================

const STORAGE_KEY = 'transcript-viewer-client-id'

function detectDefaultLabel(): string {
  const ua = navigator.userAgent
  if (/iPad/.test(ua)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android'
  if (/Mac/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  return '客户端'
}

let cached: string | null = null

/** 返回稳定的客户端标识（首次生成后持久化）。 */
export function clientId(): string {
  if (cached) return cached
  let id = localStorage.getItem(STORAGE_KEY)
  if (!id) {
    const suffix = Math.random().toString(36).slice(2, 6)
    id = `${detectDefaultLabel()}-${suffix}`
    localStorage.setItem(STORAGE_KEY, id)
  }
  cached = id
  return id
}
