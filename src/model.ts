// The engine that reads the pages. Three kinds, chosen in Settings:
//   builtin  llama.cpp's server with the downloaded Qwen3.5 9B (components/model, or the same files in a folder
//            chosen in the settings), on a free port of 127.0.0.1, started by Inktyset and stopped with it
//   files    the same server with any vision model llama.cpp runs: a .gguf and its mmproj .gguf
//   server   a model server already running on this computer or the local network (Ollama, LM Studio,
//            llama-server, vLLM…), through its OpenAI-style API. Never a cloud service: src/local.ts.
// The server program is the downloaded one (components/engine) unless a path is set in the settings.

import { msg } from "./i18n.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { dirOf, findFile, MODEL_FILES } from "./components.ts";
import { checkLocalUrl } from "./local.ts";

export type ModelStatus = "missing" | "stopped" | "starting" | "ready" | "error";

export type ModelKind = "builtin" | "files" | "server";

export interface ModelConfig {
  kind?: ModelKind;
  /** A llama-server the user chose, instead of the downloaded one. */
  serverPath?: string;
  /** builtin: a folder holding the model files, instead of the downloaded copy. */
  modelDir?: string;
  /** files: the model and its vision part. */
  modelFile?: string;
  mmprojFile?: string;
  /** server: its address, the model to use there (empty: the server's own), and a key if it needs one. */
  url?: string;
  name?: string;
  apiKey?: string;
}

/** "http://host:11434" or ".../v1/" → "http://host:11434/v1": where the OpenAI-style API is. */
export function apiBase(url: string) {
  const u = url.trim().replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
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
  #url = ""; // the API, ".../v1"
  #starting: Promise<void> | null = null;
  /** Only Inktyset may use the engine (a web page could otherwise reach 127.0.0.1). */
  readonly #key = randomBytes(24).toString("hex");
  readonly #base: string;
  readonly #changed: () => void;
  config: ModelConfig = {};

  get kind(): ModelKind {
    return this.config.kind ?? "builtin";
  }

  /** What reads the pages, as shown on each version. */
  label(): string {
    if (this.kind === "files") return basename(this.config.modelFile ?? "").replace(/\.gguf$/i, "");
    if (this.kind === "server") {
      let host = this.config.url ?? "";
      try {
        host = new URL(host).host;
      } catch {
        /* shown as typed */
      }
      return `${this.config.name || "model"} · ${host}`;
    }
    return "Qwen3.5 9B";
  }

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
    if (this.kind === "server") return !!this.config.url;
    if (this.kind === "files")
      return (
        !!this.config.modelFile &&
        !!this.config.mmprojFile &&
        existsSync(this.config.modelFile) &&
        existsSync(this.config.mmprojFile)
      );
    for (const f of MODEL_FILES) {
      const st = await stat(join(this.modelDir(), f.file)).catch(() => null);
      if (!st || st.size !== f.size) return false;
    }
    return true;
  }

  async missing(): Promise<{ engine: boolean; model: boolean }> {
    // a model server needs no engine of ours
    return {
      engine: this.kind !== "server" && !(await this.serverPath()),
      model: !(await this.modelReady()),
    };
  }

  /** Start the server (once), and wait until it has loaded the model. */
  async ensure(): Promise<string> {
    if (this.status === "ready" && (this.#proc || (this.kind === "server" && this.#url))) return this.#url;
    this.#starting ??= this.#start().finally(() => (this.#starting = null));
    await this.#starting;
    return this.#url;
  }

  async #start() {
    if (this.kind === "server") return await this.#connect();
    const bin = await this.serverPath();
    if (!bin || !(await this.modelReady())) {
      this.#set("missing", msg("notDownloaded"));
      throw new Error(this.detail);
    }
    await this.#killStale();
    const port = await freePort();
    const dir = this.modelDir();
    const log = createWriteStream(join(this.#base, "engine.log"), { flags: "a" });
    log.write(`\n--- ${new Date().toISOString()} ${bin}\n`);
    const own = this.kind === "files";
    const args = [
      "-m",
      own ? this.config.modelFile! : join(dir, MODEL_FILES[0].file),
      "--mmproj",
      own ? this.config.mmprojFile! : join(dir, MODEL_FILES[1].file),
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
      // (thinking is chosen per request: off to read a page, on in the page chat)
      "--no-webui",
      "--api-key",
      this.#key,
    ];
    this.#set("starting");
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    proc.stdout?.pipe(log, { end: false });
    proc.stderr?.pipe(log, { end: false });
    this.#proc = proc;
    this.#url = `http://127.0.0.1:${port}/v1`;
    await writeFile(this.#pidFile(), `${proc.pid ?? ""}\n${bin}\n`);
    let exited = false;
    proc.on("exit", (code) => {
      exited = true;
      if (this.#proc === proc) {
        this.#proc = null;
        this.#set("error", msg("modelStoppedCode", { code }));
      }
    });
    // loading takes a while (seconds on a graphics chip, longer from a slow disk)
    for (let i = 0; i < 600 && !exited; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
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
    throw new Error(this.detail || msg("modelTimeout"));
  }

  /** A model server of the user's: on their own network, and answering. */
  async #connect() {
    const url = this.config.url ?? "";
    this.#set("starting");
    const fail = (text: string) => {
      this.#set("error", text);
      return new Error(text);
    };
    try {
      await checkLocalUrl(url);
    } catch (e) {
      throw fail((e as Error).message);
    }
    try {
      const r = await fetch(`${apiBase(url)}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    } catch (e) {
      throw fail(msg("serverNoAnswer", { url, error: (e as Error).message }));
    }
    this.#url = apiBase(url);
    this.#set("ready");
  }

  #headers(): Record<string, string> {
    const key = this.kind === "server" ? this.config.apiKey : this.#key;
    return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  }

  /** The models a server offers (to choose one in the settings). */
  static async listModels(url: string, apiKey?: string): Promise<string[]> {
    await checkLocalUrl(url);
    const r = await fetch(`${apiBase(url)}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(msg("serverNoAnswer", { url, error: `${r.status} ${r.statusText}` }));
    const data = (await r.json()) as { data?: { id: string }[]; models?: { name: string }[] };
    // llama-server answers in both shapes: each model once
    return [...new Set((data.data ?? []).map((m) => m.id).concat((data.models ?? []).map((m) => m.name)))];
  }

  #pidFile() {
    return join(this.#base, "engine.pid");
  }

  /** A server left running by a Inktyset that crashed: stop it (only if it's the program we started). */
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
    const server = this.kind === "server";
    if (server) await checkLocalUrl(this.config.url ?? ""); // still on the user's network
    const image = {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
    };
    // another program's server: only the standard fields (some refuse the others)
    const body = server
      ? {
          ...(this.config.name ? { model: this.config.name } : {}),
          messages: [{ role: "user", content: [image, { type: "text", text: prompt }] }],
          temperature: 0,
          max_tokens: 4096,
        }
      : {
          messages: [
            {
              role: "user",
              content: [image, { type: "text", text: prompt }],
            },
          ],
          temperature: 0,
          top_k: 1,
          repeat_penalty: 1.05,
          max_tokens: 4096,
          chat_template_kwargs: { enable_thinking: false }, // Qwen3.5 thinks by default: we want the transcription
        };
    const r = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok)
      throw new Error(msg("engineAnswered", { status: r.status, text: (await r.text()).slice(0, 200) }));
    const resp = (await r.json()) as {
      choices: { message: { content?: string }; finish_reason?: string }[];
    };
    return { text: resp.choices[0]?.message.content ?? "", finish: resp.choices[0]?.finish_reason ?? "" };
  }

  /**
   * A chat answer (src/chat.ts), streamed: `onDelta` gets the thinking and the answer so far. Thinking is on
   * for our own engine; another program's server gets only the standard fields and decides.
   */
  async chat(
    messages: unknown[],
    opts: { think: boolean; maxTokens: number; onDelta: (d: { text: string; thinking: string }) => void },
    signal: AbortSignal,
  ) {
    const url = await this.ensure();
    const server = this.kind === "server";
    if (server) await checkLocalUrl(this.config.url ?? "");
    const body = server
      ? {
          ...(this.config.name ? { model: this.config.name } : {}),
          messages,
          stream: true,
          max_tokens: opts.maxTokens,
          temperature: 0.6,
        }
      : {
          messages,
          stream: true,
          max_tokens: opts.maxTokens,
          // Qwen's advice with thinking; without, steadier than its advice (0.7): the chat's fixes must keep to
          // the change format, and at 0.7 one try in three didn't (tested, 2026-11-13)
          temperature: opts.think ? 0.6 : 0.3,
          top_p: opts.think ? 0.95 : 0.8,
          top_k: 20,
          chat_template_kwargs: { enable_thinking: opts.think },
        };
    const r = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok || !r.body)
      throw new Error(msg("engineAnswered", { status: r.status, text: (await r.text()).slice(0, 200) }));
    let raw = "",
      thinking = "",
      finish = "",
      rest = "";
    const decoder = new TextDecoder();
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        try {
          const c = (JSON.parse(data) as { choices?: StreamChoice[] }).choices?.[0];
          raw += c?.delta?.content ?? "";
          thinking += c?.delta?.reasoning_content ?? c?.delta?.reasoning ?? "";
          if (c?.finish_reason) finish = c.finish_reason;
        } catch {
          /* a line that isn't an event: not worth failing for */
        }
      }
      opts.onDelta(splitThinking(raw, thinking));
    }
    return { ...splitThinking(raw, thinking), finish };
  }

  stop() {
    const p = this.#proc;
    this.#proc = null;
    if (p && p.exitCode === null) p.kill();
    void unlink(this.#pidFile()).catch(() => {});
    this.#url = "";
    this.status = "stopped";
  }
}

interface StreamChoice {
  delta?: { content?: string; reasoning_content?: string; reasoning?: string };
  finish_reason?: string | null;
}

/** Servers that don't separate the thinking send it in the answer, between <think> tags: taken out. */
export function splitThinking(raw: string, thinking: string): { text: string; thinking: string } {
  const m = /^\s*<think>([\s\S]*?)(?:<\/think>|$)/.exec(raw);
  if (!m) return { text: raw, thinking };
  return { text: raw.slice(m[0].length).trimStart(), thinking: thinking + m[1] };
}
