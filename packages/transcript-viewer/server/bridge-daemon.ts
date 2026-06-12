#!/usr/bin/env bun
/**
 * Bridge Daemon —— 路线 1 的服务端:用 Agent SDK 跑 Claude Code 会话,
 * 通过 canUseTool 把权限做成「结构化回调」,由 daemon 持有、广播全端、
 * 第一个客户端的决定原子胜出(解决"本地+多端"并发抢答问题)。
 *
 * 对比 transcript_relay.py(tail JSONL + 按键注入):daemon 直接拥有会话,
 * 权限是回调返回值而非按键,天然对称、可被任意端回应、先到先得。
 *
 * 部署(每台远端机器一份,各自经 devtunnel 暴露):
 *     bun run server/bridge-daemon.ts --token <密钥> --port 19860
 *     devtunnel host -p 19860 --allow-anonymous
 *
 * 本机验证(不调真 SDK / 不耗 API):
 *     bun run server/bridge-daemon.ts --token test --port 19860 --mock
 *
 * 协议见 server/protocol.md。会话消息以 JSONL 行形式经 SSE 下发,
 * 客户端复用既有的链重建/渲染;权限走独立的 permission_request/resolved 事件。
 */

import type {
  PermissionDecision,
  PermissionRequestInfo,
  RemoteSessionInfo,
  RemoteSessionState,
} from '../src/lib/protocol'

// =============================================================================
// CLI 参数
// =============================================================================

interface Args {
  port: number
  host: string
  token: string
  mock: boolean
  askAll: boolean
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 19860,
    host: '127.0.0.1',
    token: process.env.RELAY_TOKEN ?? '',
    mock: false,
    askAll: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--token') args.token = argv[++i]
    else if (a === '--mock') args.mock = true
    else if (a === '--ask-all') args.askAll = true
    else if (a === '--verbose') args.verbose = true
  }
  return args
}

const ARGS = parseArgs(Bun.argv.slice(2))

// =============================================================================
// 会话模型
// =============================================================================

interface PendingPermission {
  info: PermissionRequestInfo
  resolve: (decision: 'allow' | 'deny') => void
  resolvedBy?: string // 抢答胜者，置位即锁定
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>
}

interface Session {
  projectKey: string
  sessionId: string
  cwd: string
  title: string
  state: RemoteSessionState
  lines: string[] // 已下发的 JSONL 行
  lastUuid: string | null // 用于串 parentUuid
  pending: Map<string, PendingPermission>
  recentlyResolved: Map<string, string> // id -> 胜者，供晚到的抢答 POST 回显
  subscribers: Set<Subscriber>
  pushInput: (text: string) => void // 向会话喂用户输入
  interrupt: () => void
}

const sessions = new Map<string, Session>() // key = `${projectKey}/${sessionId}`

function sessionKey(projectKey: string, sessionId: string): string {
  return `${projectKey}/${sessionId}`
}

// =============================================================================
// SSE 下发
// =============================================================================

const encoder = new TextEncoder()

function sseSend(sub: Subscriber, event: string, data: unknown): void {
  try {
    sub.controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    )
  } catch {
    // 订阅者已断开
  }
}

function broadcast(session: Session, event: string, data: unknown): void {
  for (const sub of session.subscribers) sseSend(sub, event, data)
}

function setState(session: Session, state: RemoteSessionState): void {
  if (session.state === state) return
  session.state = state
  broadcast(session, 'state', { state })
}

// 追加一条 JSONL 行并广播 append
function emitEntry(session: Session, entry: Record<string, unknown>): void {
  const uuid = typeof entry.uuid === 'string' ? entry.uuid : crypto.randomUUID()
  const full = {
    parentUuid: session.lastUuid,
    sessionId: session.sessionId,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    ...entry,
    uuid,
  }
  session.lastUuid = uuid
  const line = JSON.stringify(full)
  session.lines.push(line)
  broadcast(session, 'append', { lines: [line], offset: session.lines.length })
}

// =============================================================================
// 权限仲裁 —— canUseTool 调它，落 pending + 广播；decide 原子胜出
// =============================================================================

function requestPermission(
  session: Session,
  toolName: string,
  input: Record<string, unknown>,
  meta: {
    toolUseID: string
    title?: string
    displayName?: string
    description?: string
  },
): Promise<'allow' | 'deny'> {
  const info: PermissionRequestInfo = {
    id: crypto.randomUUID(),
    toolName,
    title: meta.title,
    displayName: meta.displayName,
    description: meta.description,
    input,
    toolUseID: meta.toolUseID,
    createdAt: Date.now(),
  }
  return new Promise<'allow' | 'deny'>(resolve => {
    session.pending.set(info.id, { info, resolve })
    setState(session, 'permission')
    broadcast(session, 'permission_request', { permission: info })
    if (ARGS.verbose) console.log(`[perm] 待决 ${toolName} id=${info.id}`)
  })
}

// 返回 true=本次抢答成功；false=已被别人抢先
function decidePermission(
  session: Session,
  permissionId: string,
  decision: 'allow' | 'deny',
  by: string,
): { ok: boolean; alreadyResolvedBy?: string } {
  const pending = session.pending.get(permissionId)
  if (!pending) {
    // 已被抢先(刚解决)或早已过期
    const winner = session.recentlyResolved.get(permissionId)
    return { ok: false, alreadyResolvedBy: winner ?? '已过期' }
  }
  if (pending.resolvedBy) {
    return { ok: false, alreadyResolvedBy: pending.resolvedBy }
  }
  // 原子置位:JS 单线程，这里的 check-then-set 不会被打断
  pending.resolvedBy = by
  pending.resolve(decision)
  session.pending.delete(permissionId)
  session.recentlyResolved.set(permissionId, by)
  setTimeout(() => session.recentlyResolved.delete(permissionId), 30000)
  broadcast(session, 'permission_resolved', {
    id: permissionId,
    behavior: decision,
    by,
  })
  if (ARGS.verbose)
    console.log(`[perm] ${permissionId} -> ${decision} by ${by}`)
  // 还有别的待决就保持 permission，否则回 busy(SDK 会继续)
  setState(session, session.pending.size > 0 ? 'permission' : 'busy')
  return { ok: true }
}

// =============================================================================
// Mock 会话 —— 不调真 SDK，模拟"回复 + 要权限"的完整回合
// =============================================================================

function startMockSession(
  projectKey: string,
  cwd: string,
  firstPrompt: string,
): Session {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    projectKey,
    sessionId,
    cwd,
    title: firstPrompt.slice(0, 40) || '新会话',
    state: 'idle',
    lines: [],
    lastUuid: null,
    pending: new Map(),
    recentlyResolved: new Map(),
    subscribers: new Set(),
    pushInput: () => {},
    interrupt: () => {},
  }
  sessions.set(sessionKey(projectKey, sessionId), session)

  let turn = 0
  const runTurn = async (prompt: string) => {
    turn += 1
    emitEntry(session, {
      type: 'user',
      message: { role: 'user', content: prompt },
    })
    setState(session, 'busy')
    await sleep(400)
    emitEntry(session, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `收到。我来执行一条命令(第 ${turn} 回合)。` },
        ],
      },
    })
    await sleep(300)

    // 模拟一个需要权限的 Bash 工具
    const toolUseId = `toolu_mock_${turn}`
    emitEntry(session, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: {
              command: `echo "turn ${turn}: ${prompt}"`,
              description: '演示命令',
            },
          },
        ],
      },
    })

    const decision = await requestPermission(
      session,
      'Bash',
      { command: `echo "turn ${turn}: ${prompt}"`, description: '演示命令' },
      {
        toolUseID: toolUseId,
        title: `允许运行命令: echo "turn ${turn}…"?`,
        displayName: '运行命令',
        description: 'Claude 想在终端执行一条 Bash 命令',
      },
    )

    if (decision === 'allow') {
      emitEntry(session, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: `turn ${turn}: ${prompt}`,
            },
          ],
        },
      })
      await sleep(300)
      emitEntry(session, {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '命令已执行完成 ✅' }],
        },
      })
    } else {
      emitEntry(session, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: '用户拒绝了该工具调用',
              is_error: true,
            },
          ],
        },
      })
      await sleep(200)
      emitEntry(session, {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '好的,我不执行这条命令。' }],
        },
      })
    }
    setState(session, 'idle')
  }

  session.pushInput = (text: string) => {
    void runTurn(text)
  }
  session.interrupt = () => {
    // mock:把所有待决权限当作拒绝
    for (const [id] of session.pending)
      decidePermission(session, id, 'deny', 'interrupt')
    setState(session, 'idle')
  }

  void runTurn(firstPrompt)
  return session
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// =============================================================================
// 真 SDK 会话 —— 用 @anthropic-ai/claude-agent-sdk 的 query() + canUseTool
// (本机无法验证:需 Claude Code 登录态;在 Windows 机器上跑真实会话)
// =============================================================================

async function startRealSession(
  projectKey: string,
  cwd: string,
  firstPrompt: string,
): Promise<Session> {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    projectKey,
    sessionId,
    cwd,
    title: firstPrompt.slice(0, 40) || '新会话',
    state: 'idle',
    lines: [],
    lastUuid: null,
    pending: new Map(),
    recentlyResolved: new Map(),
    subscribers: new Set(),
    pushInput: () => {},
    interrupt: () => {},
  }
  sessions.set(sessionKey(projectKey, sessionId), session)

  const sdk = await import('@anthropic-ai/claude-agent-sdk')

  // 流式输入队列:把客户端输入喂给 SDK 的 AsyncIterable<SDKUserMessage>
  const inputQueue: string[] = [firstPrompt]
  let notify: (() => void) | null = null
  let closed = false
  async function* promptStream() {
    while (!closed) {
      while (inputQueue.length > 0) {
        const text = inputQueue.shift() as string
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: text },
          parent_tool_use_id: null,
        }
      }
      await new Promise<void>(r => {
        notify = r
      })
    }
  }
  session.pushInput = (text: string) => {
    inputQueue.push(text)
    notify?.()
  }

  const q = sdk.query({
    prompt: promptStream(),
    options: {
      cwd,
      // 默认权限模式:已被 allow 规则覆盖的自动通过，其余走 canUseTool。
      // --ask-all(开发/演示):额外不加载 settings 的 allow 规则，让每个工具都提示。
      permissionMode: 'default',
      ...(ARGS.askAll ? { settingSources: [] as never } : {}),
      // 结构化权限回调。
      // ⚠️ 实测发现:published SDK(@anthropic-ai/claude-agent-sdk 0.2.114)在本机
      //   spawn claude 子进程时，需要权限的工具(如写文件)既不执行也不回调这里,
      //   疑似 SDK 与 claude 二进制的权限控制协议版本不匹配。只读工具(cat 等)正常
      //   执行并返回。→ 真正可靠的 canUseTool 通道是本 repo 内部的 QueryEngine
      //   (src/services/acp/agent.ts 即用它 + toolPermissionContext)。详见 protocol.md。
      canUseTool: async (toolName, input, ctx) => {
        if (ARGS.verbose) console.log(`[perm] canUseTool 被调用: ${toolName}`)
        const decision = await requestPermission(session, toolName, input, {
          toolUseID: ctx.toolUseID,
          title: ctx.title,
          displayName: ctx.displayName,
          description: ctx.description,
        })
        return decision === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: '用户在客户端拒绝' }
      },
    },
  })

  session.interrupt = () => {
    for (const [id] of session.pending)
      decidePermission(session, id, 'deny', 'interrupt')
    void q.interrupt?.()
  }

  // 消费 SDK 消息流 → 映射为 JSONL 行下发
  ;(async () => {
    try {
      for await (const msg of q) {
        if (closed) break
        mapSdkMessage(session, msg)
      }
    } catch (err) {
      if (ARGS.verbose) console.error('[sdk] 会话出错', err)
    } finally {
      closed = true
      notify?.()
      setState(session, 'idle')
    }
  })()

  return session
}

// SDK 的 SDKMessage → 客户端能解析的 JSONL 行(type:user/assistant + message.content)
function mapSdkMessage(session: Session, msg: unknown): void {
  const m = msg as {
    type?: string
    message?: { role?: string; content?: unknown }
  }
  if (m.type === 'assistant' && m.message) {
    emitEntry(session, { type: 'assistant', message: m.message })
    setState(session, 'busy')
  } else if (m.type === 'user' && m.message) {
    emitEntry(session, { type: 'user', message: m.message })
  } else if (m.type === 'result') {
    setState(session, 'idle')
  }
  // system/stream_event 暂不下发
}

// =============================================================================
// HTTP 路由
// =============================================================================

function cors(headers: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8' }),
  })
}

function checkToken(url: URL): boolean {
  if (!ARGS.token) return true
  return url.searchParams.get('token') === ARGS.token
}

function sessionInfo(s: Session): RemoteSessionInfo {
  return {
    projectKey: s.projectKey,
    sessionId: s.sessionId,
    title: s.title,
    state: s.state,
    mtime: Math.floor(Date.now() / 1000),
    size: s.lines.length,
    cwd: s.cwd,
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors() })
  if (!checkToken(url)) return json({ error: 'unauthorized' }, 401)

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

  // GET /api/sessions
  if (
    req.method === 'GET' &&
    parts.length === 2 &&
    parts[0] === 'api' &&
    parts[1] === 'sessions'
  ) {
    return json([...sessions.values()].map(sessionInfo))
  }

  // POST /api/sessions  { cwd?, prompt }
  if (
    req.method === 'POST' &&
    parts.length === 2 &&
    parts[0] === 'api' &&
    parts[1] === 'sessions'
  ) {
    const body = (await safeJson(req)) as {
      cwd?: string
      prompt?: string
    } | null
    const prompt = body?.prompt?.trim()
    if (!prompt) return json({ ok: false, error: '缺少 prompt' }, 400)
    const cwd = body?.cwd || process.cwd()
    const projectKey = encodeProjectKey(cwd)
    const session = ARGS.mock
      ? startMockSession(projectKey, cwd, prompt)
      : await startRealSession(projectKey, cwd, prompt)
    return json({
      projectKey: session.projectKey,
      sessionId: session.sessionId,
    })
  }

  // /api/session/{projectKey}/{sessionId}/{action}
  if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'session') {
    const [, , projectKey, sessionId, action] = parts
    const session = sessions.get(sessionKey(projectKey, sessionId))
    if (!session) return json({ error: '会话不存在' }, 404)

    if (req.method === 'GET' && action === 'stream')
      return streamResponse(session)

    if (req.method === 'POST' && action === 'input') {
      const body = (await safeJson(req)) as {
        type?: string
        text?: string
      } | null
      if (body?.type === 'interrupt') {
        session.interrupt()
        return json({ ok: true })
      }
      const text = body?.text
      if (typeof text !== 'string' || !text.trim())
        return json({ ok: false, error: '缺少 text' }, 400)
      session.pushInput(text)
      return json({ ok: true })
    }

    if (req.method === 'POST' && action === 'interrupt') {
      session.interrupt()
      return json({ ok: true })
    }
  }

  // POST /api/session/{projectKey}/{sessionId}/permission/{permissionId}
  if (
    parts.length === 6 &&
    parts[0] === 'api' &&
    parts[1] === 'session' &&
    parts[4] === 'permission'
  ) {
    const [, , projectKey, sessionId, , permissionId] = parts
    const session = sessions.get(sessionKey(projectKey, sessionId))
    if (!session) return json({ error: '会话不存在' }, 404)
    const body = (await safeJson(req)) as PermissionDecision | null
    if (!body || (body.decision !== 'allow' && body.decision !== 'deny')) {
      return json({ ok: false, error: 'decision 非法' }, 400)
    }
    const result = decidePermission(
      session,
      permissionId,
      body.decision,
      body.clientId || '未知端',
    )
    return json(result)
  }

  return json({ error: 'not found' }, 404)
}

function streamResponse(session: Session): Response {
  let sub: Subscriber
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sub = { controller }
      session.subscribers.add(sub)
      // 1. 全量 snapshot
      if (session.lines.length === 0) {
        sseSend(sub, 'snapshot', { lines: [], offset: 0, done: true })
      } else {
        sseSend(sub, 'snapshot', {
          lines: session.lines,
          offset: 0,
          done: true,
        })
      }
      // 2. 当前状态
      sseSend(sub, 'state', { state: session.state })
      // 3. 补发所有待决权限(新连入/重连的端也能看到并抢答)
      for (const pending of session.pending.values()) {
        sseSend(sub, 'permission_request', { permission: pending.info })
      }
      // 心跳
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          clearInterval(hb)
        }
      }, 15000)
      ;(sub as Subscriber & { hb?: ReturnType<typeof setInterval> }).hb = hb
    },
    cancel() {
      session.subscribers.delete(sub)
      const hb = (sub as Subscriber & { hb?: ReturnType<typeof setInterval> })
        .hb
      if (hb) clearInterval(hb)
    },
  })
  return new Response(stream, {
    headers: cors({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    }),
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function encodeProjectKey(cwd: string): string {
  // 与 ~/.claude/projects 同风格:路径分隔符换成 '-'
  return cwd.replace(/[/\\:]/g, '-')
}

// =============================================================================
// 启动
// =============================================================================

if (!ARGS.token) {
  console.warn('警告:未设置 --token / RELAY_TOKEN，任何拿到 URL 的人都能访问')
}
if (ARGS.mock) {
  // 预置一个 mock 会话，方便直接验证
  startMockSession(
    encodeProjectKey('/demo/project'),
    '/demo/project',
    '演示会话',
  )
}

Bun.serve({
  port: ARGS.port,
  hostname: ARGS.host,
  idleTimeout: 0, // SSE 长连接
  fetch: handle,
})

console.log(
  `Bridge daemon listening on ${ARGS.host}:${ARGS.port}${ARGS.mock ? ' (mock)' : ''}`,
)
