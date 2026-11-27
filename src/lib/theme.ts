import { useSyncExternalStore } from 'react';
import type { PdfTheme, Theme } from '../store/settings';

export type ResolvedPdfTheme = 'original' | 'dim' | 'dark';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

function getSystemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function subscribeSystemDark(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_MEDIA_QUERY);
  mq.addEventListener?.('change', cb);
  return () => mq.removeEventListener?.('change', cb);
}

/** Reactive boolean reflecting the OS dark-mode preference. */
export function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeSystemDark, getSystemDark, () => false);
}

/** Whether the UI is currently rendered in dark mode for the given setting and OS preference. */
export function resolveIsDark(theme: Theme, systemDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark);
}

/** Reactive boolean for whether the app is currently rendered in dark mode. */
export function useResolvedDark(theme: Theme): boolean {
  const sysDark = useSystemDark();
  return resolveIsDark(theme, sysDark);
}

/** Direct one-click Light <-> Dark toggle based on actual currently displayed mode (never a dead click). */
export function toggleAppTheme(theme: Theme, systemDark: boolean): 'light' | 'dark' {
  return resolveIsDark(theme, systemDark) ? 'light' : 'dark';
}

/** Resolve the effective visual PDF paper theme ('original' | 'dim' | 'dark'). */
export function resolvePdfTheme(pdfTheme: PdfTheme, isDark: boolean): ResolvedPdfTheme {
  return pdfTheme === 'auto' ? (isDark ? 'dark' : 'original') : pdfTheme;
}

/**
 * Cycle through the 3 visually distinct PDF paper modes (original -> dim -> dark -> original)
 * so every click always produces an immediate visible change, storing 'auto' whenever the target
 * matches the current app theme's natural default.
 */
export function nextPdfTheme(pdfTheme: PdfTheme, isDark: boolean): PdfTheme {
  const cur = resolvePdfTheme(pdfTheme, isDark);
  const order: readonly ResolvedPdfTheme[] = ['original', 'dim', 'dark'];
  const target = order[(order.indexOf(cur) + 1) % order.length];
  const naturalDefault: ResolvedPdfTheme = isDark ? 'dark' : 'original';
  return target === naturalDefault ? 'auto' : target;
}
