// hand2tex's window in Electron, as in MedStation's shell/electron/windows.ts: our own title bar (the page's
// header, with the window's buttons drawn over its right end), locked down (no Node in the page, Chromium's
// sandbox, navigation only within the server, other links in the system browser), and its size and position
// remembered (userData/window.json).

import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextMenu } from "./menu.ts";

/**
 * No system title bar: the page's own header takes its place (dragged to move the window, app/ui/style.css
 * header), with the window's buttons drawn over its right end in the header's colours (--bg, --ink). macOS
 * keeps its own buttons, on the left.
 */
const HEADER_HEIGHT = 52;
const titleBar = () =>
  nativeTheme.shouldUseDarkColors
    ? { color: "#15171c", symbolColor: "#e8e9ec", height: HEADER_HEIGHT }
    : { color: "#f5f3ee", symbolColor: "#1d1f24", height: HEADER_HEIGHT };

/** The page's --bg, behind it while it loads: no flash. */
const background = () => (nativeTheme.shouldUseDarkColors ? "#15171c" : "#f5f3ee");

interface Place {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const placeFile = () => join(app.getPath("userData"), "window.json");

/** Where the window was last time, if that's still on a screen. */
function lastPlace(): Place | undefined {
  let p: Place;
  try {
    p = JSON.parse(readFileSync(placeFile(), "utf8")) as Place;
  } catch {
    return undefined; // first start
  }
  const area = screen.getDisplayMatching(p).workArea;
  const visible =
    p.x < area.x + area.width - 100 &&
    p.x + p.width > area.x + 100 &&
    p.y >= area.y - 20 &&
    p.y < area.y + area.height - 100;
  return visible ? p : undefined;
}

function remember(win: BrowserWindow) {
  try {
    writeFileSync(placeFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    /* not worth failing for */
  }
}

let themed: BrowserWindow | null = null;
nativeTheme.on("updated", () => {
  // light ↔ dark: the window's buttons follow the header
  if (!themed || themed.isDestroyed()) return;
  themed.setBackgroundColor(background());
  if (process.platform !== "darwin") themed.setTitleBarOverlay(titleBar());
});

/** The main window, showing the server's page. */
export function openWindow(origin: string, icon: string): BrowserWindow {
  const place = lastPlace();
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    ...(place ? { x: place.x, y: place.y, width: place.width, height: place.height } : {}),
    minWidth: 960, // the header (the title bar) keeps its controls on one line
    minHeight: 500,
    title: "hand2tex",
    icon,
    show: false,
    backgroundColor: background(),
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? {} : { titleBarOverlay: titleBar() }),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  themed = win;
  if (place?.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  let timer: ReturnType<typeof setTimeout> | undefined;
  const keep = () => {
    clearTimeout(timer);
    timer = setTimeout(() => !win.isDestroyed() && remember(win), 500);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"] as const) win.on(ev as "resize", keep);

  const wc = win.webContents;
  const ours = (url: string) => url === origin || url.startsWith(`${origin}/`);
  const external = (url: string) => /^https?:\/\//.test(url) && void shell.openExternal(url);
  wc.setWindowOpenHandler(({ url }) => {
    if (!ours(url)) external(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (ours(url)) return;
    e.preventDefault(); // a dropped file, a link: never in place of the page
    external(url);
  });
  wc.on("context-menu", (_e, params) => contextMenu(wc, params)?.popup({ window: win }));
  void win.loadURL(`${origin}/`);
  return win;
}
