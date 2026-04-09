import { callable, toaster } from '@steambrew/client';

export type PluginState = 'idle' | 'downloading' | 'countdown' | 'cancelled';

// All mutable runtime state lives here so we can pass it around without globals
export type PluginStore = {
  enabled: boolean;
  delay: number;
  shutdownAction: 'shutdown' | 'sleep';
  pluginState: PluginState;
  countdownSeconds: number;
  countdownInterval: ReturnType<typeof setInterval> | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  downloadRegistration: { unregister: () => void } | null;
  cancelledAppId: number;
  wasDownloading: boolean;
  shutdownExecuted: boolean;
};

const doShutdown = callable('execute_shutdown');
const doSleep    = callable('execute_sleep');
const doCancel   = callable('cancel_shutdown');

// States that mean Steam is removing/verifying a game, not downloading
const UNINSTALL_STATES = new Set(['Uninstalling', 'Reconfiguring', 'Validating', 'Committing']);
const FAILED_STATES    = new Set(['Failed', 'Error', 'Corrupt', 'DiskReadFailure', 'DiskWriteFailure', 'NotEnoughDiskSpace']);

function isActive(ov: any) {
  if (!ov) return false;
  const st: string = ov.update_state ?? '';
  if (UNINSTALL_STATES.has(st)) return false;
  return st !== 'None' && st !== '' && st !== 'Stopping' && ov.update_appid > 0 && !ov.paused;
}

function isPaused(ov: any) {
  if (!ov) return false;
  const st: string = ov.update_state ?? '';
  return (ov.update_appid > 0 && ov.paused === true) || st === 'Stopping' || (st === 'None' && ov.paused === true);
}

function isFailed(ov: any) {
  return ov ? FAILED_STATES.has(ov.update_state ?? '') : false;
}

export function statusLabel(s: PluginStore) {
  if (!s.enabled) return 'Disabled';

  if (s.pluginState === 'idle')        return 'Waiting for downloads…';
  if (s.pluginState === 'downloading') return 'Downloading…';
  if (s.pluginState === 'cancelled')   return 'Cancelled';

  if (s.pluginState === 'countdown') {
    const m   = Math.floor(s.countdownSeconds / 60);
    const sec = s.countdownSeconds % 60;
    return `Shutting down in ${m}m ${sec}s…`;
  }

  return '';
}

export function statusColor(s: PluginStore) {
  if (!s.enabled)                      return 'rgba(255,255,255,0.3)';
  if (s.pluginState === 'cancelled')   return '#ff5555';
  if (s.pluginState === 'countdown')   return '#55ff55';
  if (s.pluginState === 'downloading') return '#4c9eff';
  return 'rgba(255,255,255,0.5)';
}

export function abortCountdown(s: PluginStore) {
  if (s.countdownInterval) {
    clearInterval(s.countdownInterval);
    s.countdownInterval = null;
  }
  if (s.shutdownExecuted) {
    doCancel().catch(() => {});
    s.shutdownExecuted = false;
  }
  s.cancelledAppId = (window as any).downloadsStore?.m_DownloadOverview?.update_appid ?? 0;
  s.pluginState = 'cancelled';
}

export function disablePlugin(s: PluginStore) {
  if (s.countdownInterval) {
    clearInterval(s.countdownInterval);
    s.countdownInterval = null;
  }
  if (s.shutdownExecuted) {
    doCancel().catch(() => {});
    s.shutdownExecuted = false;
  }
  s.wasDownloading = false;
  if (s.pluginState === 'countdown') s.pluginState = 'idle';
}

export function startCountdown(s: PluginStore) {
  s.pluginState = 'countdown';
  s.countdownSeconds = s.delay * 60;

  // Show toast after a short delay so Steam has time to render it
  setTimeout(() => {
    try {
      const h = (window as any).SP_REACT.createElement;
      toaster.toast({
        title: 'Auto Shutdown',
        body: `Downloads done. Shutting down in ${s.delay} min.`,
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
    } catch { /* toast might not be available */ }
  }, 300);

  s.countdownInterval = setInterval(() => {
    s.countdownSeconds--;

    if (s.countdownSeconds > 0) return;

    clearInterval(s.countdownInterval!);
    s.countdownInterval = null;
    s.pluginState = 'idle';
    s.shutdownExecuted = s.shutdownAction === 'shutdown';

    if (s.shutdownAction === 'sleep') doSleep().catch(() => {});
    else doShutdown().catch(() => {});
  }, 1000);
}

export function startPolling(s: PluginStore) {
  if (s.pollInterval) return;

  let pending: ReturnType<typeof setTimeout> | null = null;
  let ready = false; // skip the very first tick to avoid false triggers on startup

  function onOverview(ov: any) {
    if (!s.enabled) return;
    if (s.pluginState === 'countdown') return;

    const active      = isActive(ov);
    const paused      = isPaused(ov);
    const state       = ov?.update_state ?? '';
    const uninstalling = UNINSTALL_STATES.has(state);

    // First call — just snapshot current state, don't react
    if (!ready) {
      ready = true;
      s.wasDownloading = active;
      return;
    }

    if (uninstalling) {
      if (pending) { clearTimeout(pending); pending = null; }
      s.cancelledAppId = ov?.update_appid ?? 0;
      s.wasDownloading = false;
      s.pluginState = 'idle';
      return;
    }

    if (active) {
      if (pending) { clearTimeout(pending); pending = null; }
      if (s.cancelledAppId > 0 && ov?.update_appid === s.cancelledAppId) return;
      s.wasDownloading = true;
      s.pluginState = 'downloading';
      return;
    }

    if (paused || isFailed(ov)) {
      if (pending) { clearTimeout(pending); pending = null; }
      s.wasDownloading = false;
      s.pluginState = 'idle';
      return;
    }

    if (s.wasDownloading && s.pluginState !== 'cancelled') {
      if (pending) return; // already waiting

      pending = setTimeout(() => {
        pending = null;
        if (!s.enabled || s.pluginState === 'countdown') return;

        const cur = (window as any).downloadsStore?.m_DownloadOverview;
        if (isActive(cur)) return;
        if (UNINSTALL_STATES.has(cur?.update_state ?? '')) return;

        // If last action was an uninstall, don't shut down
        if (s.cancelledAppId > 0) {
          s.wasDownloading = false;
          return;
        }

        s.wasDownloading = false;
        s.cancelledAppId = 0;
        startCountdown(s);
      }, 4000);

      return;
    }

    if (!s.wasDownloading && s.pluginState !== 'cancelled') {
      if (s.cancelledAppId > 0 && ov?.update_appid !== s.cancelledAppId) s.cancelledAppId = 0;
      s.pluginState = 'idle';
    }
  }

  // Subscribe to download events from Steam
  try {
    const dl = (window as any).SteamClient?.Downloads;
    if (dl?.RegisterForDownloadOverview) {
      s.downloadRegistration = dl.RegisterForDownloadOverview(onOverview);
    }
  } catch { /* SteamClient might not be ready */ }

  // Also poll every 5s as a fallback
  s.pollInterval = setInterval(() => {
    if (!s.enabled || s.pluginState === 'countdown') return;
    onOverview((window as any).downloadsStore?.m_DownloadOverview);
  }, 5000);
}

export function stopPolling(s: PluginStore) {
  if (s.pollInterval) {
    clearInterval(s.pollInterval);
    s.pollInterval = null;
  }
  if (s.downloadRegistration) {
    s.downloadRegistration.unregister();
    s.downloadRegistration = null;
  }
}
