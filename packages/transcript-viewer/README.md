# Transcript Viewer

手机端的 Claude Code 会话客户端。两种使用方式：

1. **本地查看**：导入 `~/.claude/projects/<项目>/<sessionId>.jsonl`，纯本地解析渲染（PWA，离线可用）。
2. **远程实时**：连接远端机器上的 `server/transcript_relay.py`（经 devtunnel），实时查看正在进行的会话，并可发送输入、回答 AskUserQuestion、中断 —— 控制的是 Windows Terminal 里真实的 TUI 会话。协议见 `server/protocol.md`。

## 使用

```bash
# 开发
bun run dev

# 构建（输出 dist/，任意静态托管均可部署）
bun run build

# 本地预览构建产物
bun run preview

# 原生 App（Capacitor）：web 构建后同步进 android/ 工程
bunx --bun cap sync android
# 出 APK 需要 Android SDK：在 Android Studio 打开 android/ 或 cd android && ./gradlew assembleDebug
```

### 远端服务（Windows 机器）

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
