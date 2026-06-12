#!/usr/bin/env bun
/**
 * Bridge Daemon —— 路线 1 的服务端:用内部 QueryEngine 跑 Claude Code 会话,
 * 通过 canUseTool 把「权限 / AskUserQuestion / ExitPlanMode」都做成结构化回调,
 * 由 daemon 持有、广播全端、第一个客户端的决定原子胜出(解决"本地+多端"并发)。
 *
 *  - 普通权限：allow / deny
 *  - AskUserQuestion(kind=question)：答案经 updatedInput.answers 回传
 *  - ExitPlanMode(kind=plan)：allow=批准计划 / deny=继续规划
 *
 * 对比 transcript_relay.py(tail JSONL + 按键注入):daemon 直接拥有会话,
 * 回应是回调返回值而非按键,天然对称、可被任意端回应、先到先得。
 *
 * !! 必须经 run-daemon.ts 启动(注入 MACRO defines + feature flags),
 *    直接 `bun run bridge-daemon.ts` 会因 QueryEngine 依赖而 `MACRO is not defined`。
 *
 * 部署(每台远端机器一份，在 repo 根目录、各自经 devtunnel 暴露):
 *     bun run packages/transcript-viewer/server/run-daemon.ts --token <密钥> --port 19860
 *     devtunnel host -p 19860 --allow-anonymous
 * 本机验证(不跑真会话 / 不耗 API):加 --mock
 *
 * 协议见 server/protocol.md。会话消息以 JSONL 行经 SSE 下发(客户端复用既有渲染);
 * 权限/问题/计划走 permission_request / permission_resolved 事件。
 */

import type {
  PermissionDecision,
  PermissionQuestion,
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
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 19860,
    host: '127.0.0.1',
    token: process.env.RELAY_TOKEN ?? '',
    mock: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--token') args.token = argv[++i]
    else if (a === '--mock') args.mock = true
    else if (a === '--verbose') args.verbose = true
  }
  return args
}

const ARGS = parseArgs(Bun.argv.slice(2))

// =============================================================================
// 会话模型
// =============================================================================

interface PermissionOutcome {
  decision: 'allow' | 'deny'
  answers?: Record<string, string> // kind==='question' 时携带
}

interface PendingPermission {
  info: PermissionRequestInfo
  resolve: (outcome: PermissionOutcome) => void
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

type RequestMeta = Partial<
  Pick<
    PermissionRequestInfo,
    'kind' | 'title' | 'displayName' | 'description' | 'questions' | 'plan'
  >
>

function requestPermission(
  session: Session,
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  meta: RequestMeta = {},
): Promise<PermissionOutcome> {
  const kind = meta.kind ?? 'permission'
  const info: PermissionRequestInfo = {
    id: crypto.randomUUID(),
    kind,
    toolName,
    title: meta.title,
    displayName: meta.displayName,
    description: meta.description,
    input,
    toolUseID,
    createdAt: Date.now(),
    questions: meta.questions,
    plan: meta.plan,
  }
  return new Promise<PermissionOutcome>(resolve => {
    session.pending.set(info.id, { info, resolve })
    // question/plan 用更贴切的待办状态
    setState(
      session,
      kind === 'question'
        ? 'elicitation'
        : kind === 'plan'
          ? 'plan_review'
          : 'permission',
    )
    broadcast(session, 'permission_request', { permission: info })
    if (ARGS.verbose)
      console.log(`[perm] 待决 ${kind} ${toolName} id=${info.id}`)
  })
}

// 返回 true=本次抢答成功；false=已被别人抢先
function decidePermission(
  session: Session,
  permissionId: string,
  decision: 'allow' | 'deny',
  by: string,
  answers?: Record<string, string>,
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
  pending.resolve({ decision, answers })
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
  // 还有别的待决就保持等待态，否则回 busy(引擎会继续)
  setState(session, session.pending.size > 0 ? session.state : 'busy')
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

    // prompt 含"问"→ 演示 AskUserQuestion；含"计划"→ 演示 ExitPlanMode
    if (prompt.includes('问')) {
      await mockAskQuestion(session, turn)
      setState(session, 'idle')
      return
    }
    if (prompt.includes('计划')) {
      await mockPlan(session, turn)
      setState(session, 'idle')
      return
    }
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

    const outcome = await requestPermission(
      session,
      'Bash',
      { command: `echo "turn ${turn}: ${prompt}"`, description: '演示命令' },
      toolUseId,
      {
        title: `允许运行命令: echo "turn ${turn}…"?`,
        displayName: '运行命令',
        description: 'Claude 想在终端执行一条 Bash 命令',
      },
    )

    if (outcome.decision === 'allow') {
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

// mock：AskUserQuestion 一轮
async function mockAskQuestion(session: Session, turn: number): Promise<void> {
  const toolUseId = `toolu_ask_${turn}`
  const question = '你想用哪种部署方式?'
  const input = {
    questions: [
      {
        question,
        header: '部署',
        options: [
          { label: 'Docker', description: '容器化' },
          { label: '裸机', description: '直接跑在主机上' },
        ],
      },
    ],
  }
  emitEntry(session, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input },
      ],
    },
  })
  const outcome = await requestPermission(
    session,
    'AskUserQuestion',
    input,
    toolUseId,
    {
      kind: 'question',
      title: '请回答',
      questions: input.questions.map(q => ({ ...q, multiSelect: false })),
    },
  )
  const answers = outcome.answers ?? {}
  emitEntry(session, {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `User has answered your questions: ${JSON.stringify(answers)}`,
        },
      ],
    },
  })
  await sleep(200)
  emitEntry(session, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `好的，按「${answers[question] ?? '(未答)'}」继续。`,
        },
      ],
    },
  })
}

// mock：ExitPlanMode 一轮
async function mockPlan(session: Session, turn: number): Promise<void> {
  const toolUseId = `toolu_plan_${turn}`
  const plan = '1. 建表\n2. 写接口\n3. 加测试'
  emitEntry(session, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'ExitPlanMode',
          input: { plan },
        },
      ],
    },
  })
  const outcome = await requestPermission(
    session,
    'ExitPlanMode',
    { plan },
    toolUseId,
    {
      kind: 'plan',
      title: '批准这个计划?',
      plan,
    },
  )
  emitEntry(session, {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content:
            outcome.decision === 'allow'
              ? '计划已批准，开始执行'
              : '用户希望继续完善计划',
          is_error: outcome.decision !== 'allow',
        },
      ],
    },
  })
  await sleep(200)
  emitEntry(session, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            outcome.decision === 'allow'
              ? '计划已批准，开始执行 ✅'
              : '好的，我继续完善计划。',
        },
      ],
    },
  })
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

  // 内部 QueryEngine —— canUseTool 在此路径真正触发(实测:published SDK 子进程
  // 不回调权限，QueryEngine 回调)。需 MACRO defines + feature flags，
  // 故 daemon 必须经 run-daemon.ts 启动。
  const { QueryEngine } = await import('../../../src/QueryEngine.ts')
  const { getTools } = await import('../../../src/tools.ts')
  const { getEmptyToolPermissionContext } = await import('../../../src/Tool.ts')
  const { getDefaultAppState } = await import(
    '../../../src/state/AppStateStore.ts'
  )
  const { FileStateCache } = await import(
    '../../../src/utils/fileStateCache.ts'
  )

  const permissionContext = getEmptyToolPermissionContext()
  const tools = getTools(permissionContext)
  // 空 permission context(不加载用户 allow 规则)→ 需权限的工具都走 canUseTool;
  // 默认模式下内置只读放行仍生效(如只读 Bash)，这是期望行为。
  // (偏保守:远程控制场景宁可多问，不漏放行。)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: { ...permissionContext, mode: 'default' as const },
  }

  const denyResult = (message: string) => ({
    behavior: 'deny' as const,
    message,
    decisionReason: { type: 'mode' as const, mode: 'default' as const },
  })

  // 结构化权限回调:三类(question / plan / permission)都登记 pending、广播全端、
  // 等第一个客户端，返回值交还引擎。
  const canUseTool = async (
    tool: { name: string },
    input: Record<string, unknown>,
    _ctx: unknown,
    _asst: unknown,
    toolUseID: string,
  ) => {
    if (ARGS.verbose) console.log(`[perm] canUseTool: ${tool.name}`)

    // AskUserQuestion：答案经 updatedInput.answers 回传，不是 allow/deny
    if (tool.name === 'AskUserQuestion') {
      const questions = parseQuestions(input)
      const outcome = await requestPermission(
        session,
        tool.name,
        input,
        toolUseID,
        {
          kind: 'question',
          title: '请回答',
          questions,
        },
      )
      if (outcome.decision !== 'allow') return denyResult('用户取消了回答')
      return {
        behavior: 'allow' as const,
        updatedInput: { ...input, answers: outcome.answers ?? {} },
      }
    }

    // ExitPlanMode：allow=批准计划(切到 default 模式继续执行) / deny=继续规划
    if (tool.name === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? input.plan : ''
      const outcome = await requestPermission(
        session,
        tool.name,
        input,
        toolUseID,
        {
          kind: 'plan',
          title: '批准这个计划?',
          plan,
        },
      )
      if (outcome.decision !== 'allow')
        return denyResult('用户希望继续完善计划')
      appState.toolPermissionContext.mode = 'default'
      return { behavior: 'allow' as const, updatedInput: input }
    }

    // 普通工具权限：allow / deny
    const outcome = await requestPermission(
      session,
      tool.name,
      input,
      toolUseID,
      {
        title: permissionTitle(tool.name, input),
        description: 'Claude 想使用工具',
      },
    )
    return outcome.decision === 'allow'
      ? { behavior: 'allow' as const, updatedInput: input }
      : denyResult('用户在客户端拒绝')
  }

  // 跨内部模块的结构化类型用 as any 桥接(daemon 不在 tsconfig，运行时已验证)
  const engine = new QueryEngine({
    cwd,
    tools,
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: canUseTool as any,
    getAppState: () => appState,
    setAppState: (f: (prev: typeof appState) => typeof appState) => {
      Object.assign(appState, f(appState))
    },
    readFileCache: new FileStateCache(500, 50 * 1024 * 1024),
  } as any)

  // 串行回合泵:每条输入起一个新 turn，串行执行(不并发跑两个 turn)
  const turnQueue: string[] = [firstPrompt]
  let running = false
  const pump = async () => {
    if (running) return
    running = true
    while (turnQueue.length > 0) {
      const prompt = turnQueue.shift() as string
      setState(session, 'busy')
      try {
        engine.resetAbortController?.()
        for await (const msg of engine.submitMessage(prompt)) {
          mapSdkMessage(session, msg)
        }
      } catch (err) {
        if (ARGS.verbose) console.error('[qe] turn 出错', err)
      }
    }
    running = false
    setState(session, 'idle')
  }

  session.pushInput = (text: string) => {
    turnQueue.push(text)
    void pump()
  }
  session.interrupt = () => {
    for (const [id] of session.pending)
      decidePermission(session, id, 'deny', 'interrupt')
    engine.interrupt?.()
  }

  void pump()
  return session
}

/** 给权限卡片一个可读标题 */
function permissionTitle(
  toolName: string,
  input: Record<string, unknown>,
): string {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) {
      return `允许 ${toolName}: ${v.trim().slice(0, 80)}?`
    }
  }
  return `允许使用 ${toolName}?`
}

// 从 AskUserQuestion 的 input.questions 解析出结构化问题（带选项）
function parseQuestions(input: Record<string, unknown>): PermissionQuestion[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  const result: PermissionQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const rec = q as Record<string, unknown>
    if (typeof rec.question !== 'string') continue
    const options: PermissionQuestion['options'] = []
    if (Array.isArray(rec.options)) {
      for (const opt of rec.options) {
        if (opt && typeof opt === 'object') {
          const o = opt as Record<string, unknown>
          if (typeof o.label === 'string') {
            options.push({
              label: o.label,
              description:
                typeof o.description === 'string' ? o.description : undefined,
            })
          }
        }
      }
    }
    result.push({
      question: rec.question,
      header: typeof rec.header === 'string' ? rec.header : undefined,
      multiSelect: rec.multiSelect === true,
      options,
    })
  }
  return result
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
      body.answers,
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
} else {
  // 真实模式:解锁配置访问(QueryEngine 依赖)。mock 模式不需要。
  const { enableConfigs } = await import('../../../src/utils/config.ts')
  enableConfigs()
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
