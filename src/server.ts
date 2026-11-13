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
import { sizeOf, supported } from "./components.ts";
import type { Core } from "./core.ts";
import { CSP, guard, newSecret } from "./guard.ts";
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
      version: core.lib.version,
      pages: core.lib.pages,
      intake: core.lib.intake,
      settings: core.lib.settings,
      languages: Object.entries(LANGS).map(([id, l]) => ({ id, name: l.name })),
      avgSecs: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 90,
      model: { status: core.model.status, detail: core.model.detail },
      phone: core.phone.state,
      scanner: {
        available: core.scanner.available,
        devices: core.scanner.devices,
        looking: core.scanner.looking,
        scanning: core.scanner.scanning,
        error: core.scanner.error,
      },
      folder: core.lib.dir,
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
        modelDir: core.model.modelDir(),
        serverPath: (await core.model.serverPath()) ?? "",
        custom: { serverPath: core.settings.serverPath ?? "", modelDir: core.settings.modelDir ?? "" },
      },
      machine: core.settings,
      update: core.update,
      appVersion: core.appVersion,
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

  /** A file under the data folder (scans, previews, and for the renderer: originals and phone photos). */
  const dataFile = (rel: string) => {
    const root = resolve(core.lib.dir);
    const f = resolve(root, normalize(decodeURIComponent(rel)));
    if (!f.startsWith(root + sep) || !/^(scans|build|originals|phone)[\\/]/.test(f.slice(root.length + 1)))
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
      if (core.lib.version !== seen) {
        seen = core.lib.version;
        res.write(`data: ${seen}\n\n`);
      }
    };
    push();
    const off = core.lib.onChange(push);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clients--;
      off();
      clearInterval(ping);
    });
  };

  const post = async (path: string, req: IncomingMessage): Promise<unknown> => {
    const lib = core.lib;
    if (path === "/api/upload") {
      const name =
        decodeURIComponent(String(req.headers["x-filename"] ?? "file"))
          .split(/[\\/]/)
          .at(-1)!
          .replace(/[^\w.\- ()]/g, "_")
          .slice(0, 120) || "file";
      const dest = join(lib.dir, "originals", `${randomBytes(4).toString("hex")}-${name}`);
      await writeFile(dest, await readBody(req));
      void core.addFile(dest, name, "file");
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
      if (body.tex !== undefined) {
        if (!["auto", "system", "builtin"].includes(String(body.tex))) throw new Error("unknown LaTeX mode");
        machine.tex = String(body.tex);
      }
      if (body.serverPath !== undefined) machine.serverPath = String(body.serverPath).trim() || undefined;
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
    if (path === "/api/setup/model-folder") {
      void core.useModelFolder();
      return { ok: true };
    }
    if (path === "/api/setup/default-model") {
      await core.setSettings({ modelDir: undefined });
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
    if (path === "/api/phone/pair") return (await core.phone.pair(), { ok: true });
    if (path === "/api/phone/revoke") return (await core.phone.revoke(String(body.id)), { ok: true });
    if (path === "/api/scanner/find") return (void core.scanner.find(), { ok: true });
    if (path === "/api/scanner/scan") {
      const device = String(body.device);
      if (!core.scanner.devices.some((d) => d.id === device)) throw new Error("unknown scanner");
      const out = join(lib.dir, "originals", `scan-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      void core.scanner
        .scan(device, out)
        .then(() => core.addFile(out, `Scan ${new Date().toTimeString().slice(0, 5)}`, "scan"))
        .catch(() => {});
      return { ok: true };
    }
    const m = /^\/api\/page\/(page\d+)\/(tex|redo|delete|move|check)$/.exec(path);
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
        Object.assign(p, { status: "queued", err: "", ok: null, pngs: [], rev: p.rev + 1, checked: false });
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
      if (path === "/api/version") return send(res, 200, { version: core.lib.version });
      if (path === "/api/events") return events(req, res);
      if (path === "/api/all.tex") {
        const bodies = await core.lib.doneBodies();
        const text = core.lib.settings.format === "typst" ? typstBodies(bodies) : allBodies(bodies);
        return send(res, 200, text, "text/plain; charset=utf-8");
      }
      const pm = /^\/api\/page\/(page\d+)$/.exec(path);
      if (pm) return send(res, 200, { tex: await core.lib.body(pm[1]) });
      if (path.startsWith("/files/")) {
        const f = dataFile(path.slice("/files/".length));
        if (!f) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": TYPES[extname(f).toLowerCase()] ?? "application/octet-stream" });
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
  return {
    origin: `http://127.0.0.1:${port}`,
    secret,
    clients: () => clients,
    close: () => server.close(),
  };
}
