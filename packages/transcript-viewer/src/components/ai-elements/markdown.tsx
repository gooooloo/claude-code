import { lazy, memo, Suspense } from 'react';
import { cn } from '../../lib/utils';

// Streamdown 较重（内置 shiki 高亮），懒加载并在加载期间用纯文本兜底
const LazyStreamdown = lazy(() => import('streamdown').then(m => ({ default: m.Streamdown })));

export type MessageResponseProps = {
  children?: string;
  className?: string;
};

export const MessageResponse = memo(
  ({ className, children, ...props }: MessageResponseProps) => (
    <Suspense fallback={<div className={cn('whitespace-pre-wrap break-words', className)}>{children}</div>}>
      <LazyStreamdown
        className={cn(
          'size-full break-words [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          className,
        )}
        {...props}
      >
        {children}
      </LazyStreamdown>
    </Suspense>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = 'MessageResponse';
