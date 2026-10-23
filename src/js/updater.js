// In-app update check via the updater plugin (withGlobalTauri exposes
// window.__TAURI__.updater). Browser preview is a no-op.

import { isDesktop } from './bridge.js';
import { toast, errText } from './ui/dom.js';

const UPD = globalThis.__TAURI__?.updater;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const LAST_CHECK = 'updater-last-check';
let installing = false;

export async function checkOnce({ onAvailable, quiet = true } = {}) {
  if (!isDesktop || !UPD) return null;
  try {
    const update = await UPD.check();
    if (update?.available) {
      onAvailable?.({
        version: update.version,
        notes: update.body,
        install: async () => {
          if (installing) return;
          installing = true;
          toast(`Downloading Dispatch ${update.version}…`);
          await update.downloadAndInstall();
          toast('Restarting…');
          globalThis.__TAURI__?.process?.relaunch?.();
        },
      });
      return update;
    }
    if (!quiet) console.info('Dispatch is up to date.');
    return null;
  } catch (e) {
    // Offline or a broken endpoint: never bother the user.
    if (!quiet) console.warn('update check failed', e);
    return null;
  }
}

/** Check on boot only if the last successful check is older than a day. */
export function scheduleUpdateCheck() {
  try {
    const last = Number(localStorage.getItem(LAST_CHECK) || 0);
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
    localStorage.setItem(LAST_CHECK, String(Date.now()));
  } catch { /* no storage */ }
  checkOnce({
    onAvailable: (up) => {
      toast(`Dispatch ${up.version} is available.`, {
        timeout: 30000,
        action: { label: 'Update & restart', onClick: () => up.install() },
      });
    },
  }).catch(() => {});
}