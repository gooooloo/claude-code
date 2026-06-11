import { useMemo, useState } from 'react';
import type { ParsedSession } from '../lib/types';
import { ChatView } from './chat/ChatView';

// =============================================================================
// 会话视图 — 大会话只渲染尾部，向上分页加载，保证手机端流畅
// =============================================================================

const PAGE_SIZE = 150;

interface SessionViewProps {
  session: ParsedSession;
}

export function SessionView({ session }: SessionViewProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const total = session.entries.length;
  const visible = useMemo(
    () => session.entries.slice(Math.max(0, total - visibleCount)),
    [session, total, visibleCount],
  );
  const hiddenCount = total - visible.length;

  const header =
    hiddenCount > 0 ? (
      <button
        type="button"
        className="mx-auto mb-4 rounded-full border border-border bg-surface-1 px-4 py-1.5 text-xs font-display text-text-secondary transition-colors hover:border-brand/40 hover:text-text-primary"
        onClick={() => setVisibleCount(count => count + PAGE_SIZE)}
      >
        加载更早的 {Math.min(PAGE_SIZE, hiddenCount)} 条（还有 {hiddenCount} 条）
      </button>
    ) : undefined;

  return <ChatView entries={visible} header={header} />;
}
