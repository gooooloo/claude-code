import { ArrowDownIcon, UserIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { cn } from '../../lib/utils';

// =============================================================================
// 会话滚动容器 — 静态回放版：初始定位到底部（最新进展），无平滑追尾
// =============================================================================

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden overflow-x-hidden', className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn('mx-auto flex max-w-3xl flex-col gap-2 px-4 py-6 sm:px-8 sm:py-10 min-w-0', className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string;
  description?: string;
};

export const ConversationEmptyState = ({
  className,
  title = '没有可展示的消息',
  description,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn('flex size-full flex-col items-center justify-center gap-4 p-8 text-center', className)}
    {...props}
  >
    {children ?? (
      <div className="space-y-2">
        <h3 className="font-semibold text-base font-display text-text-primary">{title}</h3>
        {description && <p className="text-text-muted text-sm leading-relaxed max-w-xs">{description}</p>}
      </div>
    )}
  </div>
);

// =============================================================================
// 滚动按钮 — 移动端友好的圆形悬浮按钮
// =============================================================================

const scrollButtonClass =
  'flex size-10 items-center justify-center rounded-full border border-border bg-surface-2 text-text-secondary shadow-sm transition-colors hover:text-text-primary active:bg-surface-1';

/** 标记最后一条用户消息的 data 属性，供「跳到最后提问」按钮定位 */
export const LAST_USER_MESSAGE_ATTR = 'data-last-user-message';

export type ConversationScrollButtonsProps = ComponentProps<'div'> & {
  hasUserMessages?: boolean;
};

export const ConversationScrollButtons = ({
  className,
  hasUserMessages = false,
  ...props
}: ConversationScrollButtonsProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToLastUserMessage = useCallback(() => {
    const lastUserMessage = document.querySelector(`[${LAST_USER_MESSAGE_ATTR}="true"]`);
    if (lastUserMessage) {
      lastUserMessage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  if (isAtBottom) return null;

  return (
    <div className={cn('absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2', className)} {...props}>
      {hasUserMessages && (
        <button
          type="button"
          className={scrollButtonClass}
          onClick={handleScrollToLastUserMessage}
          title="跳到最后提问"
        >
          <UserIcon className="size-4" />
        </button>
      )}
      <button type="button" className={scrollButtonClass} onClick={() => scrollToBottom()} title="回到底部">
        <ArrowDownIcon className="size-4" />
      </button>
    </div>
  );
};
