import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { PlanDisplayEntry, PlanItemStatus } from '../../lib/types';
import { cn } from '../../lib/utils';

// =============================================================================
// Plan 展示组件 — 任务列表快照可视化
// =============================================================================

interface PlanDisplayProps {
  entry: PlanDisplayEntry;
}

export function PlanDisplay({ entry }: PlanDisplayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { items } = entry;

  if (items.length === 0) return null;

  const completed = items.filter(e => e.status === 'completed').length;
  const total = items.length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="pl-10 sm:pl-11">
      <div className="rounded-xl border border-border bg-brand/5 overflow-hidden">
        {/* Header */}
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-surface-1/50 transition-colors"
          onClick={() => setCollapsed(!collapsed)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className={cn('transition-transform text-text-muted flex-shrink-0', collapsed && 'rotate-90')}
          >
            <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>

          <span className="text-xs font-display font-medium text-text-secondary">任务列表</span>

          <span className="text-[10px] text-text-muted font-mono">
            {completed}/{total}
          </span>

          {/* Progress bar */}
          <div className="flex-1 h-1 rounded-full bg-surface-1 overflow-hidden ml-1 mr-2">
            <div
              className="h-full rounded-full bg-brand/70 transition-all duration-500"
              style={{ width: `${percentage}%` }}
            />
          </div>

          <span className="text-[10px] text-text-muted font-mono">{percentage}%</span>
        </button>

        {/* Item list */}
        {!collapsed && (
          <div
            className={cn('border-t border-border px-3 py-1.5 space-y-0.5', total > 5 && 'max-h-64 overflow-y-auto')}
          >
            {items.map((item, i) => (
              <div key={`${entry.id}-item-${i}`} className="flex items-start gap-2 py-1.5 px-1">
                <span className="flex-shrink-0 mt-0.5">
                  <StatusIcon status={item.status} />
                </span>
                <span
                  className={cn(
                    'text-xs leading-relaxed flex-1',
                    item.status === 'completed' ? 'text-text-muted line-through' : 'text-text-secondary',
                    item.status === 'in_progress' && 'text-text-primary font-medium',
                  )}
                >
                  {item.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: PlanItemStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-status-active" />;
    case 'in_progress':
      return <Loader2 className="h-3.5 w-3.5 text-brand" />;
    case 'pending':
      return <Circle className="h-3.5 w-3.5 text-text-muted" />;
  }
}
