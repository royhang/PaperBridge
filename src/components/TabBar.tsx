import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/db';
import { authorsShort } from '../library/format';
import { desktop } from '../lib/desktop';
import { openSettings } from '../lib/nav';
import { syncNow } from '../services/sync';
import { checkForUpdates, type UpdateInfo } from '../services/update';
import { useReader } from '../store/reader';
import { useSettings } from '../store/settings';
import { useSync } from '../store/sync';
import { useTabs } from '../store/tabs';
import { Icon } from './Icon';

export function TabBar() {
  const docs = useLiveQuery(() => db.docs.toArray(), []);
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.active);
  const activateLibrary = useTabs((s) => s.activateLibrary);
  const activateNotes = useTabs((s) => s.activateNotes);
  const activateDoc = useTabs((s) => s.activateDoc);
  const closeTab = useTabs((s) => s.closeTab);
  const closeOthers = useTabs((s) => s.closeOthers);
  const closeAll = useTabs((s) => s.closeAll);
  const moveTab = useTabs((s) => s.moveTab);
  const pruneMissing = useTabs((s) => s.pruneMissing);
  const runningDocId = useReader((s) => (s.fullTextRunning ? s.docId : null));
  const theme = useSettings((s) => s.theme);
  const setSettings = useSettings((s) => s.set);
  const syncUser = useSync((s) => s.username);
  const syncToken = useSync((s) => s.token);
  const syncStatus = useSync((s) => s.status);
  const syncProgress = useSync((s) => s.progress);
  const blobProgress = useSync((s) => s.blobProgress);
  const syncErr = useSync((s) => s.lastError);
  const lastSyncAt = useSync((s) => s.lastSyncAt);

  const stripRef = useRef<HTMLDivElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Desktop client: check GitHub Release silently once every 12h
  useEffect(() => {
    if (!desktop()) return;
    void checkForUpdates().then((info) => info?.hasUpdate && setUpdateInfo(info)).catch(() => {});
  }, []);

  const docMap = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs]);

  // Automatically close tabs whose document was deleted or moved to trash (locally or via cloud sync)
  useEffect(() => {
    if (!docs) return;
    pruneMissing(new Set(docs.filter((d) => !d.deletedAt).map((d) => d.id)));
  }, [docs, pruneMissing]);

  // Keep active tab scrolled into view
  const activeDocId = active.kind === 'doc' ? active.docId : null;
  useEffect(() => {
    if (!activeDocId || !stripRef.current) return;
    const el = stripRef.current.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeDocId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeDocId]);

  // Dismiss tab overflow menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <header className="tabbar" role="tablist" aria-label="工作区标签页">
      <div className="tabbar-brand" onClick={activateLibrary} title="PaperBridge · 我的文库">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="24" height="24" style={{ display: 'block' }}>
            <defs>
              <linearGradient id="pb-brand-bg" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#0a1638" />
                <stop offset="55%" stopColor="#173896" />
                <stop offset="100%" stopColor="#2e6cf6" />
              </linearGradient>
              <linearGradient id="pb-brand-page" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.96" />
                <stop offset="100%" stopColor="#cbd8f7" stopOpacity="0.72" />
              </linearGradient>
            </defs>
            <rect width="64" height="64" rx="14.5" fill="url(#pb-brand-bg)" />
            <rect x="13" y="16" width="17.5" height="32" rx="3" fill="url(#pb-brand-page)" />
            <rect x="33.5" y="16" width="17.5" height="32" rx="3" fill="url(#pb-brand-page)" opacity="0.86" />
            <rect x="16.5" y="36" width="10.5" height="2.2" rx="1.1" fill="#ffffff" opacity="0.92" />
            <rect x="16.5" y="40.5" width="7.5" height="2.2" rx="1.1" fill="#ffffff" opacity="0.78" />
            <rect x="37" y="36" width="10.5" height="2.2" rx="1.1" fill="#ffffff" opacity="0.92" />
            <rect x="37" y="40.5" width="7.5" height="2.2" rx="1.1" fill="#ffffff" opacity="0.78" />
            <path d="M21.8 31.5 C21.8 20.5 42.2 20.5 42.2 31.5" fill="none" stroke="#ffffff" strokeWidth="3.6" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* Pinned Library tab (like Zotero's My Library tab) */}
      <button
        role="tab"
        aria-selected={active.kind === 'library'}
        className={`wtab pinned${active.kind === 'library' ? ' active' : ''}`}
        onClick={activateLibrary}
        title="我的文库 (Alt+1)"
      >
        <Icon name="library" size={14} />
        <span className="wtab-label">我的文库</span>
      </button>

      {/* Pinned Notes overview tab */}
      <button
        role="tab"
        aria-selected={active.kind === 'notes'}
        className={`wtab pinned${active.kind === 'notes' ? ' active' : ''}`}
        onClick={activateNotes}
        title="全部笔记汇总"
      >
        <Icon name="notes" size={14} />
        <span className="wtab-label hide-sm">笔记</span>
      </button>

      {tabs.length > 0 && <div className="tabbar-sep" />}

      {/* Scrollable multi-document tab strip */}
      <div
        ref={stripRef}
        className="tabbar-strip"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && stripRef.current) {
            stripRef.current.scrollLeft += e.deltaY;
          }
        }}
      >
        {tabs.map((t, i) => {
          const d = docMap.get(t.docId);
          const title = d?.title || t.title;
          const isActive = active.kind === 'doc' && active.docId === t.docId;
          const isRunning = runningDocId === t.docId;
          const tip = [title, d ? authorsShort(d.meta.authors) : '', d?.meta.year].filter(Boolean).join(' · ');
          return (
            <div
              key={t.docId}
              data-tab-id={t.docId}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              draggable
              className={`wtab doc${isActive ? ' active' : ''}${overIdx === i && dragIdx !== i ? ' drop-over' : ''}`}
              title={`${tip}\n中键点击关闭 · Alt+${i + 2 <= 9 ? i + 2 : '[/]'}`}
              onClick={() => activateDoc(t.docId)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.docId);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activateDoc(t.docId);
                }
              }}
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', t.docId);
              }}
              onDragOver={(e) => {
                if (dragIdx === null) return;
                e.preventDefault();
                setOverIdx(i);
              }}
              onDragEnd={() => {
                if (dragIdx !== null && overIdx !== null && dragIdx !== overIdx) moveTab(dragIdx, overIdx);
                setDragIdx(null);
                setOverIdx(null);
              }}
            >
              {isRunning ? (
                <span className="spinner wtab-spin" title="正在后台翻译" />
              ) : (
                <span className="wtab-ico">
                  <Icon name="filePdf" size={13} />
                </span>
              )}
              <span className="wtab-label">{title}</span>
              <button
                className="wtab-close"
                title="关闭标签页"
                aria-label={`关闭 ${title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.docId);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Tab manager menu & global actions */}
      <div className="tabbar-actions">
        {updateInfo?.hasUpdate && (
          <a
            className="update-pill hide-sm"
            href={updateInfo.url}
            target="_blank"
            rel="noreferrer"
            title={`发现新版本 v${updateInfo.latest}，点击前往下载`}
          >
            新版本 v{updateInfo.latest}
          </a>
        )}
        <button
          className={`sync-pill${syncStatus === 'error' ? ' err' : syncToken ? ' on' : ''}`}
          title={
            syncToken
              ? syncStatus === 'syncing'
                ? syncProgress || '正在同步…'
                : syncStatus === 'error'
                  ? `同步失败：${syncErr}（点击查看）`
                  : `已登录 @${syncUser}${blobProgress ? ` · ${blobProgress}` : ''}${lastSyncAt ? ` · 上次同步 ${new Date(lastSyncAt).toLocaleTimeString()}` : ''}（点击立即同步，右键打开同步设置）`
              : '登录账号以在多端共享文献与设置'
          }
          onClick={() => {
            if (!syncToken || syncStatus === 'error') openSettings('sync');
            else void syncNow();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openSettings('sync');
          }}
        >
          {syncStatus === 'syncing' ? <span className="spinner wtab-spin" /> : <Icon name="cloud" size={14} />}
          <span className="hide-sm">{syncToken ? (syncStatus === 'syncing' ? '同步中' : `@${syncUser}`) : '云同步'}</span>
        </button>
        {tabs.length > 0 && (
          <div className="tabbar-menu-wrap" ref={menuRef}>
            <button
              className={`icon-btn tabbar-btn${menuOpen ? ' active' : ''}`}
              title={`已打开 ${tabs.length} 篇文献`}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="tab-count">{tabs.length}</span>
              <Icon name="down" size={13} />
            </button>
            {menuOpen && (
              <div className="tab-popover">
                <div className="tab-popover-head">已打开的文献 ({tabs.length})</div>
                <div className="tab-popover-list">
                  {tabs.map((t) => {
                    const d = docMap.get(t.docId);
                    const title = d?.title || t.title;
                    const isActive = active.kind === 'doc' && active.docId === t.docId;
                    return (
                      <div
                        key={t.docId}
                        className={`tab-popover-item${isActive ? ' active' : ''}`}
                        onClick={() => {
                          activateDoc(t.docId);
                          setMenuOpen(false);
                        }}
                      >
                        <Icon name="filePdf" size={13} />
                        <span className="tab-popover-title">{title}</span>
                        <button
                          className="wtab-close"
                          title="关闭"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(t.docId);
                          }}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="tab-popover-foot">
                  {activeDocId && tabs.length > 1 && (
                    <button
                      onClick={() => {
                        closeOthers(activeDocId);
                        setMenuOpen(false);
                      }}
                    >
                      关闭其他标签页
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => {
                      closeAll();
                      setMenuOpen(false);
                    }}
                  >
                    关闭全部文献标签
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <button
          className="icon-btn tabbar-btn"
          title={`切换主题（当前：${theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}）`}
          onClick={() => setSettings({ theme: theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark' })}
        >
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={15} />
        </button>
        <button className="icon-btn tabbar-btn" title="设置" onClick={() => openSettings('providers')}>
          <Icon name="settings" size={15} />
        </button>
      </div>
    </header>
  );
}
