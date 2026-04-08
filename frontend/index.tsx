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
    if (typeof s.tabColor === 'string') tabColor = s.tabColor;
    if (typeof s.showOverlay === 'boolean') showOverlay = s.showOverlay;
    if (s.panelSide === 'left' || s.panelSide === 'right') panelSide = s.panelSide;
    if (s.tabStyle === 'slim' || s.tabStyle === 'large' || s.tabStyle === 'floating') tabStyle = s.tabStyle;
    if (s.shutdownAction === 'shutdown' || s.shutdownAction === 'sleep') shutdownAction = s.shutdownAction;
    if (typeof s.welcomed === 'boolean') welcomed = s.welcomed;
  } catch { /* ignore */ }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, delay, tabColor, showOverlay, panelSide, tabStyle, shutdownAction, welcomed }));
  } catch { /* ignore */ }
}

const executeShutdown = callable('execute_shutdown');
const executeSleep    = callable('execute_sleep');
const cancelShutdown  = callable('cancel_shutdown');

type PluginState = 'idle' | 'downloading' | 'countdown' | 'cancelled';

let enabled = false;
let delay = 1;
let tabColor = 'gray';
let showOverlay = true;
let panelSide: 'left' | 'right' = 'left';
let tabStyle: 'slim' | 'large' | 'floating' = 'slim';
let shutdownAction: 'shutdown' | 'sleep' = 'shutdown';
let welcomed = false;
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
      const { createElement: h } = (window as any).SP_REACT;
      toaster.toast({
        title: 'Auto Shutdown',
        body: `Downloads done. Shutting down in ${delayMinutes} min.`,
        duration: 8000,
        icon: h('svg', { width: 24, height: 24, viewBox: '0 0 64 64', fill: 'none' },
          h('rect', { x: 4, y: 6, width: 56, height: 38, rx: 3, fill: 'none', stroke: '#ddd', strokeWidth: 3 }),
          h('rect', { x: 8, y: 10, width: 48, height: 30, rx: 1, fill: 'rgba(255,255,255,0.06)' }),
          h('circle', { cx: 32, cy: 25, r: 7, stroke: '#ddd', strokeWidth: 2.5, fill: 'none' }),
          h('line', { x1: 32, y1: 18, x2: 32, y2: 23, stroke: '#ddd', strokeWidth: 2.5, strokeLinecap: 'round' }),
          h('rect', { x: 28, y: 44, width: 8, height: 6, rx: 1, fill: '#aaa' }),
          h('rect', { x: 18, y: 50, width: 28, height: 4, rx: 1, fill: '#aaa' })
        ),
      });
    } catch { /* ignore */ }
  }, 300);

  countdownInterval = setInterval(() => {
    countdownSeconds--;
    if (countdownSeconds <= 0) {
      clearInterval(countdownInterval!);
      countdownInterval = null;
      pluginState = 'idle';
      shutdownExecuted = shutdownAction === 'shutdown';
      if (shutdownAction === 'sleep') executeSleep().catch(() => {});
      else executeShutdown().catch(() => {});
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
  let initialized = false;

  const onOverview = (overview: any) => {
    if (!enabled) return;
    if (pluginState === 'countdown') return;
    const isActive = isActiveOverview(overview);
    const isPaused = isPausedOverview(overview);
    const state: string = overview?.update_state ?? '';
    const isUninstalling = UNINSTALL_STATES.has(state);

    if (!initialized) {
      initialized = true;
      wasDownloading = isActive;
      return;
    }

    if (isUninstalling) {
      if (pendingCountdown) { clearTimeout(pendingCountdown); pendingCountdown = null; }
      cancelledAppId = overview?.update_appid ?? 0;
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
          const curState: string = cur?.update_state ?? '';
          if (UNINSTALL_STATES.has(curState)) return;
          if (cancelledAppId > 0 && !isActiveOverview(cur)) {
            wasDownloading = false;
            return;
          }
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



function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function getDownloadInfo() {
  const activeApp = (window as any).downloadsStore?.m_DownloadOverview;
  const appId = activeApp?.update_appid > 0 ? activeApp.update_appid : null;
  const appOverview = appId ? (window as any).appStore?.GetAppOverviewByAppID?.(appId) : null;
  const appName = appOverview?.display_name ?? (appId ? `App ${appId}` : null);
  const iconHash = appOverview?.icon_hash ?? appOverview?.m_strIconHash;
  const iconUrl = iconHash
    ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appId}/${iconHash}.jpg`
    : appId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_sm_120.jpg` : null;
  const progress = activeApp?.progress?.[0];
  const percent = appId && progress?.bytes_total > 0
    ? Math.round((progress.bytes_downloaded / progress.bytes_total) * 100)
    : null;
  const overallPercent = activeApp?.overall_percent_complete > 0
    ? Math.round(activeApp.overall_percent_complete)
    : percent;
  const bytesTotal = progress?.bytes_total ?? 0;
  const bytesDownloaded = progress?.bytes_downloaded ?? 0;
  const bytesPerSec = activeApp?.update_bytes_per_second ?? activeApp?.m_flBytesPerSecond ?? 0;
  return { appId, appName, overallPercent, iconUrl, bytesTotal, bytesDownloaded, bytesPerSec };
}

const TAB_COLORS: { id: string; label: string; bg: string; bgHover: string; arrow: string }[] = [
  { id: 'gray',  label: 'Gray',   bg: 'rgba(255,255,255,0.12)', bgHover: 'rgba(255,255,255,0.22)', arrow: 'rgba(255,255,255,0.7)' },
  { id: 'black', label: 'Black',  bg: 'rgba(0,0,0,0.75)',       bgHover: 'rgba(0,0,0,0.9)',        arrow: 'rgba(255,255,255,0.7)' },
  { id: 'white', label: 'White',  bg: 'rgba(255,255,255,0.85)', bgHover: 'rgba(255,255,255,1)',    arrow: 'rgba(0,0,0,0.7)'       },
  { id: 'blue',  label: 'Blue',   bg: 'rgba(76,158,255,0.7)',   bgHover: 'rgba(76,158,255,0.9)',   arrow: 'rgba(255,255,255,0.9)' },
  { id: 'red',   label: 'Red',    bg: 'rgba(224,82,82,0.7)',    bgHover: 'rgba(224,82,82,0.9)',    arrow: 'rgba(255,255,255,0.9)' },
];

function getTabColor() {
  return TAB_COLORS.find(c => c.id === tabColor) ?? TAB_COLORS[0];
}

const AutoShutdownSettings = () => {
  const { useState } = (window as any).SP_REACT as typeof import('react');
  const [color, setColor] = useState(tabColor);
  const [ddColorOpen, setDdColorOpen] = useState(false);
  const [ddStyleOpen, setDdStyleOpen] = useState(false);
  const [ddSideOpen, setDdSideOpen] = useState(false);
  const [ddActionOpen, setDdActionOpen] = useState(false);
  const [overlay, setOverlay] = useState(showOverlay);
  const [side, setSide] = useState(panelSide);
  const [style, setStyle] = useState(tabStyle);
  const [action, setAction] = useState(shutdownAction as 'shutdown' | 'sleep');

  const handleColor = (id: string) => { tabColor = id; setColor(id); setDdColorOpen(false); saveSettings(); };
  const handleStyle = (s: 'slim' | 'large' | 'floating') => { tabStyle = s; setStyle(s); setDdStyleOpen(false); saveSettings(); };
  const handleAction = (a: 'shutdown' | 'sleep') => { shutdownAction = a; setAction(a); setDdActionOpen(false); saveSettings(); };
  const toggleOverlay = () => { showOverlay = !showOverlay; setOverlay(showOverlay); saveSettings(); };
  const toggleSide = (s: 'left' | 'right') => { panelSide = s; setSide(s); saveSettings(); };

  const currentColor = TAB_COLORS.find(c => c.id === color) ?? TAB_COLORS[0];
  const styleLabels = { slim: 'Slim', large: 'Large', floating: 'Floating' };

  const ddStyle = (isOpen: boolean, onToggle: () => void, label: string, items: { id: string; label: string }[], onSelect: (id: string) => void, selected: string) => (
    <div style={{ position: 'relative' }}>
      <button onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
        background: 'rgba(255,255,255,0.07)', cursor: 'pointer',
        color: '#fff', fontSize: 12, minWidth: 110, justifyContent: 'space-between',
      }}>
        <span>{label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <polyline points={isOpen ? "1,7 5,3 9,7" : "1,3 5,7 9,3"} stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {isOpen && (
        <>
          <div onClick={onToggle} style={{ position: 'fixed', inset: 0, zIndex: 9998 }}/>
          <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 9999, background: '#2a3547', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden', minWidth: 120 }}>
          {items.map(item => (
            <button key={item.id} onClick={() => onSelect(item.id)} style={{
              display: 'block', width: '100%', padding: '9px 14px', border: 'none',
              background: item.id === selected ? 'rgba(255,255,255,0.12)' : 'transparent',
              color: item.id === selected ? '#fff' : 'rgba(255,255,255,0.7)',
              fontSize: 12, cursor: 'pointer', textAlign: 'left',
              fontWeight: item.id === selected ? 700 : 400,
            }}>{item.label}</button>
          ))}
          </div>
        </>
      )}
    </div>
  );

  const row = (title: string, desc: string, control: any, first = false) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.06)' }}>
      <div>
        <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: 500 }}>{title}</div>
        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 3 }}>{desc}</div>
      </div>
      {control}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {row('Background Overlay', 'Dim the screen when panel is open',
        <button onClick={toggleOverlay} style={{ width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', flexShrink: 0, background: overlay ? 'linear-gradient(135deg,#55cc55,#2a8a2a)' : 'rgba(255,255,255,0.15)', position: 'relative', transition: 'background 0.2s' }}>
          <span style={{ position: 'absolute', top: 4, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', left: overlay ? 24 : 4 }}/>
        </button>, true
      )}
      {row('Action', 'What to do when downloads finish',
        ddStyle(ddActionOpen, () => setDdActionOpen(o => !o),
          action === 'shutdown' ? 'Shutdown' : 'Sleep',
          [{ id: 'shutdown', label: 'Shutdown' }, { id: 'sleep', label: 'Sleep' }],
          (a) => handleAction(a as any), action)
      )}
      {row('Button Color', 'Color of the side tab button',
        ddStyle(ddColorOpen, () => setDdColorOpen(o => !o), currentColor.label, TAB_COLORS, handleColor, color)
      )}
      {row('Button Style', 'Shape of the side tab button',
        ddStyle(ddStyleOpen, () => setDdStyleOpen(o => !o), styleLabels[style], [
          { id: 'slim', label: 'Slim' }, { id: 'large', label: 'Large' }, { id: 'floating', label: 'Floating' }
        ], (s) => handleStyle(s as any), style)
      )}
      {row('Panel Side', 'Side the panel slides out from',
        ddStyle(ddSideOpen, () => setDdSideOpen(o => !o), side === 'left' ? 'Left' : 'Right', [
          { id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }
        ], (s) => { toggleSide(s as any); setDdSideOpen(false); }, side)
      )}
    </div>
  );
};

const WelcomeModal = () => {
  const { useState } = (window as any).SP_REACT as typeof import('react');
  const [visible, setVisible] = useState(!welcomed);

  if (!visible) return null;

  const dismiss = () => {
    welcomed = true;
    setVisible(false);
    saveSettings();
  };

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.7)' }}/>      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 9999, width: 360, background: '#0d0d0d',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, overflow: 'hidden',
      }}>
        <div style={{ padding: '20px 22px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🖥️</div>
          <div style={{ color: '#fff', fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Welcome to Auto Shutdown!</div>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, lineHeight: 1.6 }}>
            ⚠️ <strong style={{ color: 'rgba(255,255,255,0.8)' }}>Heads up!</strong> Don't forget to <strong style={{ color: 'rgba(255,255,255,0.8)' }}>disable</strong> the auto shutdown feature when you don't need it — if a small game update downloads automatically, your PC will shut down after the set delay.
          </div>
        </div>

        <div style={{ padding: '14px 22px', margin: '16px 22px 0', background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: 600, letterSpacing: 1, marginBottom: 6 }}>WHERE TO FIND SETTINGS</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, lineHeight: 1.7 }}>
            Steam menu → <strong style={{ color: '#fff' }}>Millennium Library Manager</strong> → <strong style={{ color: '#fff' }}>Auto Shutdown</strong>
          </div>
        </div>

        <div style={{ padding: '16px 22px 20px', textAlign: 'center' }}>
          <button onClick={dismiss} style={{
            width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 13, fontWeight: 600,
            transition: 'background 0.15s',
          }}>Got it! 👍</button>
          <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10, marginTop: 12 }}>
            Made with ❤️ by BambooFury
          </div>
        </div>
      </div>
    </>
  );
};

const AutoShutdownWidget = () => {
  const { useState, useEffect } = (window as any).SP_REACT as typeof import('react');
  const [open, setOpen]               = useState(false);
  const [isEnabled, setIsEnabled]     = useState(enabled);
  const [delayVal, setDelayVal]       = useState(delay);
  const [status, setStatus]           = useState(statusLabel());
  const [statusClr, setStatusClr]     = useState(statusColor());
  const [inCountdown, setInCountdown] = useState(pluginState === 'countdown');
  const [dlInfo, setDlInfo]           = useState(getDownloadInfo());

  useEffect(() => {
    const t = setInterval(() => {
      setIsEnabled(enabled); setDelayVal(delay);
      setStatus(statusLabel()); setStatusClr(statusColor());
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

  const { appId, appName, overallPercent, iconUrl, bytesTotal, bytesDownloaded, bytesPerSec } = dlInfo;
  const tc = getTabColor();
  const isLeft = panelSide === 'left';
  const btnW = tabStyle === 'slim' ? 20 : tabStyle === 'large' ? 28 : 26;
  const btnH = tabStyle === 'slim' ? 48 : tabStyle === 'large' ? 64 : 56;
  const btnOffset = tabStyle === 'floating' ? 8 : 0;
  const btnRadius = tabStyle === 'floating'
    ? '8px'
    : isLeft ? '0 6px 6px 0' : '6px 0 0 6px';
  const panelOffset = tabStyle === 'floating' ? btnOffset + btnW + 4 : btnW;
  const panelRadius = tabStyle === 'floating'
    ? '12px'
    : isLeft ? '0 12px 12px 0' : '12px 0 0 12px';

  return (
    <>
      {/* Tab trigger — moves to edge of panel when open */}
      <button onClick={() => setOpen(o => !o)} style={{
        position: 'fixed', top: '50%',
        ...(isLeft
          ? { left: open ? panelOffset + 340 + 1 : btnOffset }
          : { right: open ? panelOffset + 340 + 1 : btnOffset }),
        transform: 'translateY(-50%)',
        width: btnW, height: btnH,
        borderRadius: btnRadius,
        border: 'none', cursor: 'pointer', zIndex: 1001,
        background: open ? tc.bgHover : tc.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: `${isLeft ? 'left' : 'right'} 0.25s cubic-bezier(0.4,0,0.2,1), background 0.15s`,
      }}>
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
          <polyline
            points={isLeft ? (open ? "7,2 3,7 7,12" : "3,2 7,7 3,12") : (open ? "3,2 7,7 3,12" : "7,2 3,7 7,12")}
            stroke={tc.arrow} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Slide-in panel */}
      <div style={{
        position: 'fixed', top: '50%',
        ...(isLeft ? { left: panelOffset } : { right: panelOffset }),
        transform: `translateY(-50%) translateX(${open ? '0' : (isLeft ? '-110%' : '110%')})`,
        zIndex: 999, width: 340,
        background: '#0d0d0d',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: panelRadius,
        overflow: 'hidden',
        transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
        pointerEvents: open ? 'all' : 'none',
        visibility: open || tabStyle !== 'floating' ? 'visible' : 'hidden',
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
                <div style={{ borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px 10px' }}>
                    <img
                      src={iconUrl ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_sm_120.jpg`}
                      style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'contain', flexShrink: 0, background: 'rgba(0,0,0,0.3)' }}
                      onError={(e: any) => {
                        const t = e.target as HTMLImageElement;
                        if (t.src.includes('capsule_sm_120')) t.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
                        else if (t.src.includes('header')) t.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_184x69.jpg`;
                        else t.style.display = 'none';
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 9, fontWeight: 600, letterSpacing: 1.5, marginBottom: 3 }}>DOWNLOADING</div>
                      <div style={{ color: '#fff', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{appName}</div>
                    </div>
                    {overallPercent !== null && (
                      <div style={{ flexShrink: 0, color: '#fff', fontSize: 22, fontWeight: 800 }}>{overallPercent}<span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)' }}>%</span></div>
                    )}
                  </div>
                  {overallPercent !== null && (
                    <div style={{ padding: '0 14px 10px' }}>
                      <div style={{ height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 1, background: '#55cc55', width: `${overallPercent}%`, transition: 'width 0.5s' }}/>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                        <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>
                          {bytesTotal > 0 ? `${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)}` : ''}
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>
                          {bytesPerSec > 0 ? `↓ ${formatBytes(bytesPerSec)}/s` : ''}
                        </span>
                      </div>
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

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusClr, flexShrink: 0 }}/>
                  <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{status}</span>
                </div>
                {inCountdown && (
                  <button onClick={handleCancel} style={{
                    padding: '5px 12px', borderRadius: 5, border: '1px solid rgba(224,82,82,0.4)', cursor: 'pointer',
                    fontSize: 11, fontWeight: 600, background: 'transparent', color: '#e05252',
                  }}>Cancel</button>
                )}
              </div>
            </div>
          </div>
      {open && showOverlay && <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 998, background: 'rgba(0,0,0,0.4)' }}/>}
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
    props.children.type = (p: any) => h(Fragment, null, h(OriginalComponent, p), h(WelcomeModal, null), h(AutoShutdownWidget, null));
    return props;
  });

  return {
    title: 'Auto Shutdown',
    icon: <></>,
    content: <AutoShutdownSettings />,
    onDismount() {
      stopPolling();
      if (countdownInterval) clearInterval(countdownInterval);
      patch && routerHook.removePatch('/library/downloads', patch);
    },
  };
});
