import { useCallback, useMemo, useState } from 'react';
import { sendInput } from '../lib/api';
import type { ConnectionConfig } from '../lib/connections';
import type { PendingQuestion } from '../lib/jsonl/adapt';
import { useLiveSession } from '../lib/liveSession';
import type { InputAction, RemoteSessionInfo } from '../lib/protocol';
import { cn } from '../lib/utils';
import { ChatView } from './chat/ChatView';
import { InputBar } from './InputBar';

// =============================================================================
// 实时会话视图（Page 2）— SSE 流 + 输入 + AskUserQuestion 卡片
// =============================================================================

const PAGE_SIZE = 150;

interface LiveSessionViewProps {
  conn: ConnectionConfig;
  session: RemoteSessionInfo;
}

export function LiveSessionView({ conn, session }: LiveSessionViewProps) {
  const live = useLiveSession(conn, session.projectKey, session.sessionId);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sendError, setSendError] = useState<string | null>(null);

  const total = live.entries.length;
  const visible = useMemo(
    () => live.entries.slice(Math.max(0, total - visibleCount)),
    [live.entries, total, visibleCount],
  );
  const hiddenCount = total - visible.length;

  const dispatch = useCallback(
    async (action: InputAction) => {
      setSendError(null);
      const result = await sendInput(conn, session.projectKey, session.sessionId, action);
      if (!result.ok) {
        setSendError(result.error ?? '发送失败');
      }
    },
    [conn, session.projectKey, session.sessionId],
  );

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 连接状态条 — 仅异常时显示 */}
      {live.connectionStatus !== 'live' && (
        <div
          className={cn(
            'px-4 py-1.5 text-center font-display text-xs',
            live.connectionStatus === 'error'
              ? 'bg-status-error/10 text-status-error'
              : 'bg-status-running/10 text-status-running',
          )}
        >
          {live.connectionStatus === 'connecting' && '正在连接…'}
          {live.connectionStatus === 'reconnecting' && '连接中断，自动重连中…'}
          {live.connectionStatus === 'error' && '连接失败，检查 devtunnel 与 token'}
        </div>
      )}

      <ChatView entries={visible} header={header} />

      {/* AskUserQuestion 卡片 */}
      {live.pendingQuestions.length > 0 && (
        <div className="border-t border-border bg-surface-1/60 px-4 py-3 backdrop-blur sm:px-8">
          {live.pendingQuestions.map((question, i) => (
            <QuestionCard key={`${question.toolUseId}-${i}`} question={question} onAction={dispatch} />
          ))}
        </div>
      )}

      {sendError && (
        <div className="bg-status-error/10 px-4 py-1.5 text-center font-display text-xs text-status-error">
          {sendError}
        </div>
      )}

      <InputBar
        busy={live.sessionState === 'busy'}
        placeholder={live.pendingQuestions.length > 0 ? '或直接输入自由回答…' : '发送消息到这个会话…'}
        onSend={text =>
          dispatch(live.pendingQuestions.length > 0 ? { type: 'text_answer', text } : { type: 'prompt', text })
        }
        onInterrupt={() => dispatch({ type: 'interrupt' })}
      />
    </div>
  );
}

// =============================================================================
// AskUserQuestion 选项卡片
// =============================================================================

function QuestionCard({ question, onAction }: { question: PendingQuestion; onAction: (action: InputAction) => void }) {
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 font-display text-sm font-medium text-text-primary">
        {question.header && (
          <span className="mr-2 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">{question.header}</span>
        )}
        {question.question}
      </p>
      <div className="flex flex-wrap gap-2">
        {question.options.map((option, index) => (
          <button
            key={`${question.toolUseId}-opt-${index}`}
            type="button"
            className="rounded-full border border-brand/40 bg-brand/5 px-4 py-2 text-left font-display text-sm text-text-primary transition-colors hover:bg-brand/15 active:bg-brand/20"
            title={option.description}
            onClick={() => onAction({ type: 'option', index })}
          >
            {option.label}
          </button>
        ))}
      </div>
      {question.multiSelect && (
        <p className="mt-1.5 text-xs text-text-muted">多选问题：逐个点选，或在下方输入框自由回答</p>
      )}
    </div>
  );
}
