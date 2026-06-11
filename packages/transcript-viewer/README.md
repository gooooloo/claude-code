# Transcript Viewer

移动端友好的 Claude Code JSONL 会话查看器。纯静态 PWA：JSONL 在浏览器本地解析渲染，不经过任何服务器。

## 它解决什么问题

在手机上流畅地回看 Claude Code 会话。把电脑上 `~/.claude/projects/<项目>/<sessionId>.jsonl` 通过 iCloud / AirDrop / Syncthing 等任意方式传到手机，用浏览器打开本应用导入即可。

## 使用

```bash
# 开发
bun run dev

# 构建（输出 dist/，任意静态托管均可部署）
bun run build

# 本地预览构建产物
bun run preview
```

构建产物是纯静态文件，部署到任意静态托管（GitHub Pages、对象存储、家里的 NAS）后，手机浏览器打开并「添加到主屏幕」即可作为 PWA 使用，支持离线打开。

## 实现要点

- **JSONL 解析**（`src/lib/jsonl/`）：宽容逐行解析 → `uuid -> message` map → 选最新 leaf → 沿 `parentUuid` 回溯重建有效链 → 投影为视图条目。死分支（rewind/branch 残留）自动剔除，compact boundary 渲染为分隔线，未知 entry 类型直接跳过（向前兼容）。机制详见 `docs/internals/session-transcript-persistence.md`。
- **渲染层**（`src/components/`）：从 `packages/remote-control-server/web` 的聊天组件精简移植（只读，无权限/输入/WebSocket），与 RCS Web UI 共享同一套暖石色设计语言（`.impeccable.md`）。
- **性能**：大会话只渲染尾部 150 条、向上分页；shiki 按语言懒加载；首屏 gzip 约 92KB。

## 已知边界

- 只读查看，不能继续对话（实时交互走 RCS / bridge mode）。
- subagent sidechain 文件（`<sessionId>/subagents/agent-*.jsonl`）暂不关联展示，可作为独立文件导入查看。
- 导入的会话仅存在内存中，刷新后需重新导入。
