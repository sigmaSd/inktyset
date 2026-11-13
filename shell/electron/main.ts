// Inktyset in Electron. The main process runs Inktyset itself (src/core.ts) and the small server its window
// talks to (src/server.ts); a hidden window does the image and PDF work with Chromium (render.ts). Closing the
// window while pages are still waiting keeps Inktyset running until they're read, then it quits.
//
//   --dev        print a link that opens the window's page in a normal browser (for testing)
//   --no-window  start without opening the window (testing; stop it with Ctrl+C)
//   --folder=<path>  keep the pages in this folder, for this run only (src/folders.ts)
// INKTYSET_DATA and INKTYSET_USERDATA move the pages folder and the app's own files (testing). The pages folder
// chosen in Settings (src/folders.ts) wins over INKTYSET_DATA only when INKTYSET_USERDATA is set too: a test
// with its own pages folder never opens the folder chosen in the real settings.

import { app, type BrowserWindow, dialog, Menu, Notification, session } from "electron";
import { createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "../../src/core.ts";
import { msg } from "../../src/i18n.ts";
import { folderArg } from "../../src/folders.ts";
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
/** The arguments after the program (and, unpackaged, the app's folder), and a --folder among them. */
const ARGS = folderArg(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());

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

/**
 * The pages folder: the one `given` with --folder; else the one chosen in Settings, when there is one and it can
 * be opened (a removed drive can't); else the usual one, and what went wrong, to tell the user.
 */
function pagesFolder(defaultDir: string, given?: string): [string, { dir: string; error: string }?] {
  if (given) {
    // asked for by name: never silently another folder (a failure stops the start, and says why)
    mkdirSync(given, { recursive: true });
    return [given];
  }
  if (process.env.INKTYSET_DATA && !process.env.INKTYSET_USERDATA) return [defaultDir];
  let dir: string | undefined;
  try {
    dir = JSON.parse(readFileSync(join(app.getPath("userData"), "settings.json"), "utf8")).folder;
  } catch {
    /* no settings yet */
  }
  if (typeof dir !== "string" || !dir) return [defaultDir];
  try {
    mkdirSync(dir, { recursive: true });
    return [dir];
  } catch (e) {
    return [defaultDir, { dir, error: (e as Error).message }];
  }
}

/** Start Inktyset again with these arguments: the new one starts once this one has quit (one Inktyset). */
function restart(args: string[]) {
  app.relaunch({ args: app.isPackaged ? args : [APP_DIR, ...args] });
  app.quit();
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
  // pages shown before 0.7.2 could be in Chromium's cache (in userData, outside the pages folder): emptied
  await ses.clearCache();
  const allowed = new Set(["notifications", "clipboard-sanitized-write"]);
  ses.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const defaultDir = process.env.INKTYSET_DATA ?? join(app.getPath("documents"), "Inktyset");
  const [dataDir, unavailable] = pagesFolder(defaultDir, ARGS.folder);
  if (dataDir === defaultDir) await migrateFromHand2tex(dataDir);
  const core = new Core(dataDir, app.getPath("userData"));
  core.defaultFolder = defaultDir;
  core.folderGiven = !!ARGS.folder;
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
    async chooseFile(title, extensions) {
      const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title,
        properties: ["openFile"],
        filters: [{ name: extensions.join(", "), extensions }],
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
    relaunch() {
      // the folder in the settings now: without the --folder this run was started with
      restart(ARGS.rest);
    },
  };
  core.appVersion = app.getVersion();
  core.systemLocales = app.getPreferredSystemLanguages();
  core.localesDir = join(app.getAppPath(), "locales", "app");
  await core.init();
  if (unavailable) notify(msg("folderUnavailable", { p: unavailable.dir, e: unavailable.error, d: dataDir }));
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
  app.on("second-instance", (_e, argv, cwd) => {
    // started again for another folder (the other launcher): this one restarts there
    // (all of argv: Chromium may put its own switches before the app's folder)
    const again = folderArg(argv.slice(1), cwd);
    const wanted = again.folder ?? pagesFolder(defaultDir)[0];
    if (wanted !== core.lib.dir)
      return restart(again.folder ? [...ARGS.rest, `--folder=${again.folder}`] : ARGS.rest);
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
