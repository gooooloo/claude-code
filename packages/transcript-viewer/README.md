# Transcript Viewer

Claude Code 会话客户端，跨 iOS / iPad / Windows，从一处管理一支远程机器舰队。

三种使用方式：

1. **本地查看**：导入 `~/.claude/projects/<项目>/<sessionId>.jsonl`，纯本地解析渲染（PWA，离线可用）。
2. **接管已开的终端会话（relay）**：远端跑 `server/transcript_relay.py`，它 **tail 你已经在终端里打开的 `claude` 会话** 的 JSONL、经 devtunnel 推到客户端；输入靠往那个真实的裸 TUI **注入按键**。适合「电脑上已经开着 Claude，想从手机接着看/操作」。
3. **由客户端起会话（daemon，推荐）**：远端在仓库内跑 `bun run server/run-daemon.ts`，daemon **自己用内部 QueryEngine 跑会话**，权限走 `canUseTool` 结构化回调——**由 daemon 持有、广播全端、第一个客户端决定原子胜出**，解决「本地 + 多端事先不知道谁先答」的并发问题。已在 Mac 上用真实会话验证。协议与对比见 `server/protocol.md`。

> **relay 与 daemon 的根本区别 —— 不要混淆：**
> - **relay 接管「已存在」的终端会话**：你先在终端 `claude` 开会话，relay 把它镜像给手机。会话归终端，relay 只是个旁路。
> - **daemon 没有终端窗口**：它**只列出、只控制自己创建的会话**。会话必须从客户端「新建会话」发起（`POST /api/sessions`），daemon 是唯一入口。你在终端里另开的 `claude` 对 daemon **不可见**——那是 relay 的活，不是 daemon 的。
> - 想「控制终端里那个会话」用 relay；想「从手机/PC 起一个全新会话并全程控制」用 daemon。

> **为什么不用官方 Remote Control（`claude rc`）？** enterprise 账号本就不是 claude.ai 订阅，
> 官方 bridge 第一道订阅闸即挡；即便自建服务器 + 环境变量绕过订阅闸，**组织若禁用了
> remote control，第二道 policy 闸（`isPolicyAllowed('allow_remote_control')`）仍会挡死**
> `claude rc` / `claude bridge` / REPL 内转移这三条入口。daemon 不走 bridge 机制、不碰这两道闸，
> 是 enterprise 的可行路径。代码依据、合规提醒与远端测试步骤见
> [`server/enterprise-remote-control.md`](server/enterprise-remote-control.md)。

客户端首页是**舰队控制台**：列出所有机器、在线状态、跨机汇总的「等你处理」待办数（含等你授权），点进机器看会话列表（daemon 模式下需先**新建会话**），再点进会话即可实时查看、发送输入、回答 AskUserQuestion、**批准/拒绝工具权限**、中断。

> 十几台机器的连接配置（含 token）可在「导入 / 导出」里一次导出、在其他设备粘贴导入，三端共用一份。

## 客户端形态（同一套 React 代码）

| 平台 | 形态 | 构建 |
|---|---|---|
| iOS / iPad | Capacitor 原生 App | `bunx --bun cap sync ios` → Xcode 安装 |
| Windows | Tauri 原生窗口（WebView2，~几 MB .exe） | 见下方 |
| 任意浏览器 | PWA（添加到主屏幕/安装为应用） | 部署 `dist/` 后直接访问 |

## 使用

```bash
# 开发
bun run dev

# 构建（输出 dist/，任意静态托管均可部署）
bun run build

# 本地预览构建产物
bun run preview

# 原生 App（Capacitor，iOS）：web 构建后同步进 ios/ 工程
bunx --bun cap sync ios
# 在 Xcode 打开并安装到 iPhone：
bunx --bun cap open ios
# 然后在 Xcode 里选你的设备 + 签名团队（免费 Apple ID 也可，7 天有效），Run。
```

> 需要 Xcode 与 CocoaPods（`brew install cocoapods`）。iOS 平台用 Swift Package Manager 管理 Capacitor 插件。
> 若要支持 Android，`bun add @capacitor/android && bunx --bun cap add android` 即可再生成。

```bash
# Windows 原生窗口（Tauri）：需在 Windows 机器上构建 .exe
bun run tauri build      # 产物：src-tauri/target/release/bundle/（nsis + msi 安装包）
bun run tauri dev        # 本地开发：起 vite + 原生窗口
```

> Windows 端需 Rust 工具链 + WebView2（Win10/11 自带）。Mac 上可 `cargo check` 验证编译，
> 但 .exe 必须在 Windows 上构建（不跨平台交叉编译）。
> 国内镜像：若 `~/.cargo/config` 配了 `git://` 协议的 crates 镜像（已弃用、连接被拒），
> 改用 `sparse+https://mirrors.ustc.edu.cn/crates.io-index/`。

### 远端服务（每台机器一个）

**daemon（推荐；enterprise 唯一可行路径）** —— 由客户端起会话、结构化权限：

```powershell
# 必须经 run-daemon.ts 启动(注入 QueryEngine 需要的 MACRO + feature flags)
bun run packages/transcript-viewer/server/run-daemon.ts --token <密钥> --port 19860
devtunnel host -p 19860 --allow-anonymous
# 本机验证(不跑真会话、不耗 API)：加 --mock
```

**relay** —— 接管你已在终端开着的 `claude` 会话（只读看历史 + 按键注入，看不到权限框）：

```powershell
python packages/transcript-viewer/server/transcript_relay.py --token <密钥> --port 19850
devtunnel host -p 19850 --allow-anonymous
```

手机 App「添加连接」填 devtunnel 域名和密钥即可。relay 本机联调可加 `--dev-echo`（输入只打印不注入）。

> enterprise 账号请优先用 daemon——官方 Remote Control 因订阅闸 + 组织 policy 闸不可用，
> 原因见 [`server/enterprise-remote-control.md`](server/enterprise-remote-control.md)。

## 实现要点

- **JSONL 解析**（`src/lib/jsonl/`）：宽容逐行解析 → `uuid -> message` map → 选最新 leaf → 沿 `parentUuid` 回溯重建有效链 → 投影为视图条目。死分支（rewind/branch 残留）自动剔除，compact boundary 渲染为分隔线，未知 entry 类型直接跳过（向前兼容）。机制详见 `docs/internals/session-transcript-persistence.md`。
- **渲染层**（`src/components/`）：从 `packages/remote-control-server/web` 的聊天组件精简移植（只读，无权限/输入/WebSocket），与 RCS Web UI 共享同一套暖石色设计语言（`.impeccable.md`）。
- **性能**：大会话只渲染尾部 150 条、向上分页；shiki 按语言懒加载；首屏 gzip 约 92KB。

## 已知边界

- subagent sidechain 文件（`<sessionId>/subagents/agent-*.jsonl`）暂不关联展示，可作为独立文件导入查看。
- 本地导入的会话仅存在内存中，刷新后需重新导入（远程连接配置会持久化）。
- **relay** 模式：远程输入注入需先在服务端绑定终端进程 PID（`server/protocol.md` 的 bind 流程）；Permission 对话框看不到（不写入 transcript），无法从手机回应——这正是 daemon 模式存在的理由。
- **daemon** 模式：权限/AskUserQuestion/ExitPlanMode 均可从手机回应（`canUseTool` 结构化通道，多端先到先得），已在 Mac 实测；但 daemon 不接管终端会话，只控制自己创建的会话。
