# 企业版为什么必须用 daemon（不能用官方 Remote Control）

> 结论先行：**enterprise 账号 + 组织禁用了 remote control 的情况下，官方 bridge 的三条入口
> （`claude rc` / `claude bridge` / REPL 内把 TUI 会话转移到手机）全部会被挡死，连自建服务器 +
> 环境变量也救不回来。daemon（`bridge-daemon.ts`）是唯一可行路径，因为它根本不走 bridge 那套机制。**

这份文档记录了得出该结论的代码依据，省得日后又有人去试 `claude rc` 然后撞墙。

---

## 官方 bridge 有两道独立的闸

启动官方 Remote Control 时要连过两道闸，它们卡在不同层、判定来源也不同：

### 第一道：claude.ai 订阅闸（self-hosted 可绕）

`src/bridge/bridgeEnabled.ts`：

```ts
export function isBridgeEnabled(): boolean {
  // 自建服务器 → 直接放行，跳过订阅检查
  if (feature('BRIDGE_MODE') && isSelfHostedBridge()) {
    return true
  }
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() && getFeatureValue('tengu_ccr_bridge', false)
    : false
}
```

- `isClaudeAISubscriber()`（同文件 19–24 行注释）**明确排除** Bedrock / Vertex / Foundry /
  Console API 登录 / 环境变量 API key —— enterprise 正属此类，返回 `false`。
- 但 `isSelfHostedBridge()`（`src/bridge/bridgeConfig.ts:44`，本质就是
  `!!process.env.CLAUDE_BRIDGE_BASE_URL`）一旦为真，第一道闸直接 `return true`。
- 这道闸为什么能这么轻易绕过？因为它**存在的唯一理由**是：官方 bridge 要拿 claude.ai 的
  OAuth token 去连 Anthropic 的 CCR。你一旦自建服务器就**根本不连 CCR**，订阅检查自然失去意义。
  注意：`CLAUDE_BRIDGE_BASE_URL` 同时也把连接**重定向到你自己的服务器**——不是"白嫖官方云"，
  而是"我不连官方云所以那道闸对我不适用"。

### 第二道：组织 policy 闸（self-hosted 绕不过）

订阅闸过了之后，紧接着还有一道**完全独立**的组织 policy 检查，三个官方入口都有：

| 入口 | 文件:行 | 命令 |
|---|---|---|
| `claude rc` | `src/entrypoints/cli.tsx:220` | `claude rc` |
| `claude bridge` | `src/commands/bridge/bridge.tsx:235` | `claude bridge` |
| **REPL 内转移 TUI 会话到手机** | `src/bridge/initReplBridge.ts:157` | REPL 里触发 |

以 `claude rc` 为例（`cli.tsx:208–222`）：

```ts
const disabledReason = await getBridgeDisabledReason();   // 第一道：订阅闸
if (disabledReason) exitWithError(...);                    // ← isSelfHostedBridge() 能绕过

// Bridge is a remote control feature - check policy limits
if (!isPolicyAllowed('allow_remote_control')) {            // 第二道：组织 policy 闸
  exitWithError("Remote Control is disabled by your organization's policy.");  // ← 绕不过
}
```

`isPolicyAllowed`（`src/services/policyLimits/index.ts:510`）读的是**你们组织下发的 policy
缓存**，跟自建服务器、跟 `CLAUDE_BRIDGE_BASE_URL` 毫无关系：

```ts
export function isPolicyAllowed(policy: string): boolean {
  const restrictions = getRestrictionsFromCache()
  if (!restrictions) return true          // 无 policy → fail open
  const restriction = restrictions[policy]
  if (!restriction) return true           // 未知 policy → 放行
  return restriction.allowed              // 组织显式禁用 → false
}
```

它默认 fail-open（拿不到 policy 就放行）——**但当组织显式把 `allow_remote_control` 设成
`false` 时，它返回 `false`，于是上面三条入口全部以
`"disabled by your organization's policy"` 退出。**

---

## 所以 enterprise + 组织禁用 RC 的实际处境

| 想走的路 | 结果 |
|---|---|
| 裸 `claude rc` | ❌ 第一道订阅闸就挡（非 claude.ai 订阅） |
| `claude rc` + `CLAUDE_BRIDGE_BASE_URL`（自建） | ❌ 第一道过了，**第二道组织 policy 闸挡死** |
| REPL 内把 TUI 会话转移到手机 | ❌ 同样走 `isPolicyAllowed('allow_remote_control')`，挡死 |
| **daemon（`bridge-daemon.ts`）** | ✅ **不走 bridge 机制，不调用上述任何一道闸** |

daemon 直接用内部 `QueryEngine` 跑会话（见 `protocol.md` 第二节），它既不调用
`isBridgeEnabled`，也不调用 `isPolicyAllowed('allow_remote_control')`。它不是"Remote Control"
那个被禁的官方 feature，而是一个自建的本地工具，数据全程留在你自己的机器/基础设施内、
不经过 Anthropic 的中继。

---

## ⚠️ 合规提醒（先看这条再部署）

你们组织是**有意**禁用 remote control 的（policy 代码里能看到 HIPAA 之类合规背景）。daemon 在
技术上不碰那道闸，但它提供的恰恰是"远程驱动开发机上的 Claude Code"——很可能正是那条 policy 想
禁止的能力。

部署前请先与你们 IT / 安全团队确认：**一个数据完全留在你们自己基础设施内、不经过 Anthropic
中继的自建本地工具，是否在政策允许范围内。**

- 若允许（很多组织禁的是"数据流经第三方云中继"，自托管反而合规）→ 按下方步骤部署。
- 若不允许（连远程访问开发机本身都禁止）→ 不应使用本工具。

---

## 远端机器测试 daemon 的步骤

前置：远端机器已登录 Claude Code（daemon 复用其登录态，**不需要**任何 bridge/订阅相关配置），
且 daemon 启动目录是已信任的项目（trust dialog 已接受）。

```powershell
# 1) 仓库内启动 daemon（必须经 run-daemon.ts，它注入 QueryEngine 需要的 MACRO + feature flags）
bun run packages/transcript-viewer/server/run-daemon.ts --token <密钥> --port 19860

# 2) 暴露端口
devtunnel host -p 19860 --allow-anonymous

# 3) 客户端「添加机器」填 devtunnel 域名 + 密钥
```

冒烟测试顺序（不耗 API 的先跑）：

1. `--mock` 起一份：`bun run packages/transcript-viewer/server/run-daemon.ts --token t --port 19860 --mock`
   —— 验证 SSE、权限卡片、多端先到先得 UI，不跑真会话。
2. 去掉 `--mock`，从客户端「新建会话」发一个 prompt → 看 JSONL 是否实时下发、渲染正常。
3. 发一个会触发写操作的 prompt（如"创建一个临时文件"）→ 验证 `canUseTool` 弹出权限卡片，
   批准后工具真执行、回合继续。
4. 触发 AskUserQuestion → 验证选项/多选/自由文本作答经 `updatedInput.answers` 回传。
5. `--ask-all` 起一份 → 验证非只读工具一律提示（"什么都在手机上过一遍"）。

> 验证状态与协议细节见 `protocol.md`。daemon 无平台专用代码，Mac 已实测；Windows 上若 `bun`
> 路径或 trust 状态有问题，先在该机本地 `localhost` 开客户端排查，再走 devtunnel。
