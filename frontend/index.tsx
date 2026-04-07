/// <reference types="react" />
import { definePlugin, callable, toaster, routerHook } from '@steambrew/client';

const STORAGE_KEY = 'auto_shutdown_settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (typeof s.enabled === 'boolean') enabled = s.enabled;
    if (typeof s.delay === 'number') delay = s.delay;
  } catch { /* ignore */ }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, delay }));
  } catch { /* ignore */ }
}

const executeShutdown = callable('execute_shutdown');
const cancelShutdown  = callable('cancel_shutdown');

type PluginState = 'idle' | 'downloading' | 'countdown' | 'cancelled';

const DELAY_OPTIONS = [1, 3, 5, 10];

let enabled = true;
let delay = 1;
let pluginState: PluginState = 'idle';
let countdownSeconds = 0;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let downloadRegistration: { unregister: () => void } | null = null;
let cancelledAppId = 0;
let wasDownloading = false;
let shutdownExecuted = false;

function statusLabel(): string {
  if (!enabled) return 'Disabled';
  switch (pluginState) {
    case 'idle':        return 'Waiting for downloads…';
    case 'downloading': return 'Downloading…';
    case 'countdown': {
      const m = Math.floor(countdownSeconds / 60);
      const s = countdownSeconds % 60;
      return `Shutting down in ${m}m ${s}s…`;
    }
    case 'cancelled':   return 'Cancelled';
  }
}

function statusColor(): string {
  if (!enabled) return 'rgba(255,255,255,0.3)';
  switch (pluginState) {
    case 'cancelled':   return '#ff5555';
    case 'countdown':   return '#55ff55';
    case 'downloading': return '#4c9eff';
    default:            return 'rgba(255,255,255,0.5)';
  }
}


function abortCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (shutdownExecuted) {
    cancelShutdown().catch(() => {});
    shutdownExecuted = false;
  }
  cancelledAppId = (window as any).downloadsStore?.m_DownloadOverview?.update_appid ?? 0;
  pluginState = 'cancelled';
}

function disablePlugin() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (shutdownExecuted) {
    cancelShutdown().catch(() => {});
    shutdownExecuted = false;
  }
  wasDownloading = false;
  if (pluginState === 'countdown') pluginState = 'idle';
}

function startCountdown(delayMinutes: number) {
  pluginState = 'countdown';
  countdownSeconds = delayMinutes * 60;

  setTimeout(() => {
    try {
      toaster.toast({
        title: 'Auto Shutdown',
        body: `Downloads done. Shutting down in ${delayMinutes} min.`,
        duration: 8000,
      });
    } catch { /* ignore */ }
  }, 300);

  countdownInterval = setInterval(() => {
    countdownSeconds--;
    if (countdownSeconds <= 0) {
      clearInterval(countdownInterval!);
      countdownInterval = null;
      pluginState = 'idle';
      shutdownExecuted = true;
      executeShutdown().catch(() => {});
    }
  }, 1000);
}

const UNINSTALL_STATES = new Set(['Uninstalling', 'Reconfiguring', 'Validating', 'Committing']);

function isActiveOverview(overview: any): boolean {
  if (!overview) return false;
  const state: string = overview.update_state ?? '';
  if (UNINSTALL_STATES.has(state)) return false;
  return state !== 'None' && state !== '' && state !== 'Stopping' && overview.update_appid > 0 && !overview.paused;
}

function isPausedOverview(overview: any): boolean {
  if (!overview) return false;
  const state: string = overview.update_state ?? '';
  return (overview.update_appid > 0 && overview.paused === true) ||
         state === 'Stopping' ||
         (state === 'None' && overview.paused === true);
}

const FAILED_STATES = new Set(['Failed', 'Error', 'Corrupt', 'DiskReadFailure', 'DiskWriteFailure', 'NotEnoughDiskSpace']);

function isFailedOverview(overview: any): boolean {
  if (!overview) return false;
  return FAILED_STATES.has(overview.update_state ?? '');
}

function startPolling() {
  if (pollInterval) return;
  let pendingCountdown: ReturnType<typeof setTimeout> | null = null;

  const onOverview = (overview: any) => {
    if (!enabled) return;
    if (pluginState === 'countdown') return;
    const isActive = isActiveOverview(overview);
    const isPaused = isPausedOverview(overview);
    const state: string = overview?.update_state ?? '';
    const isUninstalling = UNINSTALL_STATES.has(state);

    if (isUninstalling) {
      if (pendingCountdown) { clearTimeout(pendingCountdown); pendingCountdown = null; }
      wasDownloading = false;
      pluginState = 'idle';
      return;
    }

    if (isActive) {
      if (pendingCountdown) { clearTimeout(pendingCountdown); pendingCountdown = null; }
      if (cancelledAppId > 0 && overview?.update_appid === cancelledAppId) return;
      wasDownloading = true;
      pluginState = 'downloading';
    } else if (isPaused || isFailedOverview(overview)) {
      if (pendingCountdown) { clearTimeout(pendingCountdown); pendingCountdown = null; }
      wasDownloading = false;
      pluginState = 'idle';
    } else if (wasDownloading && pluginState !== 'cancelled') {
      if (!pendingCountdown) {
        pendingCountdown = setTimeout(() => {
          pendingCountdown = null;
          if (!enabled || pluginState === 'countdown') return;
          const cur = (window as any).downloadsStore?.m_DownloadOverview;
          if (isActiveOverview(cur)) return;
          wasDownloading = false;
          cancelledAppId = 0;
          startCountdown(delay);
        }, 4000);
      }
    } else if (!wasDownloading && pluginState !== 'cancelled') {
      if (cancelledAppId > 0 && overview?.update_appid !== cancelledAppId) cancelledAppId = 0;
      pluginState = 'idle';
    }
  };

  try {
    const dl = (window as any).SteamClient?.Downloads;
    if (dl?.RegisterForDownloadOverview) {
      downloadRegistration = dl.RegisterForDownloadOverview(onOverview);
    }
  } catch { /* ignore */ }

  pollInterval = setInterval(() => {
    if (!enabled) return;
    if (pluginState === 'countdown') return;
    onOverview((window as any).downloadsStore?.m_DownloadOverview);
  }, 5000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (downloadRegistration) { downloadRegistration.unregister(); downloadRegistration = null; }
}

const StatusIcon = ({ state }: { state: string }) => {
  const { createElement: h } = (window as any).SP_REACT;
  if (state === 'downloading') return h('svg', { width: 14, height: 14, viewBox: '0 0 12 12', fill: 'none' },
    h('line', { x1: 6, y1: 1, x2: 6, y2: 9, stroke: '#4c9eff', strokeWidth: 2.5, strokeLinecap: 'round' }),
    h('polyline', { points: '2,6 6,10 10,6', stroke: '#4c9eff', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
  );
  if (state === 'cancelled') return h('svg', { width: 14, height: 14, viewBox: '0 0 12 12', fill: 'none' },
    h('line', { x1: 1, y1: 1, x2: 11, y2: 11, stroke: '#ff5555', strokeWidth: 2.5, strokeLinecap: 'round' }),
    h('line', { x1: 11, y1: 1, x2: 1, y2: 11, stroke: '#ff5555', strokeWidth: 2.5, strokeLinecap: 'round' })
  );
  if (state === 'countdown') return h('svg', { width: 14, height: 14, viewBox: '0 0 12 12', fill: 'none' },
    h('polyline', { points: '1,6 4.5,10 11,2', stroke: '#55cc55', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
  );
  return h('svg', { width: 14, height: 14, viewBox: '0 0 12 12', fill: 'none' },
    h('circle', { cx: 6, cy: 6, r: 4, stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 })
  );
};


function getDownloadInfo() {
  const activeApp = (window as any).downloadsStore?.m_DownloadOverview;
  const appId = activeApp?.update_appid > 0 ? activeApp.update_appid : null;
  const appOverview = appId ? (window as any).appStore?.GetAppOverviewByAppID?.(appId) : null;
  const appName = appOverview?.display_name ?? (appId ? `App ${appId}` : null);
  const iconHash = appOverview?.icon_hash ?? appOverview?.m_strIconHash;
  const iconUrl = iconHash
    ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appId}/${iconHash}.jpg`
    : appId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_sm_120.jpg` : null;
  const percent = appId && activeApp?.progress?.[0]?.bytes_total > 0
    ? Math.round((activeApp.progress[0].bytes_downloaded / activeApp.progress[0].bytes_total) * 100)
    : null;
  const overallPercent = activeApp?.overall_percent_complete > 0
    ? Math.round(activeApp.overall_percent_complete)
    : percent;
  return { appId, appName, overallPercent, iconUrl };
}

const AutoShutdownWidget = () => {
  const { useState, useEffect } = (window as any).SP_REACT as typeof import('react');
  const [open, setOpen]               = useState(false);
  const [isEnabled, setIsEnabled]     = useState(enabled);
  const [delayVal, setDelayVal]       = useState(delay);
  const [status, setStatus]           = useState(statusLabel());
  const [statusClr, setStatusClr]     = useState(statusColor());
  const [curState, setCurState]       = useState(pluginState);
  const [inCountdown, setInCountdown] = useState(pluginState === 'countdown');
  const [dlInfo, setDlInfo]           = useState(getDownloadInfo());

  useEffect(() => {
    const t = setInterval(() => {
      setIsEnabled(enabled); setDelayVal(delay);
      setStatus(statusLabel()); setStatusClr(statusColor());
      setCurState(pluginState);
      setInCountdown(pluginState === 'countdown');
      setDlInfo(getDownloadInfo());
    }, open ? 1000 : 3000);
    return () => clearInterval(t);
  }, [open]);

  const toggleEnabled = () => {
    const val = !enabled; enabled = val; setIsEnabled(val);
    if (!val) {
      disablePlugin();
    } else {
      pluginState = 'idle';
    }
    saveSettings();
  };

  const handleDelay = (d: number) => { delay = d; setDelayVal(d); saveSettings(); };
  const handleCancel = () => { abortCountdown(); setInCountdown(false); };

  const { appId, appName, overallPercent, iconUrl } = dlInfo;

  return (
    <>
      <button onClick={() => setOpen(o => !o)} title="Auto Shutdown" style={{
        position: 'fixed', top: 67, right: 58, width: 30, height: 28.05,
        borderRadius: 0, border: 'none', cursor: 'pointer', zIndex: 1,
        background: open ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 0.15s',
      }}>
        <svg width="18" height="18" viewBox="0 0 64 64" fill="none">
          <rect x="4" y="6" width="56" height="38" rx="3" fill="none" stroke="#ddd" strokeWidth="3"/>
          <rect x="8" y="10" width="48" height="30" rx="1" fill="rgba(255,255,255,0.06)"/>
          <circle cx="32" cy="25" r="7" stroke="#ddd" strokeWidth="2.5" fill="none"/>
          <line x1="32" y1="18" x2="32" y2="23" stroke="#ddd" strokeWidth="2.5" strokeLinecap="round"/>
          <rect x="28" y="44" width="8" height="6" rx="1" fill="#aaa"/>
          <rect x="18" y="50" width="28" height="4" rx="1" fill="#aaa"/>
        </svg>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.6)' }}/>
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            zIndex: 9999, width: 340,
            background: '#0d0d0d',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
            boxShadow: 'none', overflow: 'hidden',
          }}>
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#1a1a1a',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg width="20" height="20" viewBox="0 0 64 64" fill="none">
                  <rect x="4" y="6" width="56" height="38" rx="4" fill="none" stroke="#aaa" strokeWidth="3"/>
                  <rect x="8" y="10" width="48" height="30" rx="2" fill="rgba(255,255,255,0.06)"/>
                  <circle cx="32" cy="25" r="7" stroke="#aaa" strokeWidth="2.5" fill="none"/>
                  <line x1="32" y1="18" x2="32" y2="23" stroke="#aaa" strokeWidth="2.5" strokeLinecap="round"/>
                  <rect x="28" y="44" width="8" height="6" rx="1" fill="#555"/>
                  <rect x="18" y="50" width="28" height="4" rx="2" fill="#555" stroke="#888" strokeWidth="1"/>
                </svg>
                <span style={{ color: 'white', fontSize: 15, fontWeight: 700 }}>Auto Shutdown</span>
              </div>
              <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 18 }}>✕</button>
            </div>

            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {appName && (
                <div style={{ background: 'rgba(76,158,255,0.08)', borderRadius: 8, padding: '10px 14px', border: '1px solid rgba(76,158,255,0.2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <img
                      src={iconUrl ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_sm_120.jpg`}
                      style={{ width: 40, height: 30, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                      onError={(e: any) => {
                        const t = e.target as HTMLImageElement;
                        if (t.src.includes('capsule_sm_120')) {
                          t.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
                        } else if (t.src.includes('header')) {
                          t.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_184x69.jpg`;
                        } else if (t.src.includes('capsule_184x69')) {
                          t.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/logo.png`;
                        } else {
                          t.style.display = 'none';
                        }
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginBottom: 2 }}>DOWNLOADING</div>
                      <div style={{ color: 'white', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{appName}</div>
                    </div>
                    {overallPercent !== null && (
                      <div style={{ color: '#4c9eff', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{overallPercent}%</div>
                    )}
                  </div>
                  {overallPercent !== null && (
                    <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.1)' }}>
                      <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg,#4c9eff,#1a6ed8)', width: `${overallPercent}%`, transition: 'width 0.5s' }}/>
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ color: 'white', fontSize: 13, fontWeight: 500 }}>Enable Auto Shutdown</div>
                  <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>Shut down when downloads finish</div>
                </div>
                <button onClick={toggleEnabled} style={{
                  width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', flexShrink: 0,
                  background: isEnabled ? 'linear-gradient(135deg,#55cc55,#2a8a2a)' : 'rgba(255,255,255,0.15)',
                  position: 'relative', transition: 'background 0.2s',
                }}>
                  <span style={{ position: 'absolute', top: 4, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', left: isEnabled ? 24 : 4 }}/>
                </button>
              </div>

              <div>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 8 }}>SHUTDOWN DELAY</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1, 3, 5, 10].map(d => (
                    <button key={d} onClick={() => handleDelay(d)} style={{
                      flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
                      fontSize: 12, fontWeight: delayVal === d ? 700 : 400,
                      background: delayVal === d ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)',
                      color: delayVal === d ? '#fff' : 'rgba(255,255,255,0.5)',
                      transition: 'all 0.15s',
                    }}>{d} min</button>
                  ))}
                </div>
              </div>

              <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginBottom: 4 }}>STATUS</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <StatusIcon state={curState} />
                    <span style={{ color: statusClr, fontSize: 13, fontWeight: 500 }}>{status}</span>
                  </div>
                </div>
                {inCountdown && (
                  <button onClick={handleCancel} style={{
                    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 700,
                    background: 'linear-gradient(135deg,#e05252,#b03030)', color: '#fff',
                  }}>Cancel</button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
};


export default definePlugin(() => {
  setTimeout(() => {
    loadSettings();
    startPolling();
  }, 500);

  const patch = routerHook.addPatch('/library/downloads', (props: any) => {
    const { createElement: h, Fragment } = (window as any).SP_REACT;
    const OriginalComponent = props.children.type;
    props.children.type = (p: any) => h(Fragment, null, h(OriginalComponent, p), h(AutoShutdownWidget, null));
    return props;
  });

  return {
    title: 'Auto Shutdown',
    icon: <></>,
    content: undefined,
    onDismount() {
      stopPolling();
      if (countdownInterval) clearInterval(countdownInterval);
      patch && routerHook.removePatch('/library/downloads', patch);
    },
  };
});
