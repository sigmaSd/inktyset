// The reading engine: llama.cpp's server with the vision model, on a free port of 127.0.0.1, started by
// hand2tex and stopped with it. Its program is the downloaded one (components/engine) unless a path is set in
// the settings (someone with their own llama.cpp build); the model files likewise (components/model, or a
// folder chosen in the settings).

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { dirOf, findFile, MODEL_FILES } from "./components.ts";

export type ModelStatus = "missing" | "stopped" | "starting" | "ready" | "error";

export interface ModelConfig {
  /** A llama-server the user chose, instead of the downloaded one. */
  serverPath?: string;
  /** A folder holding the model files, instead of the downloaded copy. */
  modelDir?: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export class Model {
  status: ModelStatus = "stopped";
  detail = "";
  #proc: ChildProcess | null = null;
  #url = "";
  #starting: Promise<void> | null = null;
  /** Only hand2tex may use the engine (a web page could otherwise reach 127.0.0.1). */
  readonly #key = randomBytes(24).toString("hex");
  readonly #base: string;
  readonly #changed: () => void;
  config: ModelConfig = {};

  constructor(base: string, changed: () => void) {
    this.#base = base;
    this.#changed = changed;
  }

  #set(status: ModelStatus, detail = "") {
    if (status === this.status && detail === this.detail) return;
    this.status = status;
    this.detail = detail;
    this.#changed();
  }

  async serverPath(): Promise<string | null> {
    if (this.config.serverPath) return existsSync(this.config.serverPath) ? this.config.serverPath : null;
    const name = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    return await findFile(dirOf(this.#base, "engine"), name);
  }

  modelDir() {
    return this.config.modelDir || dirOf(this.#base, "model");
  }

  /** Are the model files there, at the right size? (Their checksums were checked when they arrived.) */
  async modelReady(): Promise<boolean> {
    for (const f of MODEL_FILES) {
      const st = await stat(join(this.modelDir(), f.file)).catch(() => null);
      if (!st || st.size !== f.size) return false;
    }
    return true;
  }

  async missing(): Promise<{ engine: boolean; model: boolean }> {
    return { engine: !(await this.serverPath()), model: !(await this.modelReady()) };
  }

  /** Start the server (once), and wait until it has loaded the model. */
  async ensure(): Promise<string> {
    if (this.status === "ready" && this.#proc) return this.#url;
    this.#starting ??= this.#start().finally(() => (this.#starting = null));
    await this.#starting;
    return this.#url;
  }

  async #start() {
    const bin = await this.serverPath();
    if (!bin || !(await this.modelReady())) {
      this.#set("missing", "The reading engine or the model is not downloaded yet.");
      throw new Error(this.detail);
    }
    await this.#killStale();
    const port = await freePort();
    const dir = this.modelDir();
    const log = createWriteStream(join(this.#base, "engine.log"), { flags: "a" });
    log.write(`\n--- ${new Date().toISOString()} ${bin}\n`);
    const args = [
      "-m",
      join(dir, MODEL_FILES[0].file),
      "--mmproj",
      join(dir, MODEL_FILES[1].file),
      "-ngl",
      "99", // everything on the graphics chip when there is one (Vulkan, Metal); the CPU otherwise
      "-c",
      "12288",
      "-np",
      "1",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--jinja",
      "--reasoning-budget",
      "0",
      "--no-webui",
      "--api-key",
      this.#key,
    ];
    this.#set("starting");
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    proc.stdout?.pipe(log, { end: false });
    proc.stderr?.pipe(log, { end: false });
    this.#proc = proc;
    this.#url = `http://127.0.0.1:${port}`;
    await writeFile(this.#pidFile(), `${proc.pid ?? ""}\n${bin}\n`);
    let exited = false;
    proc.on("exit", (code) => {
      exited = true;
      if (this.#proc === proc) {
        this.#proc = null;
        this.#set("error", `The reading engine stopped (code ${code}). See engine.log.`);
      }
    });
    // loading takes a while (seconds on a graphics chip, longer from a slow disk)
    for (let i = 0; i < 600 && !exited; i++) {
      try {
        const r = await fetch(`${this.#url}/health`);
        if (r.ok) {
          this.#set("ready");
          return;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!exited) proc.kill();
    throw new Error(this.detail || "The reading engine did not start in time.");
  }

  #pidFile() {
    return join(this.#base, "engine.pid");
  }

  /** A server left running by a hand2tex that crashed: stop it (only if it's the program we started). */
  async #killStale() {
    try {
      const [pid, bin] = (await readFile(this.#pidFile(), "utf8")).split("\n");
      const n = Number(pid);
      if (n && process.platform === "linux") {
        const cmd = await readFile(`/proc/${n}/cmdline`, "utf8").catch(() => "");
        if (cmd.startsWith(bin)) process.kill(n);
      } else if (n) {
        try {
          process.kill(n, 0);
          process.kill(n);
        } catch {
          /* already gone */
        }
      }
      await unlink(this.#pidFile());
    } catch {
      /* nothing left over */
    }
  }

  /** Read one page image (JPEG bytes). */
  async read(jpeg: Buffer, prompt: string, signal: AbortSignal) {
    const url = await this.ensure();
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
      temperature: 0,
      top_k: 1,
      repeat_penalty: 1.05,
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false }, // Qwen3.5 thinks by default: we want the transcription
    };
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#key}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) throw new Error(`The reading engine answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const resp = (await r.json()) as {
      choices: { message: { content?: string }; finish_reason?: string }[];
    };
    return { text: resp.choices[0]?.message.content ?? "", finish: resp.choices[0]?.finish_reason ?? "" };
  }

  stop() {
    const p = this.#proc;
    this.#proc = null;
    if (p && p.exitCode === null) p.kill();
    void unlink(this.#pidFile()).catch(() => {});
    this.status = "stopped";
  }
}
