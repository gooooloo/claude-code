import { FileUpIcon, PlusIcon, ServerIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { type ConnectionConfig, newConnectionId, normalizeBaseUrl } from '../lib/connections';
import type { ParsedSession } from '../lib/types';
import { cn, formatTimestamp } from '../lib/utils';
import { ClaudeMark } from './chat/MessageBubble';

// =============================================================================
// 首页（Page 1）— 远程连接管理 + 本地文件导入
// =============================================================================

interface HomeScreenProps {
  connections: ConnectionConfig[];
  localSessions: ParsedSession[];
  busy?: boolean;
  onAddConnection: (conn: ConnectionConfig) => void;
  onRemoveConnection: (id: string) => void;
  onOpenConnection: (id: string) => void;
  onOpenLocalSession: (id: string) => void;
  onFiles: (files: FileList | File[]) => void;
}

export function HomeScreen({
  connections,
  localSessions,
  busy,
  onAddConnection,
  onRemoveConnection,
  onOpenConnection,
  onOpenLocalSession,
  onFiles,
}: HomeScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);

  const sortedLocal = [...localSessions].sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      {/* 品牌区 */}
      <div className="mb-8 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-brand/8">
          <ClaudeMark size={24} />
        </div>
        <div>
          <h1 className="font-display text-base font-semibold text-text-primary">Claude Code Sessions</h1>
          <p className="text-xs text-text-muted">远程实时查看，或导入本地 JSONL</p>
        </div>
      </div>

      {/* 远程连接 */}
      <section>
        <h2 className="mb-2 font-display text-xs font-medium uppercase tracking-wide text-text-muted">远程连接</h2>
        <div className="space-y-2">
          {connections.map(conn => (
            <div
              key={conn.id}
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3 transition-colors hover:border-brand/40"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => onOpenConnection(conn.id)}
              >
                <ServerIcon className="size-4 flex-shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm font-medium text-text-primary">
                    {conn.name || conn.baseUrl}
                  </span>
                  <span className="block truncate text-xs text-text-muted">{conn.baseUrl}</span>
                </span>
              </button>
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-1 hover:text-status-error"
                onClick={() => onRemoveConnection(conn.id)}
                title="删除连接"
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </div>
          ))}

          {adding ? (
            <AddConnectionForm
              onSubmit={conn => {
                onAddConnection(conn);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-text-muted transition-colors hover:border-brand/40 hover:text-text-secondary"
              onClick={() => setAdding(true)}
            >
              <PlusIcon className="size-4" />
              添加连接（devtunnel 地址）
            </button>
          )}
        </div>
      </section>

      {/* 本地文件 */}
      <section className="mt-8">
        <h2 className="mb-2 font-display text-xs font-medium uppercase tracking-wide text-text-muted">本地文件</h2>
        <div className="space-y-2">
          {sortedLocal.map(session => (
            <button
              key={session.id}
              type="button"
              className="flex w-full items-start gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3 text-left transition-colors hover:border-brand/40 active:bg-surface-1"
              onClick={() => onOpenLocalSession(session.id)}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-sm font-medium text-text-primary">
                  {session.title ?? session.fileName}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {session.messageCount} 条消息
                  {session.lastTimestamp ? ` · ${formatTimestamp(session.lastTimestamp)}` : ''}
                </p>
              </div>
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-text-muted transition-colors hover:border-brand/40 hover:text-text-secondary',
              busy && 'opacity-60',
            )}
            onClick={() => inputRef.current?.click()}
          >
            <FileUpIcon className="size-4" />
            {busy ? '解析中…' : '导入 JSONL 文件'}
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-text-muted">
          文件只在本机解析渲染，不会上传。会话文件位于{' '}
          <code className="font-mono">~/.claude/projects/&lt;项目&gt;/&lt;sessionId&gt;.jsonl</code>
        </p>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept=".jsonl,application/jsonl,text/plain"
        multiple
        hidden
        onChange={e => {
          if (e.target.files && e.target.files.length > 0) {
            onFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />
    </div>
  );
}

// =============================================================================
// 添加连接表单
// =============================================================================

function AddConnectionForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (conn: ConnectionConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');

  const canSubmit = baseUrl.trim().length > 0;

  return (
    <div className="space-y-2 rounded-xl border border-brand/30 bg-surface-2/50 p-4">
      <input
        className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand/50 focus:outline-none"
        placeholder="名称（如：Windows 工作机）"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <input
        className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-brand/50 focus:outline-none"
        placeholder="https://xxx.devtunnels.ms"
        value={baseUrl}
        onChange={e => setBaseUrl(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <input
        className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-brand/50 focus:outline-none"
        placeholder="Token（与服务端 RELAY_TOKEN 一致）"
        value={token}
        onChange={e => setToken(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={!canSubmit}
          className={cn(
            'flex-1 rounded-lg bg-brand px-3 py-2 font-display text-sm font-medium text-white transition-opacity',
            !canSubmit && 'opacity-50',
          )}
          onClick={() =>
            onSubmit({
              id: newConnectionId(),
              name: name.trim(),
              baseUrl: normalizeBaseUrl(baseUrl),
              token: token.trim(),
            })
          }
        >
          保存
        </button>
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 font-display text-sm text-text-secondary"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}
