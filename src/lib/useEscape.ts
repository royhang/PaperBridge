import { useEffect, useRef } from 'react';

/**
 * Escape closes only the top-most layer. Layers with a higher `level`
 * (dialogs = 10) always win over lower ones (side panels = 0), regardless of
 * mount order; within a level the most recently opened wins. One global
 * listener; handlers are read through refs so re-renders never detach
 * listeners mid-dispatch.
 */
interface Entry {
  ref: { current: () => void };
  level: number;
  seq: number;
}
const stack: Entry[] = [];
let seq = 0;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing || !stack.length) return;
  const top = stack.reduce((a, b) => (b.level > a.level || (b.level === a.level && b.seq > a.seq) ? b : a));
  top.ref.current();
}

export const LAYER_DIALOG = 10;
export const LAYER_PANEL = 0;

export function useEscape(handler: () => void, level = LAYER_DIALOG, enabled = true) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    if (!stack.length) window.addEventListener('keydown', onKeyDown);
    const entry: Entry = { ref, level, seq: ++seq };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, level]);
}
