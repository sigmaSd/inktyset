// Scanning (optional): SANE's scanimage, where it's installed (Linux, macOS). The Scan button only shows when a
// scanner is found.

import { stat } from "node:fs/promises";
import { run, which } from "./run.ts";

export class Scanner {
  devices: { id: string; name: string }[] = [];
  looking = false;
  scanning = false;
  error = "";
  readonly available = which("scanimage") !== null;
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  async find() {
    if (this.looking || !this.available) return;
    this.looking = true;
    this.#changed();
    const r = await run("scanimage", ["-f", "%d\t%v %m%n"], { timeoutMs: 60_000 });
    this.devices = r.stdout
      .split("\n")
      .filter((l) => l.includes("\t"))
      .map((l) => {
        const [id, name] = l.split("\t");
        return { id, name: name.trim() || id };
      });
    this.looking = false;
    this.#changed();
  }

  /** Scan one page into `out` (PNG). Tries 300 dpi grayscale, then simpler settings scanners accept. */
  async scan(device: string, out: string) {
    if (this.scanning) throw new Error("A scan is already running.");
    this.scanning = true;
    this.error = "";
    this.#changed();
    try {
      let last = "";
      for (const opts of [["--resolution", "300", "--mode", "Gray"], ["--resolution", "300"], []]) {
        const r = await run("scanimage", ["-d", device, "--format=png", "-o", out, ...opts], {
          timeoutMs: 300_000,
        });
        if (r.code === 0 && (await stat(out).catch(() => null))?.size) return;
        last = r.stderr.trim().split("\n").at(-1) ?? "";
      }
      throw new Error(`The scanner did not respond: ${last || "scan failed"}`);
    } catch (e) {
      this.error = (e as Error).message;
      throw e;
    } finally {
      this.scanning = false;
      this.#changed();
    }
  }
}
