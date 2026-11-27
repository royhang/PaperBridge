import { create } from 'zustand';
import { desktop } from './desktop';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaStore {
  canInstall: boolean;
  installed: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;

function isStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    Boolean(window.matchMedia?.('(display-mode: standalone)').matches) ||
    Boolean(window.matchMedia?.('(display-mode: fullscreen)').matches) ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export const usePwaInstall = create<PwaStore>((set) => ({
  canInstall: false,
  installed: isStandaloneMode(),
  promptInstall: async () => {
    if (!deferredPrompt) return 'unavailable';
    const ev = deferredPrompt;
    deferredPrompt = null;
    set({ canInstall: false });
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === 'accepted') set({ installed: true });
    return outcome;
  },
}));

export function initPwa() {
  if (initialized || typeof window === 'undefined' || desktop()) return;
  initialized = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    usePwaInstall.setState({ canInstall: true });
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    usePwaInstall.setState({ canInstall: false, installed: true });
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        /* ignore registration errors on unsupported origins */
      });
    });
  }
}
