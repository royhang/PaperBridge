/**
 * Bridge to the desktop client (Electron). The desktop app runs the CORS proxy itself on a random local
 * port with a random token and hands both to the page through the preload script; in a browser this is
 * undefined and the user-configured proxy applies.
 */
export interface LanAddress {
  name: string;
  address: string;
  url: string;
}

export interface LanShareStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  localUrl: string;
  urls: LanAddress[];
  primaryUrl: string;
  dataDir: string;
  error: string;
}

export interface DesktopBridge {
  proxyUrl: string;
  proxyToken: string;
  version: string;
  platform: string;
  /** PDFs handed to the app by the OS ("open with", double-click); subscribe once */
  onOpenFiles?: (callback: (files: { name: string; data: Uint8Array }[]) => void) => void;
  /** Local browser connector requests (127.0.0.1:23129) */
  onConnectorRequest?: (handler: (action: string, payload: unknown) => Promise<unknown>) => void;
  /** Built-in LAN share server for iPadOS / phone reading & sync on the same Wi-Fi */
  lanShare?: {
    getStatus: () => Promise<LanShareStatus>;
    configure: (opts: { enabled?: boolean; port?: number }) => Promise<LanShareStatus>;
  };
}

export function desktop(): DesktopBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { paperbridgeDesktop?: DesktopBridge }).paperbridgeDesktop;
}

/** The proxy every request should use: the desktop client's built-in one, else the configured one. */
export function effectiveProxy(configured: { proxyUrl: string; proxyToken: string }): { url: string; token: string; builtIn: boolean } {
  const d = desktop();
  return d ? { url: d.proxyUrl, token: d.proxyToken, builtIn: true } : { url: configured.proxyUrl, token: configured.proxyToken, builtIn: false };
}
