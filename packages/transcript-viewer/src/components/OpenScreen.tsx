import { FileUpIcon } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { ClaudeMark } from './chat/MessageBubble';

// =============================================================================
// 打开页 — 文件选择 + 拖拽导入 JSONL
// =============================================================================

interface OpenScreenProps {
  onFiles: (files: FileList | File[]) => void;
  busy?: boolean;
}

export function OpenScreen({ onFiles, busy }: OpenScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length > 0) {
        onFiles(e.dataTransfer.files);
      }
    },
    [onFiles],
  );

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      {/* 品牌区 */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-brand/8">
          <ClaudeMark size={32} />
        </div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Claude Code Transcripts</h1>
        <p className="max-w-sm text-sm leading-relaxed text-text-muted">
          本地渲染 Claude Code 的 JSONL 会话记录。文件只在浏览器里解析，不会上传到任何地方。
        </p>
      </div>

      {/* 导入区 */}
      <button
        type="button"
        disabled={busy}
        className={cn(
          'flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 transition-colors',
          dragging ? 'border-brand bg-brand/5' : 'border-border bg-surface-1/50 hover:border-brand/40',
          busy && 'opacity-60',
        )}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <FileUpIcon className="size-8 text-text-muted" />
        <div className="space-y-1 text-center">
          <p className="font-display text-sm font-medium text-text-primary">{busy ? '解析中…' : '选择 JSONL 文件'}</p>
          <p className="text-xs text-text-muted">支持多选，也可以直接拖进来</p>
        </div>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".jsonl,application/jsonl,text/plain"
        multiple
        hidden
        onChange={e => {
          if (e.target.files && e.target.files.length > 0) {
            onFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* 来源提示 */}
      <p className="max-w-md text-center text-xs leading-relaxed text-text-muted">
        会话文件位于电脑的 <code className="font-mono">~/.claude/projects/&lt;项目&gt;/&lt;sessionId&gt;.jsonl</code>
        ，可通过 iCloud、AirDrop 或任意同步工具传到手机。
      </p>
    </div>
  );
}
