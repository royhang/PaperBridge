/**
 * Bridge to the native client shell:
 *  - Desktop client (Electron): runs a local CORS proxy on 127.0.0.1 + optional LAN share server.
 *  - Android APK (WebView): runs a native loopback CORS proxy on 127.0.0.1 + PDF intent & Downloads save bridge.
 * In a standard browser this is undefined and the user-configured proxy applies.
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
  /** PDFs handed to the app by the OS ("open with", double-click, Android share intent); subscribe once */
  onOpenFiles?: (callback: (files: { name: string; data: Uint8Array }[]) => void) => void;
  /** Local browser connector requests (127.0.0.1:23129, desktop only) */
  onConnectorRequest?: (handler: (action: string, payload: unknown) => Promise<unknown>) => void;
  /** Built-in LAN share server for iPadOS / Android reading & sync on the same Wi-Fi (desktop only) */
  lanShare?: {
    getStatus: () => Promise<LanShareStatus>;
    configure: (opts: { enabled?: boolean; port?: number }) => Promise<LanShareStatus>;
  };
  /** Native file save to Downloads (used by Android APK where blob: <a download> is unsupported) */
  saveFile?: (filename: string, data: Uint8Array, mimeType: string) => boolean;
}

interface AndroidNativeInterface {
  getProxyUrl: () => string;
  getProxyToken: () => string;
  getVersion: () => string;
  markReady: () => void;
  saveFile: (filename: string, base64Data: string, mimeType: string) => boolean;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(out);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedAndroidBridge: DesktopBridge | undefined;

export function desktop(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    paperbridgeDesktop?: DesktopBridge;
    PaperBridgeAndroid?: AndroidNativeInterface;
    __pbAndroidOpenFile?: (name: string, base64: string) => void;
  };
  if (w.paperbridgeDesktop) return w.paperbridgeDesktop;
  if (w.PaperBridgeAndroid) {
    if (!cachedAndroidBridge) {
      const native = w.PaperBridgeAndroid;
      cachedAndroidBridge = {
        proxyUrl: native.getProxyUrl(),
        proxyToken: native.getProxyToken(),
        version: native.getVersion(),
        platform: 'android',
        onOpenFiles(callback) {
          w.__pbAndroidOpenFile = (name: string, b64: string) => {
            try {
              callback([{ name, data: base64ToBytes(b64) }]);
            } catch (e) {
              console.warn('android open file failed', name, e);
            }
          };
          native.markReady();
        },
        saveFile(filename, data, mimeType) {
          return native.saveFile(filename, bytesToBase64(data), mimeType);
        },
      };
    }
    return cachedAndroidBridge;
  }
  return undefined;
}

/** The proxy every request should use: the native client's built-in one, else the configured one. */
export function effectiveProxy(configured: { proxyUrl: string; proxyToken: string }): { url: string; token: string; builtIn: boolean } {
  const d = desktop();
  return d && d.proxyUrl ? { url: d.proxyUrl, token: d.proxyToken, builtIn: true } : { url: configured.proxyUrl, token: configured.proxyToken, builtIn: false };
}
