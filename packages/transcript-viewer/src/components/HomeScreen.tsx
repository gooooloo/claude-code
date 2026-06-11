import { ClipboardPasteIcon, CopyIcon, FileUpIcon, PlusIcon, ServerIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { type ConnectionConfig, exportConnections, newConnectionId, normalizeBaseUrl } from '../lib/connections';
import { type MachineStatus, useFleetStatus } from '../lib/fleet';
import type { ParsedSession } from '../lib/types';
import { cn, formatTimestamp } from '../lib/utils';
import { ClaudeMark } from './chat/MessageBubble';

// =============================================================================
// 首页（Page 1）— 舰队控制中心：多机连接管理 + 本地文件导入
// =============================================================================

interface HomeScreenProps {
  connections: ConnectionConfig[];
  localSessions: ParsedSession[];
  busy?: boolean;
  onAddConnection: (conn: ConnectionConfig) => void;
  onRemoveConnection: (id: string) => void;
  onOpenConnection: (id: string) => void;
  onOpenLocalSession: (id: string) => void;
  onImportConnections: (incoming: ConnectionConfig[]) => void;
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
  onImportConnections,
  onFiles,
}: HomeScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const fleet = useFleetStatus(connections);

  const sortedLocal = [...localSessions].sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));

  // 舰队汇总
  const onlineCount = connections.filter(c => fleet.get(c.id)?.online).length;
  const totalAttention = connections.reduce((sum, c) => sum + (fleet.get(c.id)?.attentionCount ?? 0), 0);

  // 等你回答的机器排前面，其余按名称
  const sortedConns = [...connections].sort((a, b) => {
    const aw = fleet.get(a.id)?.attentionCount ?? 0;
    const bw = fleet.get(b.id)?.attentionCount ?? 0;
    if (aw !== bw) return bw - aw;
    return (a.name || a.baseUrl).localeCompare(b.name || b.baseUrl);
  });

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      {/* 品牌区 + 舰队汇总 */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-brand/8">
          <ClaudeMark size={24} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-base font-semibold text-text-primary">Claude Code Sessions</h1>
          {connections.length > 0 ? (
            <p className="text-xs text-text-muted">
              {onlineCount}/{connections.length} 台在线
              {totalAttention > 0 && <span className="text-brand"> · {totalAttention} 个会话等你回答</span>}
            </p>
          ) : (
            <p className="text-xs text-text-muted">远程实时查看，或导入本地 JSONL</p>
          )}
        </div>
      </div>

      {/* 远程连接（舰队） */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-xs font-medium uppercase tracking-wide text-text-muted">
            远程机器 {connections.length > 0 && `(${connections.length})`}
          </h2>
          {connections.length > 0 && (
            <button
              type="button"
              className="text-xs text-text-muted transition-colors hover:text-text-secondary"
              onClick={() => setTransferOpen(true)}
            >
              导入 / 导出
            </button>
          )}
        </div>

        <div className="space-y-2">
          {sortedConns.map(conn => (
            <MachineCard
              key={conn.id}
              conn={conn}
              status={fleet.get(conn.id)}
              onOpen={() => onOpenConnection(conn.id)}
              onRemove={() => onRemoveConnection(conn.id)}
            />
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
            <div className="flex gap-2">
              <button
                type="button"
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-text-muted transition-colors hover:border-brand/40 hover:text-text-secondary"
                onClick={() => setAdding(true)}
              >
                <PlusIcon className="size-4" />
                添加机器
              </button>
              {connections.length === 0 && (
                <button
                  type="button"
                  className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-text-muted transition-colors hover:border-brand/40 hover:text-text-secondary"
                  onClick={() => setTransferOpen(true)}
                  title="从其他设备导入连接列表"
                >
                  <ClipboardPasteIcon className="size-4" />
                  导入
                </button>
              )}
            </div>
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

      {transferOpen && (
        <TransferDialog
          connections={connections}
          onImport={incoming => {
            onImportConnections(incoming);
            setTransferOpen(false);
          }}
          onClose={() => setTransferOpen(false)}
        />
      )}
    </div>
  );
}

// =============================================================================
// 单台机器卡片 — 在线状态 + 会话数 + 待办徽章
// =============================================================================

function MachineCard({
  conn,
  status,
  onOpen,
  onRemove,
}: {
  conn: ConnectionConfig;
  status: MachineStatus | undefined;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3 transition-colors hover:border-brand/40">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onOpen}>
        <StatusDot status={status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-sm font-medium text-text-primary">
            {conn.name || conn.baseUrl}
          </span>
          <span className="block truncate text-xs text-text-muted">
            {status?.loading ? '连接中…' : status?.online ? `${status.sessionCount} 个会话` : (status?.error ?? '离线')}
          </span>
        </span>
        {status && status.attentionCount > 0 && (
          <span className="flex-shrink-0 rounded-full bg-brand px-2 py-0.5 font-display text-[10px] font-medium text-white">
            {status.attentionCount} 等你
          </span>
        )}
      </button>
      <button
        type="button"
        className="flex size-8 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-1 hover:text-status-error"
        onClick={onRemove}
        title="删除机器"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}

function StatusDot({ status }: { status: MachineStatus | undefined }) {
  const cls = status?.loading
    ? 'bg-text-muted animate-pulse'
    : status?.online
      ? 'bg-status-active'
      : 'bg-status-error/60';
  return (
    <span className="relative flex size-4 flex-shrink-0 items-center justify-center">
      <ServerIcon className="size-4 text-text-muted" />
      <span className={cn('absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-surface-2', cls)} />
    </span>
  );
}

// =============================================================================
// 导入 / 导出对话框
// =============================================================================

function TransferDialog({
  connections,
  onImport,
  onClose,
}: {
  connections: ConnectionConfig[];
  onImport: (incoming: ConnectionConfig[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'export' | 'import'>(connections.length > 0 ? 'export' : 'import');
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const exported = exportConnections(connections);

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(exported);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const doImport = async () => {
    setImportError(null);
    let text = importText.trim();
    if (!text) {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        // 剪贴板读取被拒时，提示手动粘贴
      }
    }
    const { parseConnectionsImport } = await import('../lib/connections');
    const parsed = parseConnectionsImport(text);
    if (!parsed || parsed.length === 0) {
      setImportError('没解析出有效连接，检查粘贴内容是否为导出的 JSON');
      return;
    }
    onImport(parsed);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-t-2xl border border-border bg-surface-0 p-4 sm:rounded-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex gap-2">
          <TabButton active={tab === 'export'} onClick={() => setTab('export')}>
            导出
          </TabButton>
          <TabButton active={tab === 'import'} onClick={() => setTab('import')}>
            导入
          </TabButton>
        </div>

        {tab === 'export' ? (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              复制下面的 JSON，在其他设备（iPad / Windows）的导入页粘贴，即可同步全部机器配置。含 token，注意保管。
            </p>
            <textarea
              readOnly
              className="h-40 w-full resize-none rounded-lg border border-border bg-surface-1 p-3 font-mono text-xs text-text-secondary"
              value={exported}
            />
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-display text-sm font-medium text-white"
              onClick={doCopy}
            >
              <CopyIcon className="size-4" />
              {copied ? '已复制' : '复制到剪贴板'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">粘贴从另一设备导出的 JSON。同地址的机器会被更新，其余追加。</p>
            <textarea
              className="h-40 w-full resize-none rounded-lg border border-border bg-surface-1 p-3 font-mono text-xs text-text-primary focus:border-brand/50 focus:outline-none"
              placeholder="在此粘贴，或留空点导入直接读剪贴板…"
              value={importText}
              onChange={e => setImportText(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
            />
            {importError && <p className="text-xs text-status-error">{importError}</p>}
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-display text-sm font-medium text-white"
              onClick={doImport}
            >
              <ClipboardPasteIcon className="size-4" />
              导入
            </button>
          </div>
        )}

        <button
          type="button"
          className="mt-2 w-full rounded-lg px-4 py-2 font-display text-sm text-text-muted"
          onClick={onClose}
        >
          关闭
        </button>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'flex-1 rounded-lg px-3 py-2 font-display text-sm font-medium transition-colors',
        active ? 'bg-brand/10 text-brand' : 'text-text-muted hover:text-text-secondary',
      )}
      onClick={onClick}
    >
      {children}
    </button>
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
        placeholder="名称（如：Windows 工作机 01）"
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
