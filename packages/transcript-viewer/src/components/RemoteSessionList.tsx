import { CircleAlertIcon, LoaderIcon, MessageSquareIcon, RefreshCwIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { listSessions } from '../lib/api';
import type { ConnectionConfig } from '../lib/connections';
import type { RemoteSessionInfo, RemoteSessionState } from '../lib/protocol';
import { cn } from '../lib/utils';

// =============================================================================
// 远程会话列表 — 状态徽章 + 下拉刷新
// =============================================================================

interface RemoteSessionListProps {
  conn: ConnectionConfig;
  onSelect: (session: RemoteSessionInfo) => void;
}

export function RemoteSessionList({ conn, onSelect }: RemoteSessionListProps) {
  const [sessions, setSessions] = useState<RemoteSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listSessions(conn);
      setSessions(list.sort((a, b) => b.mtime - a.mtime));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    refresh();
    // 列表页轻量轮询，保持状态徽章新鲜
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (sessions === null && loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-muted">
        <LoaderIcon className="size-5 animate-spin" />
        <p className="text-sm">连接 {conn.name || conn.baseUrl}…</p>
      </div>
    );
  }

  if (error && !sessions) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <CircleAlertIcon className="size-6 text-status-error" />
        <p className="text-sm text-text-secondary">连接失败：{error}</p>
        <p className="text-xs text-text-muted">检查 devtunnel 是否在线、token 是否一致</p>
        <button
          type="button"
          className="mt-2 rounded-lg border border-border px-4 py-2 font-display text-sm text-text-secondary hover:border-brand/40"
          onClick={refresh}
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-xs font-medium uppercase tracking-wide text-text-muted">
          {conn.name || conn.baseUrl}
        </h2>
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary"
          onClick={refresh}
          title="刷新"
        >
          <RefreshCwIcon className={cn('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <div className="space-y-2">
        {(sessions ?? []).map(session => (
          <button
            key={`${session.projectKey}/${session.sessionId}`}
            type="button"
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3 text-left transition-colors hover:border-brand/40 active:bg-surface-1"
            onClick={() => onSelect(session)}
          >
            <MessageSquareIcon className="mt-0.5 size-4 flex-shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-sm font-medium text-text-primary">
                {session.title ?? session.sessionId.slice(0, 8)}
              </p>
              <p className="mt-0.5 truncate text-xs text-text-muted">
                {session.projectKey} · {formatMtime(session.mtime)}
              </p>
            </div>
            <StateBadge state={session.state} />
          </button>
        ))}
        {sessions && sessions.length === 0 && (
          <p className="py-8 text-center text-sm text-text-muted">远端没有发现会话文件</p>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 状态徽章
// =============================================================================

const STATE_STYLE: Record<RemoteSessionState, { label: string; className: string }> = {
  idle: { label: '空闲', className: 'bg-status-active/10 text-status-active' },
  busy: { label: '运行中', className: 'bg-status-running/10 text-status-running' },
  elicitation: { label: '等你回答', className: 'bg-brand/15 text-brand' },
  plan_review: { label: '计划审批', className: 'bg-brand/15 text-brand' },
  permission: { label: '等你授权', className: 'bg-brand/15 text-brand' },
  unknown: { label: '', className: '' },
};

export function StateBadge({ state }: { state: RemoteSessionState }) {
  const style = STATE_STYLE[state];
  if (!style.label) return null;
  return (
    <span
      className={cn(
        'flex-shrink-0 rounded-full px-2 py-0.5 font-display text-[10px] font-medium leading-relaxed',
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

function formatMtime(epochSeconds: number): string {
  if (!epochSeconds) return '';
  return new Date(epochSeconds * 1000).toLocaleString();
}
