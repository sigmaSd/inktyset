// Automatic updates (electron-updater), as in MedStation's shell/electron/updates.ts: checked at launch and once
// a day, downloaded in the background and verified (sha512), then the window offers "Restart to update": never
// a restart in the middle of proofreading; otherwise it's installed when Inktyset is closed. On Linux only the
// AppImage replaces itself (no root); .deb and .rpm are updated by the system's package manager.
//
// Where updates come from: electron-builder's `publish` (shell/electron/builder.yml: the GitHub releases of
// sigmaSd/inktyset) writes app-update.yml into the package; or INKTYSET_UPDATE_URL, a folder on a web server
// (the "generic" provider), for testing. Neither: no updates, nothing asked.

import { app } from "electron";
import electronUpdater from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";

const { autoUpdater } = electronUpdater;
const DAY = 24 * 60 * 60 * 1000;

/** Whether this copy can update itself (packaged, as an AppImage on Linux, with a source configured). */
function updatable() {
  if (!app.isPackaged) return false;
  if (process.platform === "linux" && !process.env.APPIMAGE) return false; // .deb/.rpm: the package manager's job
  if (process.env.INKTYSET_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: "generic", url: process.env.INKTYSET_UPDATE_URL });
    return true;
  }
  return existsSync(join(process.resourcesPath, "app-update.yml"));
}

/** Start watching for updates; `ready(version)` once one is downloaded and verified. */
export function watchUpdates(ready: (version: string) => void) {
  if (!updatable()) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  autoUpdater.on("update-downloaded", (info) => ready(info.version));
  const check = () =>
    autoUpdater.checkForUpdates().catch((e: Error) => console.error(`Update check: ${e.message}`));
  void check();
  setInterval(() => void check(), DAY);
}

/** Restart into the downloaded version (the user chose to). */
export function installNow() {
  autoUpdater.quitAndInstall();
}
