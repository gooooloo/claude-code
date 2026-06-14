# Fleet 快速上手 —— 用自托管 RCS + bridge 从手机/PC 控制一批机器

一份**经实测验证**的最短上手路径：在一台机器上跑 Remote Control Server (RCS)，让你那批机器
（"fleet"，即你要统一管理的一组远端机器）各自 `claude rc` 连上去，然后从手机 / iPad / 任意浏览器
打开 RCS 的 Web UI，实时查看会话、发指令、**结构化审批工具权限**、回答 AskUserQuestion、审批计划。

> 这是官方 Remote Control 的自托管等价物，详尽参数见 `remote-control-self-hosting.md`、
> `bridge-mode.md`。本文只给"跑起来"的最短步骤。

## 它能做什么（实测）

- 从手机端**新建并控制**远端机器上的真实 Claude Code 会话。
- 工具要权限时，Web UI 弹出**结构化** Permission Request（完整命令 + 入参 + Approve/Reject），
  批准后命令真执行——不是截图、不是注入按键。
- 一个 RCS 汇聚整批机器，Dashboard 上每台是一个 environment。
- 一份 token 三端（iOS / iPad / PC 浏览器）通用。

## 架构（为什么只需要一个 devtunnel）

```
                       ┌──────────────────────────┐
   手机/iPad/PC  ──────►│  RCS（一台常开机器上）     │
   浏览器打开 Web UI    │  devtunnel 暴露这一个端口   │
                       └──────────▲───────────────┘
                                  │ 各机器「主动连出去」(出站 HTTPS/WS)
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
   ┌────┴────┐               ┌────┴────┐               ┌────┴────┐
   │ 机器 A   │               │ 机器 B   │               │ 机器 C   │  …十几台
   │ claude rc│               │ claude rc│               │ claude rc│
   └─────────┘               └─────────┘               └─────────┘
```

关键：**只有 RCS 这一个点需要 devtunnel**。fleet 里的每台机器都是**主动连出去**到 RCS，
**不开任何入站端口**（官方那套"只出站、无入站"的安全模型）。比"每台机器各开一个 devtunnel"
更简单也更安全。

## 前置

- 每台机器：能跑这个仓库（`bun install` 过）、且**已登录 Claude Code**（bridge 复用其登录态）。
- 一个 [devtunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/)（或任意能把 RCS 端口
  暴露到公网的反代/隧道）。
- 想好一个**强密钥**当 token（下面 `<KEY>`），客户端和服务端必须一致。

---

## 第 1 步：在一台常开机器上跑 RCS

```bash
# 1) 首次需要构建 Web UI（产物在 web/dist，RCS 直接 serve）
cd packages/remote-control-server/web && bunx vite build && cd -

# 2) 启动 RCS。RCS_BASE_URL 必须 == 客户端实际访问到的地址（即 devtunnel 给的 https 域名）
RCS_API_KEYS=<KEY> \
RCS_BASE_URL=https://<你的-devtunnel-域名> \
RCS_PORT=3000 \
bun run rcs

# 3) 另一个终端：把 3000 端口用 devtunnel 暴露
devtunnel host -p 3000 --allow-anonymous
```

> Docker 部署见 `remote-control-self-hosting.md`（含 `Dockerfile` / `docker compose`）。
> 验证：浏览器开 `https://<域名>/health` 应返回 `{"status":"ok",...}`，`/code/` 是 Web UI。

## 第 2 步：每台 fleet 机器 `claude rc` 连上去

在**每台**要纳管的机器上（十几台都一样）：

```bash
# 指向你的 RCS + 同一个 token
export CLAUDE_BRIDGE_BASE_URL=https://<你的-devtunnel-域名>
export CLAUDE_BRIDGE_OAUTH_TOKEN=<KEY>

# 从仓库 dev 模式跑（bridge 默认启用）：
bun run dev rc
# 或用构建产物 / 已安装的 CLI：
#   claude rc
```

Windows（PowerShell）把 `export X=Y` 换成 `$env:X="Y"`，其余一致。

连上后终端会显示：

```
·✔︎· Connected · <机器名>
    Continue coding in the Claude app or https://<域名>/code?bridge=env_xxxx…
    space to show QR code
```

每台机器在 RCS 上注册成一个 **environment**，Dashboard 上能看到整批。

> 想把**已经在终端里开着的交互会话**推到手机（CLI 还能继续用）：在那个 `claude` REPL 里输
> `/remote-control`，而不是 `claude rc`。两者共用同一套 bridge；`claude rc` 是"机器待命、手机起
> 会话"，`/remote-control` 是"把当前 TUI 会话转出去"。

## 第 3 步：手机 / iPad / PC 打开 Web UI

浏览器打开 `https://<你的-devtunnel-域名>/code/`：

- **Dashboard** 列出所有 environment（你的整批机器）。
- 点进某台 → **New Session** 起会话，或打开已有会话。
- 实时看消息/工具调用；工具要权限时弹 **Permission Request**，点 **Approve / Reject**。
- 支持 AskUserQuestion 选项、计划审批、6 种权限模式选择器。
- iOS/iPad：Safari 打开后「添加到主屏幕」即可当 App 用。

---

## 常见问题

- **`/health` 通但 `/code/` 404 或白屏**：Web UI 没构建。回到第 1 步先 `vite build`。
- **客户端连不上 / 401**：`CLAUDE_BRIDGE_OAUTH_TOKEN` 必须命中服务端 `RCS_API_KEYS` 里的某个值；
  `CLAUDE_BRIDGE_BASE_URL` 要写 devtunnel 的 https 域名（不是 localhost）。
- **WebSocket 老断**：确认 `RCS_BASE_URL` 与浏览器实际访问地址一致（它用来生成 WS 地址）；
  反代要放行 WS 升级。RCS 自带 keep-alive 帧。
- **fleet 机器要不要开端口**：不要。它们只主动连出去到 RCS，无入站。
- **token 安全**：`RCS_API_KEYS` 用强随机串；`--allow-anonymous` 只是 devtunnel 层匿名，
  应用层认证仍靠这个 token。

## 和"本地导入 JSONL 离线看"的区别

RCS + bridge 是**实时控制**。如果你只是想把电脑上的某个 `~/.claude/projects/.../*.jsonl`
拷到手机上**离线翻历史**，那是另一回事，本套不覆盖。
