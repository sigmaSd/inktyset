// Inktyset in Electron. The main process runs Inktyset itself (src/core.ts) and the small server its window
// talks to (src/server.ts); a hidden window does the image and PDF work with Chromium (render.ts). Closing the
// window while pages are still waiting keeps Inktyset running until they're read, then it quits.
//
//   --dev        print a link that opens the window's page in a normal browser (for testing)
//   --no-window  start without opening the window (testing; stop it with Ctrl+C)
// INKTYSET_DATA and INKTYSET_USERDATA move the pages folder and the app's own files (testing).

import { app, type BrowserWindow, dialog, Menu, Notification, session } from "electron";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "../../src/core.ts";
import { msg } from "../../src/i18n.ts";
import { migrateDir } from "../../src/migrate.ts";
import { cookieName } from "../../src/guard.ts";
import { type Served, serve } from "../../src/server.ts";
import { appMenu } from "./menu.ts";
import { Renderer } from "./render.ts";
import { installNow, watchUpdates } from "./updates.ts";
import { openWindow } from "./windows.ts";

/** The application's files: the checkout, or the package (this file is dist/app/electron.mjs in both). */
const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DEV = process.argv.includes("--dev");
const NO_WINDOW = process.argv.includes("--no-window");
const ICON = join(APP_DIR, "app", "icon.png");

if (process.env.INKTYSET_USERDATA) app.setPath("userData", process.env.INKTYSET_USERDATA);
if (app.isPackaged) app.commandLine.appendSwitch("log-level", "3");

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function createWindow(served: Served, core: Core) {
  const win = openWindow(served.origin, ICON); // windows.ts: our own title bar, locked down, remembered place
  win.on("close", (e) => {
    if (quitting || !core.lib.busy()) return;
    // pages still waiting: keep reading them with the window hidden
    e.preventDefault();
    win.hide();
    const n = core.lib.pages.filter((p) => p.status === "queued" || p.status === "working").length;
    notify(msg("finishing", { n }));
    const off = core.lib.onChange(() => {
      if (core.lib.busy() || win.isVisible()) return;
      off();
      notify(msg("allDone"));
      app.quit();
    });
  });
  win.on("closed", () => {
    mainWindow = null;
    if (!quitting) app.quit();
  });
  return win;
}

/**
 * The main process's output, kept for when something goes wrong (userData/journal.log, restarted past 5 MB):
 * a desktop app's stderr goes nowhere anyone looks. Still printed too, from a terminal.
 */
function journal() {
  const path = join(app.getPath("userData"), "journal.log");
  let big = false;
  try {
    big = statSync(path).size > 5_000_000;
  } catch {
    /* none yet */
  }
  mkdirSync(app.getPath("userData"), { recursive: true });
  const out = createWriteStream(path, { flags: big ? "w" : "a" });
  out.write(`\n--- ${new Date().toISOString()} Inktyset ${app.getVersion()}\n`);
  for (const level of ["log", "warn", "error"] as const) {
    const print = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      out.write(`${args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" ")}\n`);
      print(...args);
    };
  }
}

function notify(body: string) {
  if (Notification.isSupported()) new Notification({ title: "Inktyset", body, icon: ICON }).show();
}

/** The folders of the app's earlier name (hand2tex) move over once (src/migrate.ts). */
async function migrateFromHand2tex(dataDir: string) {
  const moves: [string, string, string[]?][] = [];
  if (!process.env.INKTYSET_DATA) moves.push([join(app.getPath("documents"), "hand2tex"), dataDir]);
  if (!process.env.INKTYSET_USERDATA) {
    // only hand2tex's own files: Chromium's caches stay behind
    const ours = ["settings.json", "components", "phone", "window.json", "engine.log", "journal.log"];
    moves.push([join(app.getPath("appData"), "hand2tex"), app.getPath("userData"), ours]);
  }
  for (const [from, to, only] of moves) {
    const r = await migrateDir(from, to, only).catch((e: Error) => ({ moved: [], kept: [e.message] }));
    if (r.moved.length) console.log(`Moved from ${from} to ${to}: ${r.moved.join(", ")}`);
    if (r.kept.length)
      console.warn(`Left in ${from} (already in ${to}, or could not move): ${r.kept.join(", ")}`);
  }
}

async function main() {
  journal();
  Menu.setApplicationMenu(appMenu());
  const ses = session.defaultSession;
  const allowed = new Set(["notifications", "clipboard-sanitized-write"]);
  ses.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const dataDir = process.env.INKTYSET_DATA ?? join(app.getPath("documents"), "Inktyset");
  await migrateFromHand2tex(dataDir);
  const core = new Core(dataDir, app.getPath("userData"));
  const served = await serve(core, join(APP_DIR, "app", "ui", "dist"));
  await ses.cookies.set({
    url: served.origin,
    name: cookieName(Number(new URL(served.origin).port)),
    value: served.secret,
    httpOnly: true,
    sameSite: "strict",
  });

  const renderer = new Renderer(served.origin);
  await renderer.ready;
  core.renderer = renderer;
  core.shell = {
    async chooseFolder(title) {
      const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title,
        properties: ["openDirectory"],
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async saveFile(name, text) {
      const r = await dialog.showSaveDialog(mainWindow ?? undefined!, {
        defaultPath: join(app.getPath("documents"), name),
        filters: name.endsWith(".typ")
          ? [{ name: "Typst", extensions: ["typ"] }]
          : [{ name: "LaTeX", extensions: ["tex"] }],
      });
      if (r.canceled || !r.filePath) return null;
      await writeFile(r.filePath, text);
      return r.filePath;
    },
    notify,
    installUpdate: installNow,
  };
  core.appVersion = app.getVersion();
  core.systemLocales = app.getPreferredSystemLanguages();
  core.localesDir = join(app.getAppPath(), "locales", "app");
  await core.init();
  watchUpdates((version) => {
    core.update = version; // offered in the window: "Restart to update"
    core.changed();
  });

  app.on("before-quit", () => {
    quitting = true;
    core.stop();
    renderer.close();
    served.close();
  });
  app.on("second-instance", () => {
    if (!mainWindow) mainWindow = createWindow(served, core);
    mainWindow.show();
    mainWindow.focus();
  });
  if (DEV) console.log(`Inktyset: ${served.origin}/?k=${served.secret}`);
  if (!NO_WINDOW) mainWindow = createWindow(served, core);
}

if (!app.requestSingleInstanceLock()) app.quit(); // one Inktyset: a second launch brings the first forward
else {
  app.on("window-all-closed", () => {
    /* the hidden renderer window stays: quitting is decided above */
  });
  app
    .whenReady()
    .then(main)
    .catch((e: Error) => {
      console.error(e);
      dialog.showErrorBox("Inktyset", msg("couldNotStart", { error: e.message }));
      app.quit();
    });
}
