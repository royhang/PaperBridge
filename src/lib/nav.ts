import { useTabs } from '../store/tabs';

export type SettingsSection = 'providers' | 'translate' | 'prompts' | 'proxy' | 'general' | 'data';

export function navigate(hash: string) {
  const docMatch = hash.match(/^#\/doc\/([^/?]+)(?:\?(.*))?/);
  if (docMatch) {
    const id = decodeURIComponent(docMatch[1]);
    const page = Number(new URLSearchParams(docMatch[2] ?? '').get('page')) || undefined;
    useTabs.getState().openDoc(id, { page });
    return;
  }
  if (hash.startsWith('#/notes')) {
    useTabs.getState().activateNotes();
    return;
  }
  useTabs.getState().activateLibrary();
}

export function openDocTab(docId: string, opts?: { title?: string; page?: number; background?: boolean }) {
  useTabs.getState().openDoc(docId, opts);
}

export function openSettings(section: SettingsSection = 'providers') {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: section }));
}
