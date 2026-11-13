// Photos from a phone running Folder Camera (optional, off unless turned on in Settings): Folder Camera's
// receiver engine, inside Inktyset with its own pairing, so a Folder Camera receiver you run separately is never
// touched. Photos arrive in <data>/phone/; each new one becomes a page.

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Receiver } from "folder-camera-receiver";

export interface PhoneState {
  enabled: boolean;
  status: string; // "off", "starting", "ready", "error"
  error: string | null;
  endpoint: string | null;
  pairingExpiresAt: number | null;
  qr: string | null;
  devices: { id: string; name: string }[];
}

const OFF: PhoneState = {
  enabled: false,
  status: "off",
  error: null,
  endpoint: null,
  pairingExpiresAt: null,
  qr: null,
  devices: [],
};

export class Phone {
  state: PhoneState = OFF;
  #receiver: Receiver | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];
  readonly #stateDir: string;
  readonly #photos: string;
  readonly #changed: () => void;
  readonly #arrived: (path: string, rel: string) => void;
  readonly #seen: (rel: string) => boolean;

  constructor(opts: {
    stateDir: string;
    photos: string;
    changed: () => void;
    arrived: (path: string, rel: string) => void;
    seen: (rel: string) => boolean;
  }) {
    this.#stateDir = opts.stateDir;
    this.#photos = opts.photos;
    this.#changed = opts.changed;
    this.#arrived = opts.arrived;
    this.#seen = opts.seen;
  }

  #snapshot() {
    const r = this.#receiver;
    if (!r) return;
    const s = r.snapshot();
    const next: PhoneState = {
      enabled: true,
      status: s.status,
      error: s.error,
      endpoint: s.endpoint,
      pairingExpiresAt: s.pairing?.expiresAt ?? null,
      qr: s.qr,
      devices: s.devices.filter((d) => !d.revoked).map((d) => ({ id: d.id, name: d.name })),
    };
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next;
      this.#changed();
    }
  }

  async start() {
    if (this.#receiver) return;
    this.state = { ...OFF, enabled: true, status: "starting" };
    this.#changed();
    try {
      const r = new Receiver(this.#stateDir, new Map([["--root", this.#photos]]));
      await r.init();
      await r.start();
      this.#receiver = r;
      this.#timers.push(setInterval(() => this.#snapshot(), 1000));
      this.#timers.push(setInterval(() => void r.refreshNetwork().catch(() => {}), 5000));
      this.#timers.push(setInterval(() => void this.#scan(), 2000));
      this.#snapshot();
    } catch (e) {
      this.state = { ...OFF, enabled: true, status: "error", error: (e as Error).message };
      this.#changed();
    }
  }

  async stop() {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    const r = this.#receiver;
    this.#receiver = null;
    this.state = OFF;
    this.#changed();
    await r?.close().catch(() => {});
  }

  async pair() {
    await this.#receiver?.pair();
    this.#snapshot();
  }

  async revoke(id: string) {
    await this.#receiver?.revoke(id);
    this.#snapshot();
  }

  /** New photos in the phone folder (the receiver publishes each one whole, when it's verified). */
  async #scan() {
    let entries;
    try {
      entries = await readdir(this.#photos, { withFileTypes: true, recursive: true });
    } catch {
      return;
    }
    const found: { path: string; rel: string; mtime: number }[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const path = join(e.parentPath, e.name);
      const rel = relative(this.#photos, path);
      if (rel.split(/[\\/]/).some((part) => part.startsWith("."))) continue; // the receiver's partial files
      if (!/\.(jpe?g|png|webp|pdf)$/i.test(e.name) || this.#seen(rel)) continue;
      found.push({ path, rel, mtime: (await stat(path)).mtimeMs });
    }
    for (const f of found.sort((a, b) => a.mtime - b.mtime)) this.#arrived(f.path, f.rel);
  }
}
