/// <reference types="react" />
import { definePlugin, routerHook } from '@steambrew/client';
import { WelcomeModal } from './components/WelcomeModal';
import { AutoShutdownSettings, getTabColor } from './components/Settings';
import { PluginStore, startPolling, stopPolling, abortCountdown, disablePlugin, statusLabel, statusColor } from './polling';

const SAVE_KEY = 'auto_shutdown_settings';

// UI preferences that don't affect the polling logic
let tabColor    = 'gray';
let showOverlay = true;
let panelSide: 'left' | 'right'                = 'left';
let tabStyle:  'slim' | 'large' | 'floating'   = 'slim';
let welcomed   = false;

// Runtime state shared with polling.ts
const store: PluginStore = {
  enabled:              false,
  delay:                1,
  shutdownAction:       'shutdown',
  pluginState:          'idle',
  countdownSeconds:     0,
  countdownInterval:    null,
  pollInterval:         null,
  downloadRegistration: null,
  cancelledAppId:       0,
  wasDownloading:       false,
  shutdownExecuted:     false,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;

    const saved = JSON.parse(raw);

    if (typeof saved.enabled === 'boolean')  store.enabled        = saved.enabled;
    if (typeof saved.delay === 'number')     store.delay          = saved.delay;
    if (typeof saved.tabColor === 'string')  tabColor             = saved.tabColor;
    if (typeof saved.showOverlay === 'boolean') showOverlay       = saved.showOverlay;
    if (typeof saved.welcomed === 'boolean') welcomed             = saved.welcomed;

    if (saved.panelSide === 'left' || saved.panelSide === 'right')                         panelSide            = saved.panelSide;
    if (saved.tabStyle === 'slim' || saved.tabStyle === 'large' || saved.tabStyle === 'floating') tabStyle = saved.tabStyle;
    if (saved.shutdownAction === 'shutdown' || saved.shutdownAction === 'sleep')           store.shutdownAction = saved.shutdownAction;
  } catch { /* corrupted save — just use defaults */ }
}

function saveSettings() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      enabled:        store.enabled,
      delay:          store.delay,
      shutdownAction: store.shutdownAction,
      tabColor,
      showOverlay,
      panelSide,
      tabStyle,
      welcomed,
    }));
  } catch { /* storage might be unavailable */ }
}

// Converts a byte count to a human-readable string
function fmtBytes(n: number) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576)    return (n / 1048576).toFixed(0)    + ' MB';
  if (n >= 1024)       return (n / 1024).toFixed(0)       + ' KB';
  return n + ' B';
}

// Pulls current download info from Steam's internal store
function getDownloadInfo() {
  const ov  = (window as any).downloadsStore?.m_DownloadOverview;
  const id  = ov?.update_appid > 0 ? ov.update_appid : null;
  const app = id ? (window as any).appStore?.GetAppOverviewByAppID?.(id) : null;

  const name     = app?.display_name ?? (id ? `App ${id}` : null);
  const hash     = app?.icon_hash ?? app?.m_strIconHash;
  const iconUrl  = hash
    ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${id}/${hash}.jpg`
    : id ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_sm_120.jpg` : null;

  const prog    = ov?.progress?.[0];
  const pct     = id && prog?.bytes_total > 0
    ? Math.round((prog.bytes_downloaded / prog.bytes_total) * 100)
    : null;
  const overall = ov?.overall_percent_complete > 0
    ? Math.round(ov.overall_percent_complete)
    : pct;

  return {
    appId:          id,
    appName:        name,
    overallPercent: overall,
    iconUrl,
    bytesTotal:     prog?.bytes_total     ?? 0,
    bytesLoaded:    prog?.bytes_downloaded ?? 0,
    bytesPerSec:    ov?.update_bytes_per_second ?? ov?.m_flBytesPerSecond ?? 0,
  };
}

const AutoShutdownWidget = () => {
  const react = (window as any).SP_REACT as typeof import('react');

  const [open,        setOpen]        = react.useState(false);
  const [isEnabled,   setIsEnabled]   = react.useState(store.enabled);
  const [delayVal,    setDelayVal]    = react.useState(store.delay);
  const [status,      setStatus]      = react.useState(statusLabel(store));
  const [statusClr,   setStatusClr]   = react.useState(statusColor(store));
  const [inCountdown, setInCountdown] = react.useState(store.pluginState === 'countdown');
  const [dlInfo,      setDlInfo]      = react.useState(getDownloadInfo());

  // Refresh UI state on a timer
  react.useEffect(() => {
    const tick = setInterval(() => {
      setIsEnabled(store.enabled);
      setDelayVal(store.delay);
      setStatus(statusLabel(store));
      setStatusClr(statusColor(store));
      setInCountdown(store.pluginState === 'countdown');
      setDlInfo(getDownloadInfo());
    }, open ? 1000 : 3000);

    return () => clearInterval(tick);
  }, [open]);

  function toggleEnabled() {
    const next = !store.enabled;
    store.enabled = next;
    setIsEnabled(next);
    if (!next) disablePlugin(store);
    else store.pluginState = 'idle';
    saveSettings();
  }

  function pickDelay(d: number) {
    store.delay = d;
    setDelayVal(d);
    saveSettings();
  }

  function cancelCountdown() {
    abortCountdown(store);
    setInCountdown(false);
  }

  const { appId, appName, overallPercent, iconUrl, bytesTotal, bytesLoaded, bytesPerSec } = dlInfo;

  const tc         = getTabColor(tabColor);
  const isLeft     = panelSide === 'left';
  const btnW       = tabStyle === 'slim' ? 20 : tabStyle === 'large' ? 28 : 26;
  const btnH       = tabStyle === 'slim' ? 48 : tabStyle === 'large' ? 64 : 56;
  const btnOffset  = tabStyle === 'floating' ? 8 : 0;
  const panelOff   = tabStyle === 'floating' ? btnOffset + btnW + 4 : btnW;

  const btnRadius   = tabStyle === 'floating' ? '8px' : isLeft ? '0 6px 6px 0' : '6px 0 0 6px';
  const panelRadius = tabStyle === 'floating' ? '12px' : isLeft ? '0 12px 12px 0' : '12px 0 0 12px';

  const btnPos  = isLeft ? { left:  open ? panelOff + 341 : btnOffset } : { right: open ? panelOff + 341 : btnOffset };
  const panPos  = isLeft ? { left:  panelOff }                          : { right: panelOff };
  const slideIn = open ? '0' : isLeft ? '-110%' : '110%';

  return (
    <>
      {/* Arrow tab that slides with the panel */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'fixed', top: '50%', ...btnPos,
          transform: 'translateY(-50%)',
          width: btnW, height: btnH,
          borderRadius: btnRadius,
          border: 'none', cursor: 'pointer', zIndex: 1001,
          background: open ? tc.bgHover : tc.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: `${isLeft ? 'left' : 'right'} 0.25s cubic-bezier(0.4,0,0.2,1), background 0.15s`,
        }}
      >
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
          <polyline
            points={isLeft ? (open ? '7,2 3,7 7,12' : '3,2 7,7 3,12') : (open ? '3,2 7,7 3,12' : '7,2 3,7 7,12')}
            stroke={tc.arrow} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Main slide-in panel */}
      <div style={{
        position: 'fixed', top: '50%', ...panPos,
        transform: `translateY(-50%) translateX(${slideIn})`,
        zIndex: 999, width: 340,
        background: '#0d0d0d',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: panelRadius,
        overflow: 'hidden',
        transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
        pointerEvents: open ? 'all' : 'none',
        visibility: open || tabStyle !== 'floating' ? 'visible' : 'hidden',
      }}>

        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
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
          <button
            onClick={() => setOpen(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 18 }}
          >✕</button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Active download card */}
          {appName && (
            <div style={{ borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px 10px' }}>
                <img
                  src={iconUrl ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_sm_120.jpg`}
                  style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'contain', flexShrink: 0, background: 'rgba(0,0,0,0.3)' }}
                  onError={(e: any) => {
                    const img = e.target as HTMLImageElement;
                    if (img.src.includes('capsule_sm_120')) img.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
                    else if (img.src.includes('header'))   img.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_184x69.jpg`;
                    else img.style.display = 'none';
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 9, fontWeight: 600, letterSpacing: 1.5, marginBottom: 3 }}>DOWNLOADING</div>
                  <div style={{ color: '#fff', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{appName}</div>
                </div>
                {overallPercent !== null && (
                  <div style={{ flexShrink: 0, color: '#fff', fontSize: 22, fontWeight: 800 }}>
                    {overallPercent}<span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)' }}>%</span>
                  </div>
                )}
              </div>

              {overallPercent !== null && (
                <div style={{ padding: '0 14px 10px' }}>
                  <div style={{ height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 1, background: '#55cc55', width: `${overallPercent}%`, transition: 'width 0.5s' }}/>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                    <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>
                      {bytesTotal > 0 ? `${fmtBytes(bytesLoaded)} / ${fmtBytes(bytesTotal)}` : ''}
                    </span>
                    <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>
                      {bytesPerSec > 0 ? `↓ ${fmtBytes(bytesPerSec)}/s` : ''}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Enable toggle */}
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

          {/* Delay picker */}
          <div>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 8 }}>SHUTDOWN DELAY</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[1, 3, 5, 10].map(d => (
                <button key={d} onClick={() => pickDelay(d)} style={{
                  flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 12, fontWeight: delayVal === d ? 700 : 400,
                  background: delayVal === d ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)',
                  color: delayVal === d ? '#fff' : 'rgba(255,255,255,0.5)',
                  transition: 'all 0.15s',
                }}>{d} min</button>
              ))}
            </div>
          </div>

          {/* Status row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusClr, flexShrink: 0 }}/>
              <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{status}</span>
            </div>
            {inCountdown && (
              <button onClick={cancelCountdown} style={{
                padding: '5px 12px', borderRadius: 5,
                border: '1px solid rgba(224,82,82,0.4)',
                cursor: 'pointer', fontSize: 11, fontWeight: 600,
                background: 'transparent', color: '#e05252',
              }}>Cancel</button>
            )}
          </div>

        </div>
      </div>

      {/* Click-outside overlay */}
      {open && showOverlay && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 998, background: 'rgba(0,0,0,0.4)' }}
        />
      )}
    </>
  );
};

export default definePlugin(() => {
  loadSettings(); // load immediately so content JSX gets correct values

  setTimeout(() => {
    startPolling(store);
  }, 500);

  const patch = routerHook.addPatch('/library/downloads', (props: any) => {
    const { createElement: h, Fragment } = (window as any).SP_REACT;
    const Original = props.children.type;

    props.children.type = (p: any) => h(Fragment, null,
      h(Original, p),
      h(WelcomeModal, { welcomed, onDismiss: () => { welcomed = true; saveSettings(); } }),
      h(AutoShutdownWidget, null)
    );

    return props;
  });

  return {
    title: 'Auto Shutdown',
    icon: <></>,
    content: <AutoShutdownSettings
      tabColor={tabColor}
      showOverlay={showOverlay}
      panelSide={panelSide}
      tabStyle={tabStyle}
      shutdownAction={store.shutdownAction}
      onTabColor={v      => { tabColor            = v; saveSettings(); }}
      onShowOverlay={v   => { showOverlay          = v; saveSettings(); }}
      onPanelSide={v     => { panelSide            = v; saveSettings(); }}
      onTabStyle={v      => { tabStyle             = v; saveSettings(); }}
      onShutdownAction={v => { store.shutdownAction = v; saveSettings(); }}
    />,
    onDismount() {
      stopPolling(store);
      if (store.countdownInterval) clearInterval(store.countdownInterval);
      patch && routerHook.removePatch('/library/downloads', patch);
    },
  };
});
