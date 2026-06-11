import { useState } from 'react';
import type { ToolCallData, ToolCallEntry } from '../../lib/types';
import { cn, truncate } from '../../lib/utils';

// =============================================================================
// 工具调用折叠组 — subtle card, left-border accent, compact layout
// =============================================================================

interface ToolCallGroupProps {
  entries: ToolCallEntry[];
}

export function ToolCallGroup({ entries }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  // 单个工具调用 — 默认折叠，不展开内容详情
  if (entries.length === 1) {
    return (
      <div className="pl-10 sm:pl-11">
        <SingleToolCard tool={entries[0].toolCall} compact />
      </div>
    );
  }

  // 多个工具调用 — 折叠组
  const summary = buildSummary(entries);

  return (
    <div className="pl-10 sm:pl-11">
      <div className="rounded-lg border border-border bg-surface-2/50 overflow-hidden">
        {/* 折叠头 */}
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-surface-1/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className={cn('flex-shrink-0 transition-transform text-text-muted', expanded && 'rotate-90')}
          >
            <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-left text-xs text-text-muted font-display">{summary}</span>
        </button>

        {/* 展开内容 */}
        {expanded && (
          <div className="border-t border-border divide-y divide-border">
            {entries.map((entry, i) => (
              <SingleToolCard key={entry.toolCall.id || i} tool={entry.toolCall} compact />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 单个工具卡片 — compact, inline status
// =============================================================================

interface SingleToolCardProps {
  tool: ToolCallData;
  compact?: boolean;
}

function SingleToolCard({ tool, compact }: SingleToolCardProps) {
  const [expanded, setExpanded] = useState(!compact);

  const statusIcon = (() => {
    switch (tool.status) {
      case 'complete':
        return <span className="text-status-active text-[10px]">&#10003;</span>;
      case 'error':
        return <span className="text-status-error text-[10px]">&#10005;</span>;
      case 'canceled':
        return <span className="text-text-muted text-[10px]">&#8212;</span>;
      default:
        return null;
    }
  })();

  const hasDetails = !!tool.output || (tool.rawInput && Object.keys(tool.rawInput).length > 0);

  return (
    <div className={cn('px-3 py-2', compact && 'py-1.5')}>
      {/* 标题行 — 单行紧凑 */}
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left group"
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        {statusIcon}
        <span className="text-xs font-display font-medium text-text-secondary group-hover:text-text-primary transition-colors truncate">
          {tool.title}
        </span>
        {tool.status === 'canceled' && <span className="text-[10px] text-text-muted">未完成</span>}
      </button>

      {/* 展开详情 */}
      {expanded && hasDetails && (
        <div className="mt-1.5 ml-4 space-y-1.5">
          {tool.rawInput && Object.keys(tool.rawInput).length > 0 && (
            <pre className="text-[11px] bg-surface-1 rounded-md p-2 overflow-x-auto font-mono max-h-36 text-text-secondary">
              {truncate(JSON.stringify(tool.rawInput, null, 2), 2000)}
            </pre>
          )}
          {tool.output && (
            <pre
              className={cn(
                'text-[11px] rounded-md p-2 overflow-x-auto font-mono max-h-36',
                tool.status === 'error' ? 'bg-status-error/10 text-status-error' : 'bg-surface-1 text-text-secondary',
              )}
            >
              {truncate(tool.output, 2000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// 工具函数
// =============================================================================

/** 构建统计摘要 */
function buildSummary(entries: ToolCallEntry[]): string {
  const toolCounts = new Map<string, number>();
  for (const entry of entries) {
    const name = simplifyToolName(entry.toolCall.title);
    toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [name, count] of toolCounts) {
    parts.push(count === 1 ? name : `${count} 次${name}`);
  }

  if (parts.length === 0) return `${entries.length} 个工具调用`;
  if (parts.length === 1) return parts[0];
  return `${entries.length} 个工具: ${parts.join('、')}`;
}

/** 简化工具名称 */
function simplifyToolName(title: string): string {
  const match = title.match(/^(\w+)/);
  return match ? match[1] : title;
}
