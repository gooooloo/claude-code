import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useState } from 'react';
import { cn } from '../../lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

// =============================================================================
// 思考过程折叠块 — RCS Reasoning 的静态精简版（只读回放无 streaming）
// =============================================================================

interface ReasoningContextValue {
  isOpen: boolean;
}

const ReasoningContext = createContext<ReasoningContextValue>({ isOpen: false });

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  defaultOpen?: boolean;
};

export const Reasoning = memo(({ className, defaultOpen = false, children, ...props }: ReasoningProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <ReasoningContext.Provider value={{ isOpen }}>
      <Collapsible className={cn('not-prose mb-4', className)} onOpenChange={setIsOpen} open={isOpen} {...props}>
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
});

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

export const ReasoningTrigger = memo(({ className, children, ...props }: ReasoningTriggerProps) => {
  const { isOpen } = useContext(ReasoningContext);

  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full items-center gap-2 text-text-muted text-sm transition-colors hover:text-text-primary',
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <BrainIcon className="size-4" />
          <p>思考过程</p>
          <ChevronDownIcon className={cn('size-4 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')} />
        </>
      )}
    </CollapsibleTrigger>
  );
});

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: ReactNode;
};

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => (
  <CollapsibleContent className={cn('mt-4 text-sm text-text-secondary outline-none', className)} {...props}>
    {children}
  </CollapsibleContent>
));

Reasoning.displayName = 'Reasoning';
ReasoningTrigger.displayName = 'ReasoningTrigger';
ReasoningContent.displayName = 'ReasoningContent';
