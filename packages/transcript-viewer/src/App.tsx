import { ChevronLeftIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { HomeScreen } from './components/HomeScreen';
import { LiveSessionView } from './components/LiveSessionView';
import { RemoteSessionList } from './components/RemoteSessionList';
import { SessionView } from './components/SessionView';
import { ThemeToggle } from './components/ThemeToggle';
import { type ConnectionConfig, loadConnections, saveConnections } from './lib/connections';
import { parseSessionFile } from './lib/jsonl';
import type { RemoteSessionInfo } from './lib/protocol';
import type { ParsedSession } from './lib/types';

// =============================================================================
// App — 首页（连接 + 本地）/ 远程会话列表 / 会话视图（本地或实时）
// =============================================================================

type View =
  | { kind: 'home' }
  | { kind: 'remote-list'; connId: string }
  | { kind: 'local-session'; id: string }
  | { kind: 'live-session'; connId: string; session: RemoteSessionInfo };

export function App() {
  const [connections, setConnections] = useState<ConnectionConfig[]>(() => loadConnections());
  const [localSessions, setLocalSessions] = useState<Map<string, ParsedSession>>(new Map());
  const [view, setView] = useState<View>({ kind: 'home' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    saveConnections(connections);
  }, [connections]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setBusy(true);
    try {
      const parsed: ParsedSession[] = [];
      for (const file of Array.from(files)) {
        const text = await file.text();
        const session = parseSessionFile(file.name, text);
        if (session.entries.length > 0 || session.messageCount > 0) {
          parsed.push(session);
        }
      }
      if (parsed.length > 0) {
        setLocalSessions(prev => {
          const next = new Map(prev);
          for (const session of parsed) next.set(session.id, session);
          return next;
        });
        if (parsed.length === 1) {
          setView({ kind: 'local-session', id: parsed[0].id });
        }
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // Android 返回键/浏览器返回的朴素支持：视图入栈
  useEffect(() => {
    if (view.kind !== 'home') {
      window.history.pushState({ view: view.kind }, '');
    }
    const onPop = () => {
      setView(current => {
        if (current.kind === 'live-session') {
          return { kind: 'remote-list', connId: current.connId };
        }
        return { kind: 'home' };
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [view]);

  const goBack = () => window.history.back();

  // ---- 视图解析 ----
  const conn =
    view.kind === 'remote-list' || view.kind === 'live-session'
      ? connections.find(c => c.id === view.connId)
      : undefined;
  const localSession = view.kind === 'local-session' ? localSessions.get(view.id) : undefined;

  const title = (() => {
    switch (view.kind) {
      case 'home':
        return null;
      case 'remote-list':
        return conn?.name || conn?.baseUrl || '连接';
      case 'local-session':
        return localSession?.title ?? localSession?.fileName ?? '会话';
      case 'live-session':
        return view.session.title ?? view.session.sessionId.slice(0, 8);
    }
  })();

  return (
    <div className="flex h-dvh flex-col">
      {/* 顶栏 */}
      <header className="flex items-center gap-2 border-b border-border bg-surface-0/90 px-2 py-2 backdrop-blur sm:px-4">
        {view.kind !== 'home' ? (
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
            onClick={goBack}
            title="返回"
          >
            <ChevronLeftIcon className="size-5" />
          </button>
        ) : (
          <div className="size-9" />
        )}
        <h1 className="min-w-0 flex-1 truncate text-center font-display text-sm font-medium text-text-primary">
          {title ?? ' '}
        </h1>
        <ThemeToggle />
      </header>

      {/* 主体 */}
      {view.kind === 'home' && (
        <HomeScreen
          connections={connections}
          localSessions={[...localSessions.values()]}
          busy={busy}
          onAddConnection={c => setConnections(prev => [...prev, c])}
          onRemoveConnection={id => setConnections(prev => prev.filter(c => c.id !== id))}
          onOpenConnection={connId => setView({ kind: 'remote-list', connId })}
          onOpenLocalSession={id => setView({ kind: 'local-session', id })}
          onFiles={handleFiles}
        />
      )}
      {view.kind === 'remote-list' && conn && (
        <RemoteSessionList
          conn={conn}
          onSelect={session => setView({ kind: 'live-session', connId: conn.id, session })}
        />
      )}
      {view.kind === 'local-session' && localSession && <SessionView key={localSession.id} session={localSession} />}
      {view.kind === 'live-session' && conn && (
        <LiveSessionView
          key={`${view.session.projectKey}/${view.session.sessionId}`}
          conn={conn}
          session={view.session}
        />
      )}
    </div>
  );
}
