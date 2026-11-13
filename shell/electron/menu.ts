// Menus: the right-click menu (cut / copy / paste in a text field, copy on a selection; nothing elsewhere), and
// the application menu (none on Linux and Windows; on macOS the usual one, which carries copy/paste's keys).
// As in MedStation's shell/electron/menu.ts.

import { Menu, type MenuItemConstructorOptions, type WebContents } from "electron";
import { msg } from "../../src/i18n.ts";

export function contextMenu(_wc: WebContents, params: Electron.ContextMenuParams): Menu | null {
  const items: MenuItemConstructorOptions[] = [];
  const f = params.editFlags;
  if (params.isEditable) {
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
