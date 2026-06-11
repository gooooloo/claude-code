import { SendIcon, SquareIcon } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';

// =============================================================================
// 输入栏 — 移动端优先：大触控目标 + 安全区
// =============================================================================

interface InputBarProps {
  busy?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

export function InputBar({ busy, placeholder, onSend, onInterrupt }: InputBarProps) {
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="border-t border-border bg-surface-0/95 px-3 py-2 backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-border bg-surface-1 px-4 py-2.5 text-sm leading-relaxed text-text-primary placeholder:text-text-muted focus:border-brand/50 focus:outline-none"
          rows={1}
          placeholder={placeholder ?? '发送消息…'}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            // 桌面回车发送；手机软键盘回车默认换行（mobile 没有 metaKey）
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy && (
          <button
            type="button"
            className="flex size-[42px] flex-shrink-0 items-center justify-center rounded-xl border border-status-error/40 text-status-error transition-colors hover:bg-status-error/10"
            onClick={onInterrupt}
            title="中断（Ctrl-C）"
          >
            <SquareIcon className="size-4" />
          </button>
        )}
        <button
          type="button"
          disabled={!text.trim()}
          className={cn(
            'flex size-[42px] flex-shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-opacity',
            !text.trim() && 'opacity-40',
          )}
          onClick={submit}
          title="发送"
        >
          <SendIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
