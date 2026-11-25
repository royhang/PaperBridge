import { desktop } from '../lib/desktop';

const REPO = 'royhang/PaperBridge';
const CACHE_KEY = 'paperbridge-update-check';
const CHECK_INTERVAL_MS = 12 * 3600_000;

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string;
  notes?: string;
  checkedAt: number;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export async function checkForUpdates(opts: { force?: boolean } = {}): Promise<UpdateInfo | null> {
  const d = desktop();
  const current = d?.version ?? '0.3.0';

  if (!opts.force) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as UpdateInfo | null;
      if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS && cached.current === current) {
        return cached;
      }
    } catch {
      /* ignore cache errors */
    }
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`检查更新失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
  const latest = (data.tag_name ?? '').replace(/^v/i, '');
  if (!latest) return null;
  const info: UpdateInfo = {
    current,
    latest,
    hasUpdate: isNewerVersion(latest, current),
    url: data.html_url || `https://github.com/${REPO}/releases/latest`,
    notes: data.body?.slice(0, 400),
    checkedAt: Date.now(),
  };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(info));
  } catch {
    /* ignore */
  }
  return info;
}
