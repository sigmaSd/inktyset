// hand2tex in Electron. The main process runs hand2tex itself (src/core.ts) and the small server its window
// talks to (src/server.ts); a hidden window does the image and PDF work with Chromium (render.ts). Closing the
// window while pages are still waiting keeps hand2tex running until they're read, then it quits.
//
//   --dev        print a link that opens the window's page in a normal browser (for testing)
//   --no-window  start without opening the window (testing; stop it with Ctrl+C)
// HAND2TEX_DATA and HAND2TEX_USERDATA move the pages folder and the app's own files (testing).

import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, session, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "../../src/core.ts";
import { COOKIE, type Served, serve } from "../../src/server.ts";
import { appMenu, contextMenu } from "./menu.ts";
import { Renderer } from "./render.ts";

/** The application's files: the checkout, or the package (this file is dist/app/electron.mjs in both). */
const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DEV = process.argv.includes("--dev");
const NO_WINDOW = process.argv.includes("--no-window");
const ICON = join(APP_DIR, "app", "icon.png");

if (process.env.HAND2TEX_USERDATA) app.setPath("userData", process.env.HAND2TEX_USERDATA);
if (app.isPackaged) app.commandLine.appendSwitch("log-level", "3");

let mainWindow: BrowserWindow | null = null;
let quitting = false;

/**
 * No system title bar: the page's own header takes its place (dragged to move the window, app/ui/style.css
 * header), with the window's buttons drawn over its right end in the header's colours (--bg, --ink), as in
 * MedStation. macOS keeps its own buttons, on the left.
 */
const HEADER_HEIGHT = 52;
const titleBar = () =>
  nativeTheme.shouldUseDarkColors
    ? { color: "#15171c", symbolColor: "#e8e9ec", height: HEADER_HEIGHT }
    : { color: "#f5f3ee", symbolColor: "#1d1f24", height: HEADER_HEIGHT };
/** The page's --bg, behind it while it loads: no flash. */
const background = () => (nativeTheme.shouldUseDarkColors ? "#15171c" : "#f5f3ee");

function createWindow(served: Served, core: Core) {
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    minWidth: 960, // the header (the title bar) keeps its controls on one line
    minHeight: 500,
    title: "hand2tex",
    icon: ICON,
    show: false,
    backgroundColor: background(),
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? {} : { titleBarOverlay: titleBar() }),
    webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("context-menu", (_e, params) =>
    contextMenu(win.webContents, params)?.popup({ window: win }),
  );
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(served.origin)) e.preventDefault();
  });
  win.on("close", (e) => {
    if (quitting || !core.lib.busy()) return;
    // pages still waiting: keep reading them with the window hidden
    e.preventDefault();
    win.hide();
    const n = core.lib.pages.filter((p) => p.status === "queued" || p.status === "working").length;
    notify(`Finishing ${n} page${n === 1 ? "" : "s"} in the background. Open hand2tex to watch.`);
    const off = core.lib.onChange(() => {
      if (core.lib.busy() || win.isVisible()) return;
      off();
      notify("All pages are done.");
      app.quit();
    });
  });
  win.on("closed", () => {
    mainWindow = null;
    if (!quitting) app.quit();
  });
  void win.loadURL(served.origin + "/");
  return win;
}

function notify(body: string) {
  if (Notification.isSupported()) new Notification({ title: "hand2tex", body, icon: ICON }).show();
}

async function main() {
  Menu.setApplicationMenu(appMenu());
  nativeTheme.on("updated", () => {
    // light ↔ dark: the window's buttons follow the header
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBackgroundColor(background());
    if (process.platform !== "darwin") mainWindow.setTitleBarOverlay(titleBar());
  });
  const ses = session.defaultSession;
  const allowed = new Set(["notifications", "clipboard-sanitized-write"]);
  ses.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const dataDir = process.env.HAND2TEX_DATA ?? join(app.getPath("documents"), "hand2tex");
  const core = new Core(dataDir, app.getPath("userData"));
  const served = await serve(core, join(APP_DIR, "app", "ui", "dist"));
  await ses.cookies.set({
    url: served.origin,
    name: COOKIE,
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
        filters: [{ name: "LaTeX", extensions: ["tex"] }],
      });
      if (r.canceled || !r.filePath) return null;
      await writeFile(r.filePath, text);
      return r.filePath;
    },
    notify,
  };
  await core.init();

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
  if (DEV) console.log(`hand2tex: ${served.origin}/?key=${served.secret}`);
  if (!NO_WINDOW) mainWindow = createWindow(served, core);
}

if (!app.requestSingleInstanceLock()) app.quit(); // one hand2tex: a second launch brings the first forward
else {
  app.on("window-all-closed", () => {
    /* the hidden renderer window stays: quitting is decided above */
  });
  app
    .whenReady()
    .then(main)
    .catch((e: Error) => {
      dialog.showErrorBox("hand2tex", `hand2tex could not start: ${e.message}`);
      app.quit();
    });
}
