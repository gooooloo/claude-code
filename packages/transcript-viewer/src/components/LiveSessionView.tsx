import { CheckIcon, ClipboardListIcon, MessageCircleQuestionIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { decidePermission, sendInput } from '../lib/api';
import { clientId } from '../lib/clientId';
import type { ConnectionConfig } from '../lib/connections';
import type { PendingQuestion } from '../lib/jsonl/adapt';
import { type PermissionView, useLiveSession } from '../lib/liveSession';
import type { InputAction, RemoteSessionInfo } from '../lib/protocol';
import { cn, truncate } from '../lib/utils';
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

  // daemon 路径下 AskUserQuestion 由 kind='question' 权限卡片处理；
  // 去掉 JSONL extractPendingQuestions 里同一 toolUseID 的，避免双卡。
  const questionToolUseIds = new Set(live.permissions.filter(p => p.kind === 'question').map(p => p.toolUseID));
  const jsonlQuestions = live.pendingQuestions.filter(q => !questionToolUseIds.has(q.toolUseId));
  const awaitingAnswer = jsonlQuestions.length > 0;

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

  const decide = useCallback(
    async (permissionId: string, decision: 'allow' | 'deny', answers?: Record<string, string>) => {
      setSendError(null);
      const result = await decidePermission(
        conn,
        session.projectKey,
        session.sessionId,
        permissionId,
        decision,
        clientId(),
        answers,
      );
      // 抢答失败不是错误：说明别的端先答了，UI 会随 resolved 事件置灰
      if (!result.ok && result.error) {
        setSendError(result.error);
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

      {/* 权限/问题/计划卡片（daemon canUseTool）—— 任意端可答，先到先得 */}
      {live.permissions.length > 0 && (
        <div className="space-y-3 border-t border-border bg-surface-1/60 px-4 py-3 backdrop-blur sm:px-8">
          {live.permissions.map(permission => (
            <PermissionCard key={permission.id} permission={permission} onDecide={decide} />
          ))}
        </div>
      )}

      {/* AskUserQuestion 卡片（relay 路径；daemon 路径下被 kind='question' 权限覆盖，去重） */}
      {jsonlQuestions.length > 0 && (
        <div className="border-t border-border bg-surface-1/60 px-4 py-3 backdrop-blur sm:px-8">
          {jsonlQuestions.map((question, i) => (
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
        placeholder={awaitingAnswer ? '或直接输入自由回答…' : '发送消息到这个会话…'}
        onSend={text => dispatch(awaitingAnswer ? { type: 'text_answer', text } : { type: 'prompt', text })}
        onInterrupt={() => dispatch({ type: 'interrupt' })}
      />
    </div>
  );
}

// =============================================================================
// 权限/问题/计划卡片 —— 按 kind 渲染；已解决则置灰显示"已由 X 处理"
// =============================================================================

type DecideFn = (permissionId: string, decision: 'allow' | 'deny', answers?: Record<string, string>) => void;

function PermissionCard({ permission, onDecide }: { permission: PermissionView; onDecide: DecideFn }) {
  const resolved = permission.resolved;
  const iconColor = resolved ? 'text-text-muted' : 'text-brand';

  return (
    <div
      className={cn(
        'mx-auto max-w-3xl rounded-xl border p-3',
        resolved ? 'border-border opacity-60' : 'border-brand/40 bg-brand/5',
      )}
    >
      <div className="flex items-start gap-2">
        {permission.kind === 'plan' ? (
          <ClipboardListIcon className={cn('mt-0.5 size-4 flex-shrink-0', iconColor)} />
        ) : permission.kind === 'question' ? (
          <MessageCircleQuestionIcon className={cn('mt-0.5 size-4 flex-shrink-0', iconColor)} />
        ) : (
          <ShieldAlertIcon className={cn('mt-0.5 size-4 flex-shrink-0', iconColor)} />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-medium text-text-primary">{cardTitle(permission)}</p>
          <PermissionBody permission={permission} />
        </div>
      </div>

      {resolved ? (
        <p className="mt-2 text-xs text-text-muted">
          已由 <span className="font-medium text-text-secondary">{resolved.by}</span>{' '}
          {resolvedVerb(permission.kind, resolved.behavior)}
        </p>
      ) : permission.kind === 'question' ? (
        <QuestionDecision permission={permission} onDecide={onDecide} />
      ) : permission.kind === 'plan' ? (
        <div className="mt-2.5 flex gap-2">
          <DecideButton
            tone="brand"
            icon={<CheckIcon className="size-4" />}
            label="批准计划"
            onClick={() => onDecide(permission.id, 'allow')}
          />
          <DecideButton
            tone="ghost"
            icon={<XIcon className="size-4" />}
            label="继续规划"
            onClick={() => onDecide(permission.id, 'deny')}
          />
        </div>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <DecideButton
            tone="brand"
            icon={<CheckIcon className="size-4" />}
            label="允许"
            onClick={() => onDecide(permission.id, 'allow')}
          />
          <DecideButton
            tone="ghost"
            icon={<XIcon className="size-4" />}
            label="拒绝"
            onClick={() => onDecide(permission.id, 'deny')}
          />
        </div>
      )}
    </div>
  );
}

function cardTitle(p: PermissionView): string {
  if (p.title) return p.title;
  if (p.kind === 'plan') return '批准这个计划?';
  if (p.kind === 'question') return '请回答';
  return `允许使用 ${p.toolName}?`;
}

function resolvedVerb(kind: PermissionView['kind'], behavior: 'allow' | 'deny'): string {
  if (kind === 'question') return '回答';
  if (kind === 'plan') return behavior === 'allow' ? '批准' : '退回';
  return behavior === 'allow' ? '允许' : '拒绝';
}

function PermissionBody({ permission }: { permission: PermissionView }) {
  if (permission.kind === 'plan' && permission.plan) {
    return (
      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-1 p-2 font-mono text-xs text-text-secondary">
        {permission.plan}
      </pre>
    );
  }
  if (permission.kind === 'question') return null;
  const detail = permissionDetail(permission);
  return (
    <>
      {detail && <p className="mt-0.5 break-all font-mono text-xs text-text-secondary">{truncate(detail, 300)}</p>}
      {permission.description && <p className="mt-0.5 text-xs text-text-muted">{permission.description}</p>}
    </>
  );
}

function DecideButton({
  tone,
  icon,
  label,
  onClick,
}: {
  tone: 'brand' | 'ghost';
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2 font-display text-sm font-medium transition-colors',
        tone === 'brand'
          ? 'bg-brand text-white active:opacity-80'
          : 'border border-border text-text-secondary hover:border-status-error/40 hover:text-status-error',
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

// AskUserQuestion：逐题选选项，累积答案后一次提交
function QuestionDecision({ permission, onDecide }: { permission: PermissionView; onDecide: DecideFn }) {
  const questions = permission.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const allAnswered = questions.every(q => answers[q.question]);

  return (
    <div className="mt-2 space-y-3">
      {questions.map(q => (
        <div key={q.question}>
          <p className="mb-1.5 text-sm text-text-primary">
            {q.header && (
              <span className="mr-2 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">{q.header}</span>
            )}
            {q.question}
          </p>
          <div className="flex flex-wrap gap-2">
            {q.options.map(opt => {
              const selected = answers[q.question] === opt.label;
              return (
                <button
                  key={opt.label}
                  type="button"
                  title={opt.description}
                  className={cn(
                    'rounded-full border px-4 py-2 font-display text-sm transition-colors',
                    selected
                      ? 'border-brand bg-brand text-white'
                      : 'border-brand/40 bg-brand/5 text-text-primary hover:bg-brand/15',
                  )}
                  onClick={() => setAnswers(prev => ({ ...prev, [q.question]: opt.label }))}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={!allAnswered}
        className={cn(
          'w-full rounded-lg bg-brand px-4 py-2 font-display text-sm font-medium text-white transition-opacity',
          !allAnswered && 'opacity-40',
        )}
        onClick={() => onDecide(permission.id, 'allow', answers)}
      >
        提交回答
      </button>
    </div>
  );
}

/** 从工具入参里挑最有信息量的一段作为详情（命令、文件路径等） */
function permissionDetail(permission: PermissionView): string {
  const input = permission.input;
  if (!input) return '';
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
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
