import { MessageSquareIcon, PlusIcon } from 'lucide-react';
import { useRef } from 'react';
import type { ParsedSession } from '../lib/types';
import { formatTimestamp } from '../lib/utils';

// =============================================================================
// 会话列表 — 按最后活跃时间倒序
// =============================================================================

interface SessionListProps {
  sessions: ParsedSession[];
  onSelect: (id: string) => void;
  onFiles: (files: FileList | File[]) => void;
}

export function SessionList({ sessions, onSelect, onFiles }: SessionListProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = [...sessions].sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="space-y-2">
        {sorted.map(session => (
          <button
            key={session.id}
            type="button"
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3 text-left transition-colors hover:border-brand/40 hover:bg-surface-1/50 active:bg-surface-1"
            onClick={() => onSelect(session.id)}
          >
            <MessageSquareIcon className="mt-0.5 size-4 flex-shrink-0 text-text-muted" />
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
      </div>

      {/* 继续添加 */}
      <button
        type="button"
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-text-muted transition-colors hover:border-brand/40 hover:text-text-secondary"
        onClick={() => inputRef.current?.click()}
      >
        <PlusIcon className="size-4" />
        添加更多文件
      </button>
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
