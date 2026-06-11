# Transcript Viewer

Claude Code 会话客户端，跨 iOS / iPad / Windows，从一处管理一支远程机器舰队。

两种使用方式：

1. **本地查看**：导入 `~/.claude/projects/<项目>/<sessionId>.jsonl`，纯本地解析渲染（PWA，离线可用）。
2. **远程实时（舰队）**：每台远端机器跑一个 `server/transcript_relay.py`（各自经 devtunnel 暴露）。客户端首页是舰队控制台：列出所有机器、显示在线状态与「等你回答」待办数（跨机汇总），点进任意机器看其会话列表，再点进会话即可实时查看、发送输入、回答 AskUserQuestion、中断 —— 控制的是远端 Windows Terminal 里真实的 TUI 会话。协议见 `server/protocol.md`。

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

```powershell
python packages/transcript-viewer/server/transcript_relay.py --token <密钥> --port 19850
devtunnel host -p 19850 --allow-anonymous
```

手机 App「添加连接」填 devtunnel 域名和密钥即可。本机联调可加 `--dev-echo`（输入只打印不注入）。

## 实现要点

- **JSONL 解析**（`src/lib/jsonl/`）：宽容逐行解析 → `uuid -> message` map → 选最新 leaf → 沿 `parentUuid` 回溯重建有效链 → 投影为视图条目。死分支（rewind/branch 残留）自动剔除，compact boundary 渲染为分隔线，未知 entry 类型直接跳过（向前兼容）。机制详见 `docs/internals/session-transcript-persistence.md`。
- **渲染层**（`src/components/`）：从 `packages/remote-control-server/web` 的聊天组件精简移植（只读，无权限/输入/WebSocket），与 RCS Web UI 共享同一套暖石色设计语言（`.impeccable.md`）。
- **性能**：大会话只渲染尾部 150 条、向上分页；shiki 按语言懒加载；首屏 gzip 约 92KB。

## 已知边界

- subagent sidechain 文件（`<sessionId>/subagents/agent-*.jsonl`）暂不关联展示，可作为独立文件导入查看。
- 本地导入的会话仅存在内存中，刷新后需重新导入（远程连接配置会持久化）。
- 远程输入注入需先在服务端绑定终端进程 PID（`server/protocol.md` 的 bind 流程）。
- Permission 对话框暂不能从手机回应（不写入 transcript），两个候选方案见 `server/protocol.md` 的 v2 设计。
