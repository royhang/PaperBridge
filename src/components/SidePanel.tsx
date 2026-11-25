import { useEffect, useRef, useState } from 'react';
import { useReader, type SideTab } from '../store/reader';
import { ChatPanel } from './panels/ChatPanel';
import { GlossaryPanel } from './panels/GlossaryPanel';
import { NotesPanel } from './panels/NotesPanel';
import { ParallelPanel } from './panels/ParallelPanel';
import { TranslatePanel } from './panels/TranslatePanel';

const TABS: { id: SideTab; label: string }[] = [
  { id: 'translate', label: '翻译' },
  { id: 'parallel', label: '对照' },
  { id: 'chat', label: '问答' },
  { id: 'notes', label: '笔记' },
  { id: 'glossary', label: '术语' },
];

const WIDTH_KEY = 'paperbridge.sideWidth';

function loadWidth() {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v >= 300) return v;
  } catch {
    /* storage unavailable */
  }
  return Math.min(460, Math.round(window.innerWidth * 0.36));
}

export function SidePanel() {
  const open = useReader((s) => s.sideOpen);
  const tab = useReader((s) => s.sideTab);
  const setTab = useReader((s) => s.setSideTab);
  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      setWidth(Math.max(300, Math.min(window.innerWidth * 0.7, s.w + (s.x - e.clientX))));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
      /* ignore */
    }
  }, [dragging, width]);

  if (!open) return null;
  return (
    <aside className="side" style={{ width }}>
      <div
        className={`side-resizer${dragging ? ' dragging' : ''}`}
        onPointerDown={(e) => {
          startRef.current = { x: e.clientX, w: width };
          setDragging(true);
          e.preventDefault();
        }}
      />
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {/* Keep chat & translate mounted so streaming continues when switching tabs */}
      <div className="panel-col" style={{ display: tab === 'translate' ? undefined : 'none' }}>
        <TranslatePanel />
      </div>
      <div className="panel-col" style={{ display: tab === 'chat' ? undefined : 'none' }}>
        <ChatPanel />
      </div>
      {tab === 'parallel' && <ParallelPanel />}
      {tab === 'notes' && <NotesPanel />}
      {tab === 'glossary' && <GlossaryPanel />}
    </aside>
  );
}
