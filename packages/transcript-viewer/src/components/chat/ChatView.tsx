import { TerminalIcon } from 'lucide-react';
import type { CommandEntry, DividerEntry, ThreadEntry, ToolCallEntry } from '../../lib/types';
import { cn } from '../../lib/utils';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButtons,
} from '../ai-elements/conversation';
import { AssistantBubble, UserBubble } from './MessageBubble';
import { PlanDisplay } from './PlanView';
import { ToolCallGroup } from './ToolCallGroup';

// =============================================================================
// 只读会话视图 — Anthropic 编辑式排版（从 RCS ChatView 精简）
// =============================================================================

interface ChatViewProps {
  entries: ThreadEntry[];
  header?: React.ReactNode;
}

export function ChatView({ entries, header }: ChatViewProps) {
  const grouped = groupToolCalls(entries);
  const hasMessages = entries.length > 0;
  const lastUserMessageId = findLastUserMessageId(entries);

  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {header}
        {!hasMessages ? (
          <ConversationEmptyState title="这个会话没有可展示的消息" description="可能是空会话或纯 metadata 文件" />
        ) : (
          <>
            {grouped.map((item, i) => {
              if (item.type === 'single') {
                return (
                  <div key={`entry-${i}`} className={cn(entrySpacing(entries, item.entry))}>
                    <EntryRenderer entry={item.entry} lastUserMessageId={lastUserMessageId} />
                  </div>
                );
              }
              // 工具调用组 — 紧贴在助手消息下方
              return (
                <div key={`group-${i}`} className="-mt-2">
                  <ToolCallGroup entries={item.entries} />
                </div>
              );
            })}
          </>
        )}
        <ConversationScrollButtons hasUserMessages={entries.some(e => e.type === 'user_message')} />
      </ConversationContent>
    </Conversation>
  );
}

// =============================================================================
// 间距逻辑 — 用户消息前后间距大，工具调用紧贴
// =============================================================================

function entrySpacing(entries: ThreadEntry[], entry: ThreadEntry): string {
  if (entry.type === 'user_message') {
    return 'pt-10 pb-3';
  }
  if (entry.type === 'assistant_message') {
    const index = entries.indexOf(entry);
    const next = entries[index + 1];
    if (next?.type === 'tool_call') {
      return 'pt-3 pb-1';
    }
    return 'pt-3 pb-8';
  }
  if (entry.type === 'plan') {
    return 'pt-3 pb-3';
  }
  if (entry.type === 'divider') {
    return 'pt-6 pb-6';
  }
  if (entry.type === 'command') {
    return 'pt-8 pb-1';
  }
  return 'py-2';
}

// =============================================================================
// 单条目渲染器
// =============================================================================

function EntryRenderer({ entry, lastUserMessageId }: { entry: ThreadEntry; lastUserMessageId: string | null }) {
  switch (entry.type) {
    case 'user_message':
      return <UserBubble entry={entry} isLastUserMessage={entry.id === lastUserMessageId} />;
    case 'assistant_message':
      return <AssistantBubble entry={entry} />;
    case 'tool_call':
      return <ToolCallGroup entries={[entry]} />;
    case 'plan':
      return <PlanDisplay entry={entry} />;
    case 'divider':
      return <Divider entry={entry} />;
    case 'command':
      return <CommandLine entry={entry} />;
    default:
      return null;
  }
}

// =============================================================================
// 分隔线 — compact boundary
// =============================================================================

function Divider({ entry }: { entry: DividerEntry }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 border-t border-border" />
      <span className="text-[10px] text-text-muted font-display tracking-wide">{entry.label}</span>
      <div className="flex-1 border-t border-border" />
    </div>
  );
}

// =============================================================================
// 斜杠命令 — 紧凑的终端风格单行
// =============================================================================

function CommandLine({ entry }: { entry: CommandEntry }) {
  return (
    <div className="flex justify-end">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-1 px-3 py-1 text-xs font-mono text-text-secondary">
        <TerminalIcon className="size-3 text-text-muted" />
        {entry.name}
      </span>
    </div>
  );
}

// =============================================================================
// 工具调用分组逻辑
// =============================================================================

type GroupedItem = { type: 'single'; entry: ThreadEntry } | { type: 'tool_group'; entries: ToolCallEntry[] };

function groupToolCalls(entries: ThreadEntry[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let currentToolGroup: ToolCallEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length === 1) {
      result.push({ type: 'single', entry: currentToolGroup[0] });
    } else if (currentToolGroup.length > 1) {
      result.push({ type: 'tool_group', entries: currentToolGroup });
    }
    currentToolGroup = [];
  };

  for (const entry of entries) {
    if (entry.type === 'tool_call') {
      currentToolGroup.push(entry);
    } else {
      flushToolGroup();
      result.push({ type: 'single', entry });
    }
  }
  flushToolGroup();

  return result;
}

function findLastUserMessageId(entries: ThreadEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'user_message') return entry.id;
  }
  return null;
}
