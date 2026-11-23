// The window's way in: a small HTTP server on 127.0.0.1 (a random port) serving the built pages (app/ui/dist),
// the pages' images, a JSON API and a stream of change notices. Only Inktyset's own windows can use it: they
// carry a secret cookie that the shell sets (src/guard.ts; --dev prints a link that sets it in a normal browser).
// Changes come only as POSTs with an X-Inktyset header from the same origin, so no web page can make them.

import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ComponentId } from "./components.ts";
import { bundled, sizeOf, supported } from "./components.ts";
import { currentLang, msg, nativeName } from "./i18n.ts";
import { type Core, DEFAULT_PROMPT } from "./core.ts";
import { Model } from "./model.ts";
import { CSP, guard, newSecret } from "./guard.ts";
import { checkLocalUrl } from "./local.ts";
import type { Page } from "./library.ts";
import { latexToTypst } from "./convert.ts";
import { allBodies, fullDocument, LANGS } from "./pipeline.ts";
import { typstBodies, typstDocument } from "./typst.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface Served {
  origin: string;
  secret: string;
  /** How many windows listen to the change stream (a window closed in a browser: it drops to 0). */
  clients: () => number;
  close: () => void;
  /** The file on disk behind one of this server's addresses (a scan, a preview), for its right-click menu. */
  fileAt: (url: string) => string | null;
}

function readBody(req: IncomingMessage, limit = 200 << 20): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function serve(core: Core, uiDir: string): Promise<Served> {
  const secret = newSecret();
  let clients = 0;
  let port = 0;

  const send = (res: ServerResponse, code: number, body: unknown, type = "application/json", extra = {}) => {
    const data =
      typeof body === "string" || Buffer.isBuffer(body)
        ? body
        : body === undefined
          ? ""
          : JSON.stringify(body);
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra });
    res.end(data);
  };

  const state = async () => {
    const done = core.lib.pages.filter((p) => p.secs).map((p) => p.secs!);
    const recent = done.slice(-10);
    const jobs = Object.fromEntries(
      Object.entries(core.jobs).map(([k, j]) => [
        k,
        { status: j.status, progress: j.progress, error: j.error },
      ]),
    );
    return {
      version: core.version,
      sessions: await core.sessions(),
      session: core.session,
      pages: core.lib.pages,
      intake: core.lib.intake,
      settings: core.lib.settings,
      languages: Object.entries(LANGS).map(([id, l]) => ({ id, name: l.name })),
      avgSecs: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 90,
      model: {
        status: core.model.status,
        detail: core.model.detail,
        kind: core.model.kind,
        label: core.model.label(),
      },
      reading: {
        defaultPrompt: DEFAULT_PROMPT,
        prompt: core.settings.prompt ?? "",
        instructions: core.settings.instructions ?? "",
        added: core.promptAddition().trim(), // shown as it is sent, after the instructions
      },
      phone: core.phone.state,
      scanner: {
        available: core.scanner.available,
        devices: core.scanner.devices,
        looking: core.scanner.looking,
        scanning: core.scanner.scanning,
        error: core.scanner.error,
      },
      folder: core.folder,
      folders: { default: core.defaultFolder, given: core.folderGiven },
      setup: {
        missing: core.missing,
        jobs,
        sizes: {
          engine: sizeOf("engine"),
          model: sizeOf("model"),
          tectonic: sizeOf("tectonic"),
          typst: sizeOf("typst"),
        },
        supported: { engine: supported("engine"), tectonic: supported("tectonic") },
        // the programs the package ships (the Flatpak): never downloaded, and shown as included
        bundled: { engine: !!bundled("engine"), tectonic: !!bundled("tectonic"), typst: !!bundled("typst") },
        modelDir: core.model.modelDir(),
        serverPath: (await core.model.serverPath()) ?? "",
        custom: { serverPath: core.settings.serverPath ?? "", modelDir: core.settings.modelDir ?? "" },
      },
      machine: core.settings,
      update: core.update,
      release: core.release,
      appVersion: core.appVersion,
      ui: {
        lang: currentLang(),
        setting: core.settings.ui ?? "auto",
        available: ["en", ...Object.keys(core.locales)].map((code) => ({ code, name: nativeName(code) })),
      },
      hardware: core.hardware,
      tex: {
        mode: core.tex.mode,
        using: core.tex.using,
        detail: core.tex.detail,
        system: core.tex.system,
        tectonic: (await core.tex.tectonic()) ?? "",
      },
      typst: {
        system: core.typst.system ?? "",
        downloaded: (await core.typst.downloaded()) ?? "",
        using: core.typst.using,
      },
    };
  };

  /**
   * A file of a session (scans, previews, and for the renderer: originals and phone photos): the window asks
   * for the open session's (/files/), the renderer for any session's, from the pages folder (/data/: the work
   * it does may be for a session left meanwhile).
   */
  const dataFile = (rel: string, from: "session" | "folder") => {
    const root = resolve(from === "session" ? core.lib.dir : core.folder);
    const f = resolve(root, normalize(decodeURIComponent(rel)));
    const inside = from === "session" ? "" : "(?:sessions[\\\\/][^\\\\/]+[\\\\/])?";
    if (
      !f.startsWith(root + sep) ||
      !new RegExp(`^${inside}(scans|build|originals|phone|chats)[\\\\/]`).test(f.slice(root.length + 1))
    )
      return null;
    return existsSync(f) && statSync(f).isFile() ? f : null;
  };

  const staticFile = (path: string) => {
    const f = resolve(uiDir, "." + normalize(path === "/" ? "/index.html" : path));
    return f.startsWith(resolve(uiDir) + sep) && existsSync(f) && statSync(f).isFile() ? f : null;
  };

  const events = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    clients++;
    let seen = -1;
    const push = () => {
      if (core.version !== seen) {
        seen = core.version;
        res.write(`data: ${seen}\n\n`);
      }
    };
    push();
    const off = core.onChange(push);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clients--;
      off();
      clearInterval(ping);
    });
  };

  const post = async (path: string, req: IncomingMessage): Promise<unknown> => {
    const lib = core.lib;
    /** Back in the queue, read from the start (the text it has now stays, as a version). */
    const readAgain = (p: Page) =>
      Object.assign(p, { status: "queued", err: "", ok: null, pngs: [], rev: p.rev + 1, checked: false });
    if (path === "/api/upload") {
      const name =
        decodeURIComponent(String(req.headers["x-filename"] ?? "file"))
          .split(/[\\/]/)
          .at(-1)!
          .replace(/[^\w.\- ()]/g, "_")
          .slice(0, 120) || "file";
      const dest = join(lib.dir, "originals", `${randomBytes(4).toString("hex")}-${name}`);
      await writeFile(dest, await readBody(req));
      void core.addFile(dest, name, "file", lib);
      return { ok: true };
    }
    const body = JSON.parse((await readBody(req, 5 << 20)).toString() || "{}") as Record<string, unknown>;
    if (path === "/api/settings") {
      if (body.format !== undefined) {
        if (body.format !== "latex" && body.format !== "typst") throw new Error("unknown format");
        await core.setFormat(body.format);
      }
      if (body.language !== undefined) {
        const lang = String(body.language).trim();
        if (!/^[^\\{}$%#&~^_\n]{1,40}$/.test(lang)) throw new Error("language name not allowed");
        await core.setLanguage(LANGS[lang.toLowerCase()] ? lang.toLowerCase() : lang);
      }
      const machine: Record<string, unknown> = {};
      if (body.phone !== undefined) machine.phone = Boolean(body.phone);
      if (body.goToSource !== undefined) machine.goToSource = Boolean(body.goToSource);
      if (body.tex !== undefined) {
        if (!["auto", "system", "builtin"].includes(String(body.tex))) throw new Error("unknown LaTeX mode");
        machine.tex = String(body.tex);
      }
      if (body.ui !== undefined) {
        if (!["auto", "en", ...Object.keys(core.locales)].includes(String(body.ui)))
          throw new Error("unknown app language");
        machine.ui = String(body.ui);
      }
      if (body.serverPath !== undefined) machine.serverPath = String(body.serverPath).trim() || undefined;
      // the instructions (an empty one means Inktyset's own) and the model
      const text = (k: string, max: number) => {
        if (body[k] === undefined) return;
        const v = String(body[k] ?? "");
        if (v.length > max) throw new Error(`${k} is too long`);
        machine[k] = v.trim() ? v : undefined;
      };
      text("instructions", 4000);
      text("prompt", 20000);
      if (body.modelKind !== undefined) {
        if (!["builtin", "files", "server"].includes(String(body.modelKind)))
          throw new Error("unknown model kind");
        machine.modelKind = String(body.modelKind);
      }
      text("serverModel", 200);
      text("serverKey", 400);
      if (body.serverUrl !== undefined) {
        const url = String(body.serverUrl).trim();
        if (url) await checkLocalUrl(url); // src/local.ts: never a cloud service
        machine.serverUrl = url || undefined;
      }
      if (Object.keys(machine).length) await core.setSettings(machine);
      return { ok: true };
    }
    if (path === "/api/setup/download") {
      const id = String(body.id) as ComponentId;
      if (!["engine", "model", "tectonic"].includes(id)) throw new Error("unknown component");
      core.download(id);
      return { ok: true };
    }
    if (path === "/api/setup/cancel") {
      core.cancel(String(body.id) as ComponentId);
      return { ok: true };
    }
    if (path === "/api/folder") {
      // one the user picks, or the usual one
      await core.useFolder(body.usual === true);
      return { ok: true };
    }
    if (path === "/api/setup/model-folder") {
      void core.useModelFolder();
      return { ok: true };
    }
    if (path === "/api/setup/default-model") {
      await core.setSettings({ modelDir: undefined });
      return { ok: true };
    }
    if (path === "/api/model/file") {
      const which = String(body.which);
      if (which !== "model" && which !== "mmproj") throw new Error("unknown file");
      void core.chooseModelFile(which);
      return { ok: true };
    }
    if (path === "/api/model/list")
      return { models: await Model.listModels(String(body.url ?? ""), String(body.key ?? "") || undefined) };
    if (path === "/api/trial") {
      if (!Array.isArray(body.ids)) throw new Error("ids expected");
      core.tryOn(body.ids.map(String));
      return { ok: true };
    }
    if (path === "/api/trial/cancel") return (core.cancelTrials(), { ok: true });
    // compare models (src/showdown.ts)
    if (path === "/api/showdown/add" || path === "/api/showdown/edit") {
      const kind = String(body.kind);
      if (kind !== "builtin" && kind !== "files" && kind !== "server") throw new Error("unknown kind");
      const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
      const column = {
        kind,
        modelFile: str("modelFile"),
        mmprojFile: str("mmprojFile"),
        url: str("url"),
        name: str("name"),
        apiKey: str("apiKey"),
        think: body.think === true,
        prompt: str("prompt"), // none: Settings' instructions
      } as const;
      if (path === "/api/showdown/edit")
        return (await core.showdown.edit(String(body.id), column), { id: body.id });
      return { id: await core.showdown.add(column) };
    }
    if (path === "/api/showdown/duplicate") return { id: await core.showdown.duplicate(String(body.id)) };
    if (path === "/api/showdown/choose") {
      const which = String(body.which);
      if (which !== "model" && which !== "mmproj") throw new Error("unknown file");
      const file = await core.shell.chooseFile(
        msg(which === "model" ? "chooseModelFile" : "chooseMmprojFile"),
        ["gguf"],
      );
      return { file: file ?? "" };
    }
    if (path === "/api/showdown/remove")
      return (await core.showdown.remove(String(body.id), lib), { ok: true });
    if (path === "/api/showdown/use") return (await core.showdown.use(String(body.id)), { ok: true });
    if (path === "/api/showdown/read") {
      const cells = Array.isArray(body.cells)
        ? (body.cells as { contender: unknown; page: unknown }[]).map((c) => ({
            contender: String(c.contender),
            page: String(c.page),
          }))
        : "missing";
      await core.showdown.queue(lib, cells);
      return { ok: true };
    }
    if (path === "/api/showdown/stop") {
      const cell = body.contender
        ? { contender: String(body.contender), page: String(body.page) }
        : undefined;
      return (core.showdown.stop(lib, cell), { ok: true });
    }
    if (path === "/api/showdown/keep")
      return { version: await core.showdown.keep(lib, String(body.contender), String(body.page)) };
    if (path === "/api/redo") {
      // Read again on the main window: these finished pages are read again, their text replaced (kept as a
      // version)
      if (!Array.isArray(body.ids)) throw new Error("ids expected");
      for (const id of body.ids.map(String)) {
        const p = lib.get(id);
        if (p?.status === "done") readAgain(p);
      }
      lib.changed();
      core.wake();
      return { ok: true };
    }
    if (path === "/api/install-update") {
      if (!core.update) throw new Error("no update is ready");
      core.shell.installUpdate();
      return { ok: true };
    }
    if (path === "/api/save-document") {
      const typst = lib.settings.format === "typst";
      const bodies = await lib.doneBodies();
      const text = typst
        ? typstDocument(bodies, lib.settings.language)
        : fullDocument(bodies, lib.settings.language);
      const saved = await core.shell.saveFile(typst ? "inktyset.typ" : "inktyset.tex", text);
      return { path: saved };
    }
    if (path === "/api/session/new") return { id: await core.newSession(String(body.name ?? "")) };
    const sa = /^\/api\/session\/(open|rename|delete)$/.exec(path);
    if (sa) {
      const id = String(body.id ?? "");
      if (sa[1] === "open") await core.openSession(id);
      else if (sa[1] === "rename") return { id: await core.renameSession(id, String(body.name ?? "")) };
      else await core.deleteSession(id);
      return { ok: true };
    }
    if (path === "/api/phone/pair") return (await core.phone.pair(), { ok: true });
    if (path === "/api/phone/revoke") return (await core.phone.revoke(String(body.id)), { ok: true });
    if (path === "/api/scanner/find") return (void core.scanner.find(), { ok: true });
    if (path === "/api/scanner/scan") {
      const device = String(body.device);
      if (!core.scanner.devices.some((d) => d.id === device)) throw new Error("unknown scanner");
      const out = join(lib.dir, "originals", `scan-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      void core.scanner
        .scan(device, out)
        .then(() =>
          core.addFile(out, msg("scanLabel", { time: new Date().toTimeString().slice(0, 5) }), "scan", lib),
        )
        .catch(() => {});
      return { ok: true };
    }
    const vm = /^\/api\/page\/(page\d+)\/version\/(v\d+)\/(use|delete|preview)$/.exec(path);
    if (vm) {
      const [, id, vid, action] = vm;
      if (action === "use") await core.useVersion(id, vid);
      else if (action === "delete") await core.deleteVersion(id, vid);
      else void core.versionPreview(id, vid);
      return { ok: true };
    }
    if (path === "/api/stop-all") {
      await core.stopPages(lib.pages.map((p) => p.id));
      return { ok: true };
    }
    const pic = /^\/api\/page\/(page\d+)\/picture$/.exec(path);
    if (pic) {
      // {} → where Edit picture starts from; {edit, readAgain} → the picture fixed
      if (body.edit === undefined) return await core.picture(pic[1]);
      await core.editPicture(pic[1], body.edit, body.readAgain === true);
      return { ok: true };
    }
    const ch = /^\/api\/chat\/(page\d+)\/(ask|now|stop|apply|dismiss|delete|new)$/.exec(path);
    if (ch) {
      const [, id, action] = ch;
      if (action === "new") return { chat: await core.newChat(id) };
      // which of the page's chats
      const chat = String(body.chat ?? "");
      if (!/^c\d+$/.test(chat)) throw new Error("no such chat");
      if (action === "ask") {
        const regions = (Array.isArray(body.regions) ? body.regions : []).map(
          (r: Record<string, unknown>) => ({
            data: String(r.data ?? ""),
            w: Number(r.w) || 0,
            h: Number(r.h) || 0,
            from: String(r.from ?? "scan"),
          }),
        );
        const text = String(body.text ?? "").slice(0, 8000);
        if (!text.trim() && !regions.length && body.preview !== true) throw new Error("nothing asked");
        await core.ask(id, chat, text, regions, body.preview === true);
      } else if (action === "now") core.answerNow(id, chat);
      else if (action === "stop") core.stopChat(id, chat);
      else if (action === "apply") await core.applyProposal(id, chat, Number(body.n));
      else if (action === "dismiss") await core.dismissProposal(id, chat, Number(body.n));
      else await core.deleteChat(id, chat);
      return { ok: true };
    }
    if (path === "/api/read-stopped") {
      core.readStopped(lib.pages.map((p) => p.id));
      return { ok: true };
    }
    const m = /^\/api\/page\/(page\d+)\/(tex|redo|delete|move|check|seen|stop|read)$/.exec(path);
    if (m) {
      const [, id, action] = m;
      const p = lib.get(id);
      if (!p) throw Object.assign(new Error("no such page"), { code: 404 });
      if (action === "tex") {
        if (p.status !== "done") throw Object.assign(new Error("page is not ready"), { code: 409 });
        await writeFile(lib.pathOf(id), String(body.tex ?? ""));
        void core.compile(id);
      } else if (action === "redo") {
        if (p.status === "working") throw Object.assign(new Error("page is being read"), { code: 409 });
        readAgain(p);
        core.wake();
      } else if (action === "delete") {
        core.cancelReading(id);
        lib.pages.splice(lib.pages.indexOf(p), 1);
      } else if (action === "move") {
        const i = lib.pages.indexOf(p);
        const j = Math.max(0, Math.min(lib.pages.length - 1, i + Number(body.by ?? 0)));
        lib.pages.splice(j, 0, lib.pages.splice(i, 1)[0]);
      } else if (action === "check") {
        p.checked = Boolean(body.checked ?? true);
      } else if (action === "seen") {
        p.fresh = undefined; // its trial version was looked at
      } else if (action === "stop") {
        await core.stopPages([id]);
      } else if (action === "read") {
        core.readStopped([id]);
      }
      lib.changed();
      return { ok: true };
    }
    throw Object.assign(new Error("not found"), { code: 404 });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const refused = guard(req, secret, port); // src/guard.ts: only Inktyset's own windows
      if (refused) {
        res.writeHead(refused.status, refused.headers);
        return void res.end(refused.body);
      }

      if (req.method === "POST") {
        // our own pages send this header: a plain form from elsewhere can't
        if (req.headers["x-inktyset"] !== "1") return send(res, 403, { error: "Access refused" });
        try {
          return send(res, 200, await post(path, req));
        } catch (e) {
          const err = e as Error & { code?: number };
          return send(res, typeof err.code === "number" ? err.code : 500, { error: err.message });
        }
      }

      if (path === "/api/state") return send(res, 200, await state());
      if (path === "/api/version") return send(res, 200, { version: core.version });
      // the window's words in the app's language (its English is in the window itself)
      if (path === "/api/i18n")
        return send(res, 200, { lang: currentLang(), catalog: core.locales[currentLang()] ?? null });
      if (path === "/api/events") return events(req, res);
      if (path === "/api/all.tex") {
        const bodies = await core.lib.doneBodies();
        const text = core.lib.settings.format === "typst" ? typstBodies(bodies) : allBodies(bodies);
        return send(res, 200, text, "text/plain; charset=utf-8");
      }
      const cm = /^\/api\/chat\/(page\d+)$/.exec(path);
      if (cm) {
        // one of the page's chats (?c=c2; else the newest, or a new one), the list of them, and the page's
        // text (which a rewrite is compared with)
        const list = await core.chats(cm[1]);
        const asked = url.searchParams.get("c") ?? "";
        const chat = /^c\d+$/.test(asked) ? asked : (list[0]?.id ?? (await core.newChat(cm[1])));
        return send(res, 200, {
          ...(await core.chat(cm[1], chat)),
          ...core.chatState(cm[1], chat),
          chats: list,
          text: await core.lib.body(cm[1]),
        });
      }
      // go to the source (a point of the preview → a line) and back (a line → where it is on the preview)
      const sm = /^\/api\/page\/(page\d+)\/(source|spots)$/.exec(path);
      if (sm) {
        const q = (k: string) => Number(url.searchParams.get(k));
        if (sm[2] === "source")
          return send(res, 200, { line: await core.sourceLine(sm[1], q("sheet"), q("x"), q("y")) });
        return send(res, 200, { spots: await core.previewSpots(sm[1], q("line")) });
      }
      if (path === "/api/showdown") return send(res, 200, await core.showdown.state(core.lib));
      // one reading of the showdown: its text, its thinking, and the user's text it is scored against
      if (path === "/api/showdown/cell") {
        const c = url.searchParams.get("c") ?? "",
          pg = url.searchParams.get("p") ?? "";
        if (!core.showdown.contenders.some((x) => x.id === c) || !core.lib.get(pg))
          return send(res, 404, { error: "no such reading" });
        return send(res, 200, {
          text: await core.showdown.text(core.lib, c, pg),
          thinking: await core.showdown.thinking(core.lib, c, pg),
          answer: await core.showdown.answer(core.lib, pg),
        });
      }
      const pm = /^\/api\/page\/(page\d+)$/.exec(path);
      if (pm) return send(res, 200, { tex: await core.lib.body(pm[1]) });
      // a version's text (LaTeX, or the Typst shown), and the instructions it was read with
      const vg = /^\/api\/page\/(page\d+)\/version\/(v\d+)$/.exec(path);
      if (vg) {
        const p = core.lib.get(vg[1]);
        const v = p?.versions?.find((x) => x.id === vg[2]);
        if (!p || !v) return send(res, 404, { error: "no such version" });
        const typst = (p.format ?? "latex") === "typst";
        const latex = await core.lib.versionText(p, v.id);
        const tex = typst ? (await core.lib.versionText(p, v.id, "typ")) || latexToTypst(latex) : latex;
        return send(res, 200, { tex, prompt: core.lib.prompts[v.prompt] ?? "" });
      }
      if (path.startsWith("/files/") || path.startsWith("/data/")) {
        const files = path.startsWith("/files/");
        const f = dataFile(path.slice(files ? 7 : 6), files ? "session" : "folder");
        if (!f) return send(res, 404, { error: "not found" });
        // no-store: a page's scan or preview is never copied to Chromium's cache, outside the pages folder
        res.writeHead(200, {
          "content-type": TYPES[extname(f).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        return void createReadStream(f).pipe(res);
      }
      const f = staticFile(path);
      if (f) {
        const type = TYPES[extname(f).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
          ...(type.startsWith("text/html") ? { "content-security-policy": CSP } : {}),
        });
        return void createReadStream(f).pipe(res);
      }
      send(res, 404, { error: "not found" });
    })().catch((e: Error) => {
      if (!res.headersSent) send(res, 500, { error: e.message });
    });
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    secret,
    clients: () => clients,
    close: () => server.close(),
    fileAt: (url) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      if (u.origin !== origin) return null;
      if (u.pathname.startsWith("/files/")) return dataFile(u.pathname.slice(7), "session");
      if (u.pathname.startsWith("/data/")) return dataFile(u.pathname.slice(6), "folder");
      return null;
    },
  };
}
