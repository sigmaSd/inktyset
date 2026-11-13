// Image and PDF work for src/core.ts, done by Chromium in a hidden window (app/ui/worker.ts): decoding photos
// (upright, whatever their EXIF says), splitting PDFs into pages and drawing previews with pdf.js. The same on
// every system, nothing to install. Results come back as base64.

import { BrowserWindow } from "electron";
import type { Renderer as CoreRenderer } from "../../src/core.ts";
import type { PictureEdit } from "../../src/picture.ts";

export class Renderer implements CoreRenderer {
  readonly #win: BrowserWindow;
  readonly ready: Promise<void>;

  constructor(origin: string) {
    this.#win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    this.ready = this.#win.loadURL(`${origin}/worker.html`);
  }

  async #call(fn: string, ...args: unknown[]): Promise<unknown> {
    await this.ready;
    const call = `window.render.${fn}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    return await this.#win.webContents.executeJavaScript(call);
  }

  async image(rel: string, maxSide: number) {
    return Buffer.from((await this.#call("image", rel, maxSide)) as string, "base64");
  }

  async pdfPages(rel: string, maxSide: number) {
    return ((await this.#call("pdfPages", rel, maxSide)) as string[]).map((b) => Buffer.from(b, "base64"));
  }

  async pdfPage(rel: string, index: number, maxSide: number) {
    return Buffer.from((await this.#call("pdfPage", rel, index, maxSide)) as string, "base64");
  }

  async edited(rel: string, edit: PictureEdit, maxSide: number) {
    return Buffer.from((await this.#call("edited", rel, edit, maxSide)) as string, "base64");
  }

  async preview(rel: string, dpi: number) {
    return ((await this.#call("preview", rel, dpi)) as string[]).map((b) => Buffer.from(b, "base64"));
  }

  close() {
    if (!this.#win.isDestroyed()) this.#win.destroy();
  }
}
