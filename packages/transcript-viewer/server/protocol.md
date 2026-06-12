# 客户端 ↔ 远端服务端协议

手机/桌面客户端与远端机器之间的通信协议。两种服务端，客户端协议兼容：

| 服务端 | 文件 | 会话来源 | 输入 | 权限 |
|---|---|---|---|---|
| **relay** | `transcript_relay.py` | tail 已有 JSONL | 按键注入裸 TUI | 看不到（不写 JSONL） |
| **daemon（推荐）** | `bridge-daemon.ts` | Agent SDK 跑会话 | SDK 流式输入 | **canUseTool 结构化、多端先到先得** |

TypeScript 类型定义：`../src/lib/protocol.ts`。

> **为什么有 daemon**：relay 驱动裸 Windows Terminal TUI，权限框不写进 JSONL、客户端看不见，
> 且裸 TUI 的权限框无法让"本地 + 多端"对等作答（详见下文「权限并发」）。daemon 用 Agent SDK 的
> `canUseTool` 把权限做成结构化回调，由 daemon 持有、广播全端、第一个客户端决定原子胜出——
> 这正是 Happy / 官方 Remote Control 的做法。relay 仍适合"只读看历史 JSONL"。

---

# 一、Relay 协议（transcript_relay.py）

参考实现：`transcript_relay.py`（Python 3.8+ 标准库，单文件）。

## 设计原则

1. **Transcript 是唯一状态源** —— 服务端不维护会话状态机，所有状态从 JSONL 推导；解析、链重建、渲染全部在手机端完成，服务端只做「字节搬运 + 按键注入」。
2. **驱动真实 TUI 会话** —— 输入通过控制台按键注入（Windows：`AttachConsole` + `WriteConsoleInputW`，移植自 claude-code-webui），手机控制的就是 Windows Terminal 里你看得见的那个会话，不是平行的 headless 会话。
3. **语义动作而非按键** —— 手机端发送 `{type:"option",index:1}` 这类语义动作，按键翻译在服务端做。调整按键序列（如选项是否需要回车）只改服务端常量，不用重发 App。

## 部署

```powershell
# Windows 远端机器
python transcript_relay.py --token <密钥> --port 19850
devtunnel host -p 19850 --allow-anonymous
```

手机 App 添加连接：URL 填 devtunnel 给的 `https://xxx.devtunnels.ms`，Token 填同一密钥。

## 认证

所有请求带 `?token=<密钥>` query 参数（EventSource 无法自定义 header，统一走 query）。
不匹配返回 `401`。TLS 由 devtunnel 提供。

## 端点

### `GET /api/sessions`

扫描 `~/.claude/projects/*/*.jsonl`（mtime 倒序，最多 50 个）。

```json
[{
  "projectKey": "-Users-qidu-dev-claude-code",
  "sessionId": "64e72d0e-…",
  "title": "Optimize interface for mobile usability",
  "state": "idle",
  "mtime": 1781168947,
  "size": 2531658,
  "cwd": "/Users/qidu/dev/claude-code",
  "boundPid": 12345
}]
```

`state` 取值与推导规则（从 transcript 尾部 256KB 推导）：

| 状态 | 含义 | 规则 |
|---|---|---|
| `idle` | 等待输入 | 最后的 tool_use 都有 tool_result，或无 tool_use |
| `busy` | 正在工作 | 有未配对的 tool_use，或最后一条是普通用户消息（思考中） |
| `elicitation` | AskUserQuestion 等待回答 | 未配对的 tool_use 中有 `AskUserQuestion` |
| `plan_review` | 计划等待审批 | 未配对的 tool_use 中有 `ExitPlanMode` |

### `GET /api/session/{projectKey}/{sessionId}/stream`（SSE）

事件序列：

```
event: snapshot   data: {"lines": ["...原始JSONL行..."], "offset": 0, "done": false}
event: snapshot   data: {"lines": [...], "offset": 2531658, "done": true}   ← 分块，500 行/块
event: state      data: {"state": "idle"}
event: append     data: {"lines": [...], "offset": 2532001}                 ← 文件增长时（0.5s 轮询）
event: state      data: {"state": "busy"}                                   ← 状态变化时
: ping                                                                       ← 15s 心跳
```

- 客户端断线后 EventSource 自动重连，服务端总是重发完整 snapshot（第一块 `offset:0` 即客户端重置信号）。
- 半行安全：服务端只推完整行，跨块半行留在缓冲区。

### `POST /api/session/{projectKey}/{sessionId}/input`

```json
{"type": "prompt",      "text": "继续"}        // 注入文本 + Enter
{"type": "text_answer", "text": "用方案 B"}    // AskUserQuestion 自由回答（同 prompt）
{"type": "option",      "index": 1}            // AskUserQuestion 选项 → 注入数字键 "2"
{"type": "interrupt"}                          // 注入 Ctrl-C (\x03)
```

响应 `{"ok": true}` 或 `{"ok": false, "error": "..."}`。

前置条件：会话已绑定终端进程 PID（见下）。选项注入默认不带回车，
如你的 Claude Code 版本选项需要回车确认，改 `OPTION_NEEDS_ENTER = True`。

### `GET /api/processes` + `POST /api/session/{k}/{id}/bind`

无 hook 的 PID 发现：`/api/processes` 列出疑似 Claude 进程（`tasklist /v` 过滤
claude/node/bun + 窗口标题），App 里人工选择后 `POST bind {"pid": 12345}`。
绑定持久化在服务端 `~/.transcript_relay_bindings.json`。

> 自动绑定（按 cwd 匹配进程）和 SessionStart hook 注册都是可选增强，v1 用人工绑定保持零侵入。

## Permission 请求的处理（v2 设计，未实现）

权限对话框不写入 transcript，纯靠 JSONL 看不到。两个候选方案：

| 方案 | 原理 | 优点 | 缺点 |
|---|---|---|---|
| **A. 控制台缓冲区读取**（推荐） | 注入侧已有 `AttachConsole`，再加 `ReadConsoleOutputCharacterW` 读屏：检测权限对话框文本与选项，作为 `state: permission_prompt` + 选项列表推给手机，回答走数字键注入 | 零侵入（无 hook、无配置）、连对话框文案都能透传 | Windows-only；读屏解析需要适配 TUI 文案变化 |
| **B. PermissionRequest hook 重设计** | hook 把请求 POST 给 relay（带超时回退），relay 推给手机，响应写回 | 跨平台、结构化数据 | 要装 hook；claude-code-webui 已验证此路线（其实现被认为不够好，需重写：去文件队列、直连 relay、严格超时） |

App 端协议已预留：`RemoteSessionState` 可扩展 `permission_prompt`，输入动作可扩展 `{type:"permission", optionId}`。

## 已知限制

- 多 question 的 AskUserQuestion（一次最多 4 问）：TUI 内是 Tab 切换，目前逐问注入数字键的行为未在真机验证，自由文本回答总是可用的兜底。
- `option` 注入的数字键选择假设 TUI 支持数字快捷键；不支持时改用方向键序列（服务端改 `inject_keys` 的翻译即可）。
- SSE 经 devtunnel 的空闲超时未知，心跳 15s 应足够保活，必要时调小。

> 上面的 A/B 是「坚持裸 TUI」时的退路。**推荐改用下面的 daemon**，从根上解决可见性与并发。

---

# 二、Daemon 协议（bridge-daemon.ts，推荐）

参考实现：`bridge-daemon.ts`（Bun/TypeScript），**经 `run-daemon.ts` 启动**（它注入
QueryEngine 需要的 MACRO defines + feature flags；直接 `bun run bridge-daemon.ts` 会
`MACRO is not defined`）。在 repo 根目录、每台远端机器跑一份：

```powershell
# 在仓库内运行(需要 src/，因为用内部 QueryEngine)
bun run packages/transcript-viewer/server/run-daemon.ts --token <密钥> --port 19860
devtunnel host -p 19860 --allow-anonymous
# 本机验证(不跑真会话、不耗 API)：加 --mock
```

需要远端机器已登录 Claude Code（QueryEngine 复用其登录态/配置）。客户端「添加机器」填 devtunnel
域名 + 密钥，用法与 relay 一致——daemon 复用 relay 的 `GET /api/sessions`、`/stream`
(snapshot/append/state)、`POST /input`，会话消息同样以 JSONL 行下发，客户端的链重建/渲染不变。
差异只在多了**权限通道**。

> **daemon 没有终端窗口，不接管已有会话。** `GET /api/sessions` 只返回 daemon **自己创建**的会话；
> 会话必须由客户端 `POST /api/sessions` 新建。你在终端里另开的 `claude` 对 daemon 不可见——
> 那是 relay（tail 终端 JSONL）的职责。想接管终端会话用 relay；想从客户端全程起新会话用 daemon。

## 设计原则

1. **daemon 拥有会话** —— 用内部 QueryEngine 跑 Claude Code，自己创建并持有，不是 tail 外部进程。
2. **权限是回调返回值，不是按键** —— `canUseTool` 触发时，daemon 不在本地决定，而是登记一个待决请求、
   广播给所有连接的客户端、`await` 第一个决定，再把它作为回调返回值交还 SDK。**因为是单一返回值，
   不可能"双重生效"或漏进下一个框**（这正是按键注入做不到的）。
3. **先到先得、原子、全端同步** —— 任意客户端（含本地 localhost 客户端）皆对等；第一个 POST 决定者
   通过 compare-and-set 胜出，其余端收到 `permission_resolved` 即置灰显示"已由 X 处理"。

## 新增端点 / 事件（在 relay 协议之上）

### 会话状态新增 `permission`

`state` 事件可取 `permission`（工具权限等待批准）。客户端把它和 `elicitation`/`plan_review` 一样
计入「等你处理」待办。

### SSE 新事件（在 `/stream` 上）

```
event: permission_request
data: { "permission": { "id", "toolName", "title?", "displayName?", "description?",
                        "input?", "toolUseID", "createdAt" } }

event: permission_resolved
data: { "id", "behavior": "allow"|"deny", "by": "<胜者客户端标识>" }
```

- 客户端**连接/重连时**，daemon 会把当前所有待决权限补发 `permission_request`，
  保证新加入或刚 RDP 进来的端也能看到并抢答。
- `permission_request` 按 `id` 去重（重连补发不重复）。

### `POST /api/session/{projectKey}/{sessionId}/permission/{permissionId}`

```json
{ "decision": "allow"|"deny", "clientId": "<客户端标识，用于回显由谁处理>" }
```

返回：

```json
{ "ok": true }                              // 抢答成功
{ "ok": false, "alreadyResolvedBy": "iPad-3f2a" }  // 已被别人抢先（非错误，UI 据 resolved 事件置灰）
```

仲裁是 daemon 单点、JS 单线程的 check-then-set，天然原子。胜者记入短期 `recentlyResolved`，
让晚到的抢答 POST 也能回显正确的胜者。

### `POST /api/sessions`（daemon 特有，从客户端起新会话）

```json
{ "prompt": "任务描述", "cwd": "可选工作目录" }   →   { "projectKey", "sessionId" }
```

## 权限并发 —— 为什么这样就对了

场景：你管十几台机器，有时 RDP 进某台、有时在 iPhone/iPad/Windows 任意端，**事先不知道在哪个端先答**。

| 不变量 | daemon 如何保证 |
|---|---|
| 答案只生效一次 | 权限是 `canUseTool` 的单一返回值；daemon 持有 resolver，只 resolve 一次 |
| 任意端可答、对等 | 待决请求广播所有 SSE 订阅者；本地也是一个 localhost 客户端 |
| 先到先得、原子 | 单点 check-then-set；第二个决定返回 `alreadyResolvedBy` |
| 全端实时同步 | `permission_resolved` 广播，其余端即时置灰"已由 X 处理"，会话照常推进 |

「裸 TUI 的原生权限框」无法成为并发响应者——这是 TUI 的硬限制，不是本设计的取舍。
daemon 把权限移出 TUI、变成结构化回调，才换来真正对等的多端作答。

## 真实会话验证状态（在 Mac 上实测）

daemon 用**本 repo 内部的 `QueryEngine`** 跑真实会话（不是 published SDK 子进程——后者实测不回调
`canUseTool`）。`QueryEngine` 依赖 MACRO 编译期常量 + feature flags，故 daemon 必须经
`run-daemon.ts` 启动（它注入 `-d MACRO.*` + `--feature`，同 `scripts/dev.ts`）。

| 能力 | 状态 |
|---|---|
| 跨平台（Mac/Linux/Windows，daemon 无平台专用代码） | ✅ 在 Mac 上实测 |
| 流式输入 + 多轮（客户端 prompt → 串行 turn 泵） | ✅ 真实会话跑通 |
| QueryEngine 消息 → JSONL 行 → 客户端渲染 | ✅ 真实会话跑通 |
| **`canUseTool` 结构化权限触发** | ✅ **真实会话跑通**（写命令触发回调） |
| 权限仲裁(先到先得) → 批准 → 工具真执行 → 回合继续 | ✅ 真实会话跑通（文件真创建） |
| 连续多个工具权限（逐个 canUseTool） | ✅ 真实会话跑通 |
| **AskUserQuestion**（答案经 updatedInput.answers 回传） | ✅ **真实会话跑通**（答"面条"→Claude 据此回复） |
| **ExitPlanMode**（allow=批准 / deny=继续规划） | ✅ `--mock` UI 跑通（与 question 同一 canUseTool 路径） |
| 多端先到先得 + 客户端 UI 置灰同步 | ✅ `--mock` 端到端（双标签页 + curl） |

### 三类待决统一走 canUseTool

| kind | 触发工具 | 客户端卡片 | 回应 | daemon 返回给引擎 |
|---|---|---|---|---|
| `permission` | 普通工具 | 允许 / 拒绝 | allow/deny | `{behavior, updatedInput}` |
| `question` | AskUserQuestion | 选项按钮 + 提交 | `answers:{问题:label}` | `{behavior:'allow', updatedInput:{...,answers}}` |
| `plan` | ExitPlanMode | 计划文本 + 批准/继续 | allow/deny | allow:`{behavior:'allow'}`+切default模式 / deny:`{behavior:'deny'}` |

`permission_request` 事件的 `kind` 字段区分三类；`question` 携带 `questions`，`plan` 携带 `plan`。
决定端点 `POST .../permission/{id}` 的 body 对 `question` 额外带 `answers`。
客户端去重：daemon 路径下 AskUserQuestion 同时是 JSONL 里的 tool_use，按 `toolUseID` 去掉
重复的 JSONL 问题卡，只保留权限通道的那张。

> published SDK（`@anthropic-ai/claude-agent-sdk@0.2.114`）路径已弃用：实测它 spawn `claude`
> 子进程时需权限的工具既不执行也不回调 `canUseTool`（只读工具正常），疑似版本握手问题。
> 内部 QueryEngine 路径无此问题。

## AskUserQuestion 细节

- **多问题**：一次 AskUserQuestion 可含多问，客户端逐问作答，全部答完才能提交。
- **多选**（`multiSelect: true`）：选项可多选，答案按逗号拼（如 `Docker, K8s`）——符合工具
  对 answers 的约定（多选逗号分隔）。
- **自由文本「其他」**：每问附一个自由输入框（AskUserQuestion 总是允许 Other）。单选时
  输入自由文本会与选项互斥；多选时自由文本作为附加项一并提交。
- 答案以 `answers:{问题文本: 选中label}` 经决定端点回传 → daemon 用 `updatedInput.answers`
  交还引擎 → 工具结果即这些答案。实测：真实会话单问 + mock 多选/双问均跑通。

## 权限范围

daemon **默认尊重用户的 allow/deny 规则**（`loadAllPermissionRulesFromDisk` + 标准权限
pipeline `hasPermissionsToUseTool`）：已被规则放行的工具不再提示，命中 deny 的直接拒，其余
（`ask`）才推到客户端。内置只读放行（如只读 Bash）在引擎层先生效，根本不到 canUseTool。

- 规则读取以 **daemon 启动目录**为基准：全局 `~/.claude/settings.json` 规则总是生效；
  project/local 规则取决于 daemon 从哪个目录启动（每机一个 daemon 时通常即项目根）。
- `--ask-all`：忽略所有 allow 规则，非只读工具一律提示（最保守，适合"什么都要在手机上过一遍"）。
- AskUserQuestion / ExitPlanMode 本质是交互，**不走** allow 规则旁路，始终推到客户端。

## 已知边界

- daemon 跑的会话不是你直接敲的裸 TUI；RDP 进机器时，在该机 localhost 开个客户端作答（与手机对称）。
- 多会话并发跑 turn 时共享部分全局会话状态（transcript 持久化）；当前按"一次一个 turn"使用，
  高并发同跑多 turn 是边界情况。
- AskUserQuestion / ExitPlanMode 也经同一 `canUseTool` 通道（ExitPlanMode 在 ACP 里有专门处理）。
