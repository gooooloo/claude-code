# Transcript Relay 协议

手机 App 与远端机器（跑 Claude Code 的 Windows/macOS/Linux）之间的通信协议。
参考实现：`transcript_relay.py`（Python 3.8+ 标准库，单文件）。
TypeScript 类型定义：`../src/lib/protocol.ts`。

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
