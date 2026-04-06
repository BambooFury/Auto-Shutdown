/// <reference types="react" />
import { definePlugin, Field, Toggle, callable, toaster } from '@steambrew/client';

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
let shutdownExecuted = false;

function statusLabel(): string {
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
  switch (pluginState) {
    case 'cancelled':   return '#ff5555';
    case 'countdown':   return '#55ff55';
    case 'downloading': return '#4c9eff';
    default:            return 'rgba(255,255,255,0.5)';
  }
}

function statusIcon(): any {
  switch (pluginState) {
    case 'cancelled':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="1" y1="1" x2="11" y2="11" stroke="#ff5555" strokeWidth="2.5" strokeLinecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="#ff5555" strokeWidth="2.5" strokeLinecap="round"/></svg>;
    case 'countdown':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><polyline points="1,6 4.5,10 11,2" stroke="#55ff55" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
    case 'downloading':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="6" y1="1" x2="6" y2="9" stroke="#4c9eff" strokeWidth="2.5" strokeLinecap="round"/><polyline points="2,6 6,10 10,6" stroke="#4c9eff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
    default:
      return <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5"/></svg>;
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

function isActiveOverview(overview: any): boolean {
  if (!overview) return false;
  const state: string = overview.update_state ?? '';
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
  let wasDownloading = false;
  let pendingCountdown: ReturnType<typeof setTimeout> | null = null;

  const onOverview = (overview: any) => {
    if (!enabled) return;
    if (pluginState === 'countdown') return;
    const isActive = isActiveOverview(overview);
    const isPaused = isPausedOverview(overview);

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

const SettingsContent = () => {
  const { useState, useEffect } = (window as any).SP_REACT as typeof import('react');

  const [isEnabled, setIsEnabled]     = useState<boolean>(enabled);
  const [delayVal, setDelayVal]       = useState<number>(delay);
  const [status, setStatus]           = useState<string>(statusLabel());
  const [statusClr, setStatusClr]     = useState<string>(statusColor());
  const [statusIcn, setStatusIcn]     = useState<any>(statusIcon());
  const [inCountdown, setInCountdown] = useState<boolean>(pluginState === 'countdown');

  useEffect(() => {
    setIsEnabled(enabled);
    setDelayVal(delay);
    const t = setInterval(() => {
      setStatus(statusLabel());
      setStatusClr(statusColor());
      setStatusIcn(statusIcon());
      setInCountdown(pluginState === 'countdown');
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const handleToggle = (val: boolean) => {
    enabled = val;
    setIsEnabled(val);
    if (!val) { abortCountdown(); pluginState = 'idle'; }
    saveSettings();
  };

  const handleDelay = (d: number) => {
    delay = d;
    setDelayVal(d);
    saveSettings();
  };

  const handleCancel = () => {
    abortCountdown();
    setInCountdown(false);
    setStatus(statusLabel());
  };

  return (
    <>
      <Field label="Enable Auto Shutdown" description="Shut down PC when all downloads finish." bottomSeparator="standard">
        <Toggle value={isEnabled} onChange={handleToggle} />
      </Field>

      <Field label="Shutdown Delay" description="Time to wait before shutting down." bottomSeparator="standard" childrenLayout="below">
        <div style={{ display: 'flex', gap: 8, width: '100%', paddingBottom: 2 }}>
          {DELAY_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => handleDelay(d)}
              style={{
                flex: 1,
                padding: '7px 0',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                fontWeight: delayVal === d ? 700 : 400,
                fontSize: 13,
                background: delayVal === d
                  ? 'linear-gradient(135deg, #4c9eff 0%, #1a6ed8 100%)'
                  : 'rgba(255,255,255,0.08)',
                color: delayVal === d ? '#fff' : 'rgba(255,255,255,0.55)',
                boxShadow: delayVal === d ? '0 0 0 1px #4c9eff55, 0 2px 8px #1a6ed840' : 'none',
                transition: 'all 0.15s ease',
              }}
            >
              {d} min
            </button>
          ))}
        </div>
      </Field>

      <Field label="Status" bottomSeparator="none" description={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: statusClr, fontWeight: 500 }}>
          <span style={{ display: 'flex', alignItems: 'center', lineHeight: 1 }}>{statusIcn}</span>
          <span>{status}</span>
        </span>
      }>
        {inCountdown && (
          <button
            onClick={handleCancel}
            style={{
              padding: '7px 0',
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: 13,
              width: 80,
              background: 'linear-gradient(135deg, #e05252 0%, #b03030 100%)',
              color: '#fff',
              transition: 'all 0.15s ease',
            }}
          >
            Cancel
          </button>
        )}
      </Field>
    </>
  );
};

export default definePlugin(() => {
  setTimeout(() => {
    loadSettings();
    startPolling();
  }, 500);

  return {
    title: 'Auto Shutdown',
    icon: <></>,
    content: <SettingsContent />,
    onDismount() {
      stopPolling();
      if (countdownInterval) clearInterval(countdownInterval);
    },
  };
});
