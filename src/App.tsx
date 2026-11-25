import { useEffect, useState } from 'react';
import { LibraryPage } from './components/library/LibraryPage';
import { NotesOverview } from './components/library/NotesOverview';
import { Reader } from './components/Reader';
import { SettingsDialog } from './components/SettingsDialog';
import { desktop } from './lib/desktop';
import type { SettingsSection } from './lib/nav';
import { importPdfBytes } from './library/service';
import { useSettings } from './store/settings';

function useHashRoute() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const theme = useSettings((s) => s.theme);
  const fontSize = useSettings((s) => s.readerFontSize);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--reader-font', `${fontSize}px`);
  }, [fontSize]);

  // desktop client: PDFs opened from the OS are imported and shown in the reader
  useEffect(() => {
    desktop()?.onOpenFiles?.(async (files) => {
      let last: string | undefined;
      for (const f of files) {
        try {
          const data = f.data.slice().buffer as ArrayBuffer;
          last = (await importPdfBytes(data, f.name)).docId;
        } catch (e) {
          console.warn('open failed', f.name, e);
        }
      }
      if (last) location.hash = `#/doc/${encodeURIComponent(last)}`;
    });
  }, []);

  useEffect(() => {
    const open = (e: Event) => setSettingsOpen(((e as CustomEvent).detail as SettingsSection) ?? 'providers');
    window.addEventListener('open-settings', open);
    return () => window.removeEventListener('open-settings', open);
  }, []);

  const docMatch = hash.match(/^#\/doc\/([^/?]+)(?:\?(.*))?/);
  const initialPage = Number(new URLSearchParams(docMatch?.[2] ?? '').get('page')) || undefined;

  return (
    <>
      {docMatch ? (
        <Reader key={hash} docId={decodeURIComponent(docMatch[1])} initialPage={initialPage} />
      ) : hash.startsWith('#/notes') ? (
        <NotesOverview />
      ) : (
        <LibraryPage />
      )}
      {settingsOpen && <SettingsDialog initial={settingsOpen} onClose={() => setSettingsOpen(null)} />}
    </>
  );
}

