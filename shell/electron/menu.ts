// Menus: the right-click menu (cut / copy / paste in a text field, copy on a selection, the file's path on a scan
// or a preview; nothing elsewhere), and the application menu (none on Linux and Windows; on macOS the usual one,
// which carries copy/paste's keys).
// As in MedStation's shell/electron/menu.ts.

import { clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { msg } from "../../src/i18n.ts";

/** `fileAt`: the file on disk behind an image of the window (src/server.ts), or null. */
export function contextMenu(
  _wc: WebContents,
  params: Electron.ContextMenuParams,
  fileAt: (url: string) => string | null,
): Menu | null {
  const items: MenuItemConstructorOptions[] = [];
  const f = params.editFlags;
  const file = params.mediaType === "image" && params.srcURL ? fileAt(params.srcURL) : null;
  if (file) {
    items.push({ label: msg("copyFilePath"), click: () => clipboard.writeText(file) });
    // a preview's picture: its PDF is beside it (src/tex.ts, src/typst.ts)
    const pdf = join(dirname(file), "doc.pdf");
    if (/^render-\d+\.png$/.test(basename(file)) && existsSync(pdf))
      items.push({ label: msg("copyPdfPath"), click: () => clipboard.writeText(pdf) });
  } else if (params.isEditable) {
    items.push(
      { label: msg("cut"), role: "cut", enabled: f.canCut },
      { label: msg("copy"), role: "copy", enabled: f.canCopy },
      { label: msg("paste"), role: "paste", enabled: f.canPaste },
      { type: "separator" },
      { label: msg("selectAll"), role: "selectAll", enabled: f.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ label: msg("copy"), role: "copy" });
  }
  return items.length ? Menu.buildFromTemplate(items) : null;
}

export function appMenu(): Menu | null {
  if (process.platform !== "darwin") return null;
  return Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]);
}
