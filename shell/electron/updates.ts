// Automatic updates (electron-updater), as in MedStation's shell/electron/updates.ts: checked at launch and once
// a day, downloaded in the background and verified (sha512), then the window offers "Restart to update": never
// a restart in the middle of proofreading; otherwise it's installed when Inktyset is closed. On Linux only the
// AppImage replaces itself (no root). A .deb or .rpm is only told: the window offers that release's .deb or
// .rpm to download, and the user installs it (no repository for the package manager to watch, and an app that
// installs itself as root is what Linux users trust least). The Flatpak is left to Flathub.
//
// Where updates come from: electron-builder's `publish` (shell/electron/builder.yml: the GitHub releases of
// sigmaSd/inktyset) writes app-update.yml into the package; or INKTYSET_UPDATE_URL, a folder on a web server
// (the "generic" provider), for testing. Neither: no updates, nothing asked.

import { app } from "electron";
import electronUpdater from "electron-updater";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const { autoUpdater } = electronUpdater;
const DAY = 24 * 60 * 60 * 1000;

/** Where the GitHub releases' files are (shell/electron/builder.yml `publish`). */
const RELEASES = "https://github.com/sigmaSd/inktyset/releases/download";

/** On Linux, how this copy was installed: "deb" or "rpm" (electron-builder writes it in the package), else null. */
function linuxPackage(): "deb" | "rpm" | null {
  if (process.platform !== "linux" || process.env.APPIMAGE) return null;
  try {
    const type = readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim();
    return type === "deb" || type === "rpm" ? type : null;
  } catch {
    return null; // the Flatpak (built as a folder), or run from the checkout
  }
}

/** Whether this copy looks for updates (packaged, with a source configured; on Linux an AppImage, .deb or .rpm). */
function updatable() {
  if (!app.isPackaged) return false;
  if (process.platform === "linux" && !process.env.APPIMAGE && !linuxPackage()) return false; // Flathub's job
  if (process.env.INKTYSET_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: "generic", url: process.env.INKTYSET_UPDATE_URL });
    return true;
  }
  return existsSync(join(process.resourcesPath, "app-update.yml"));
}

/**
 * Start watching for updates: `ready(version)` once one is downloaded and verified; for a .deb or .rpm,
 * `out(version, url)` once a newer one is released, `url` its package of the same kind.
 */
export function watchUpdates(ready: (version: string) => void, out: (version: string, url: string) => void) {
  if (!updatable()) return;
  const pkg = linuxPackage();
  autoUpdater.autoDownload = !pkg;
  autoUpdater.autoInstallOnAppQuit = !pkg;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  autoUpdater.on("update-downloaded", (info) => ready(info.version));
  if (pkg)
    autoUpdater.on("update-available", (info) => {
      const file = info.files.find((f) => f.url.endsWith(`.${pkg}`))?.url;
      if (!file) return;
      const feed = process.env.INKTYSET_UPDATE_URL;
      out(
        info.version,
        feed ? new URL(file, feed.replace(/\/?$/, "/")).href : `${RELEASES}/v${info.version}/${file}`,
      );
    });
  const check = () =>
    autoUpdater.checkForUpdates().catch((e: Error) => console.error(`Update check: ${e.message}`));
  void check();
  setInterval(() => void check(), DAY);
}

/** Restart into the downloaded version (the user chose to). */
export function installNow() {
  autoUpdater.quitAndInstall();
}
