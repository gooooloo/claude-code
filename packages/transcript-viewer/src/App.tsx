import { ChevronLeftIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { OpenScreen } from './components/OpenScreen';
import { SessionList } from './components/SessionList';
import { SessionView } from './components/SessionView';
import { ThemeToggle } from './components/ThemeToggle';
import { parseSessionFile } from './lib/jsonl';
import type { ParsedSession } from './lib/types';

// =============================================================================
// App — 打开页 / 会话列表 / 会话视图 三态切换
// =============================================================================

export function App() {
  const [sessions, setSessions] = useState<Map<string, ParsedSession>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setBusy(true);
    try {
      const list = Array.from(files);
      const parsed: ParsedSession[] = [];
      for (const file of list) {
        const text = await file.text();
        const session = parseSessionFile(file.name, text);
        // 跳过完全没有内容的文件（如纯 metadata）
        if (session.entries.length > 0 || session.messageCount > 0) {
          parsed.push(session);
        }
      }
      if (parsed.length > 0) {
        setSessions(prev => {
          const next = new Map(prev);
          for (const session of parsed) next.set(session.id, session);
          return next;
        });
        // 只导入一个文件时直接进入会话
        if (parsed.length === 1) {
          setActiveId(parsed[0].id);
        }
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const active = activeId ? sessions.get(activeId) : undefined;

  if (sessions.size === 0) {
    return <OpenScreen onFiles={handleFiles} busy={busy} />;
  }

  return (
    <div className="flex h-dvh flex-col">
      {/* 顶栏 */}
      <header className="flex items-center gap-2 border-b border-border bg-surface-0/90 px-2 py-2 backdrop-blur sm:px-4">
        {active ? (
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
            onClick={() => setActiveId(null)}
            title="返回会话列表"
          >
            <ChevronLeftIcon className="size-5" />
          </button>
        ) : (
          <div className="size-9" />
        )}
        <h1 className="min-w-0 flex-1 truncate text-center font-display text-sm font-medium text-text-primary">
          {active ? (active.title ?? active.fileName) : '会话'}
        </h1>
        <ThemeToggle />
      </header>

      {/* 主体 */}
      {active ? (
        <SessionView key={active.id} session={active} />
      ) : (
        <SessionList sessions={[...sessions.values()]} onSelect={setActiveId} onFiles={handleFiles} />
      )}
    </div>
  );
}
