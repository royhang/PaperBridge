import { useEffect, useState } from 'react';
import { LibraryPage } from './components/library/LibraryPage';
import { NotesOverview } from './components/library/NotesOverview';
import { Reader } from './components/Reader';
import { SettingsDialog } from './components/SettingsDialog';
import { TabBar } from './components/TabBar';
import { desktop } from './lib/desktop';
import type { SettingsSection } from './lib/nav';
import { importPdfBytes } from './library/service';
import { initAutoSync } from './services/sync';
import { useSettings } from './store/settings';
import { useTabs } from './store/tabs';

function applyHash(hash: string) {
  const docMatch = hash.match(/^#\/doc\/([^/?]+)(?:\?(.*))?/);
  if (docMatch) {
    const id = decodeURIComponent(docMatch[1]);
    const page = Number(new URLSearchParams(docMatch[2] ?? '').get('page')) || undefined;
    useTabs.getState().openDoc(id, { page });
    return true;
  }
  if (hash.startsWith('#/notes')) {
    useTabs.getState().activateNotes();
    return true;
  }
  if (hash === '#/' || hash === '#') {
    useTabs.getState().activateLibrary();
    return true;
  }
  return false;
}

export default function App() {
  const active = useTabs((s) => s.active);
  const lastDocId = useTabs((s) => s.lastDocId);
  const theme = useSettings((s) => s.theme);
  const fontSize = useSettings((s) => s.readerFontSize);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);

  // Sync URL hash with multi-tab workspace on mount and browser Back/Forward
  useEffect(() => {
    if (location.hash) applyHash(location.hash);
    const onHash = () => {
      if (!applyHash(location.hash)) useTabs.getState().activateLibrary();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--reader-font', `${fontSize}px`);
  }, [fontSize]);

  // Update browser/window title for Library & Notes tabs
  useEffect(() => {
    if (active.kind === 'library') document.title = 'PaperBridge · 我的文库';
    else if (active.kind === 'notes') document.title = 'PaperBridge · 全部笔记';
  }, [active]);

  // Global Zotero-like tab shortcuts: Alt+1 (Library), Alt+2..9 (doc tabs), Alt+[/] (prev/next), Alt+W (close tab)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const st = useTabs.getState();

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === '1') {
          e.preventDefault();
          st.activateLibrary();
          return;
        }
        const digit = Number(e.key);
        if (digit >= 2 && digit <= 9) {
          const target = st.tabs[digit - 2];
          if (target) {
            e.preventDefault();
            st.activateDoc(target.docId);
          }
          return;
        }
        if (e.key === '[' || e.key === ']') {
          const order: ({ kind: 'library' } | { kind: 'notes' } | { kind: 'doc'; docId: string })[] = [
            { kind: 'library' },
            { kind: 'notes' },
            ...st.tabs.map((t) => ({ kind: 'doc' as const, docId: t.docId })),
          ];
          const curIdx = order.findIndex((o) =>
            o.kind === st.active.kind && (o.kind !== 'doc' || (st.active.kind === 'doc' && o.docId === st.active.docId)),
          );
          const next = order[(curIdx + (e.key === ']' ? 1 : order.length - 1)) % order.length];
          if (next) {
            e.preventDefault();
            if (next.kind === 'library') st.activateLibrary();
            else if (next.kind === 'notes') st.activateNotes();
            else st.activateDoc(next.docId);
          }
          return;
        }
        if (e.key.toLowerCase() === 'w' && st.active.kind === 'doc') {
          e.preventDefault();
          st.closeTab(st.active.docId);
          return;
        }
      }

      // Desktop client: Ctrl/Cmd+W closes active doc tab instead of closing the app window
      if (desktop() && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'w' && st.active.kind === 'doc') {
        e.preventDefault();
        st.closeTab(st.active.docId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Desktop client: PDFs opened from the OS are imported and opened as tabs
  useEffect(() => {
    desktop()?.onOpenFiles?.(async (files) => {
      const opened: { id: string; title: string }[] = [];
      for (const f of files) {
        try {
          const data = f.data.slice().buffer as ArrayBuffer;
          const res = await importPdfBytes(data, f.name);
          opened.push({ id: res.docId, title: res.title });
        } catch (e) {
          console.warn('open failed', f.name, e);
        }
      }
      opened.forEach((o, i) => {
        useTabs.getState().openDoc(o.id, { title: o.title, background: i < opened.length - 1 });
      });
    });
  }, []);

  useEffect(() => {
    initAutoSync();
  }, []);

  useEffect(() => {
    const open = (e: Event) => setSettingsOpen(((e as CustomEvent).detail as SettingsSection) ?? 'providers');
    window.addEventListener('open-settings', open);
    return () => window.removeEventListener('open-settings', open);
  }, []);

  const mountedDocId = active.kind === 'doc' ? active.docId : lastDocId;

  return (
    <div className="app-shell">
      <TabBar />
      <div className="app-stage">
        {/* Keep Library mounted so scroll position, search, and selection persist across tab switches */}
        <div className="stage-pane" style={{ display: active.kind === 'library' ? 'flex' : 'none' }}>
          <LibraryPage />
        </div>
        {active.kind === 'notes' && (
          <div className="stage-pane">
            <NotesOverview />
          </div>
        )}
        {/* Keep active/recent Reader mounted while peeking at Library/Notes so translation keeps running */}
        {mountedDocId && (
          <div className="stage-pane" style={{ display: active.kind === 'doc' ? 'flex' : 'none' }}>
            <Reader key={mountedDocId} docId={mountedDocId} active={active.kind === 'doc'} />
          </div>
        )}
      </div>
      {settingsOpen && <SettingsDialog initial={settingsOpen} onClose={() => setSettingsOpen(null)} />}
    </div>
  );
}
