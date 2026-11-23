// What Inktyset downloads on first use, pinned and checksummed: the engine (llama.cpp's server, the
// build for this system), the model (two files), Tectonic (a self-contained LaTeX, only when no working TeX
// is installed) and Typst (for Typst output, when none is installed). Downloads resume after an interruption
// and are checked (SHA-256) before use. A package may ship the three programs instead (bundledDir below: the
// Flatpak does); then only the model is downloaded. The Flatpak's manifest (flatpak/) builds the versions
// pinned here: they move together (docs/flathub.md).

import { createHash } from "node:crypto";
import { msg } from "./i18n.ts";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./run.ts";

export interface Download {
  url: string;
  sha256: string;
  size: number;
  file: string; // the name it's saved under
}

export type ComponentId = "engine" | "model" | "tectonic" | "typst";

interface Component {
  /** What the user is told: "the engine (36 MB)". */
  label: string;
  files: Download[];
  /** An archive to unpack (engine, Tectonic), or plain files (the model). */
  unpack: boolean;
}

const LLAMA = "b12651"; // llama.cpp release: Vulkan builds (Linux, Windows) and Metal (macOS)
const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA}/`;
const TECTONIC_URL = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/";
const MODEL_URL =
  "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/";

const ENGINES: Record<string, Download> = {
  "linux-x64": {
    file: `llama-${LLAMA}-bin-ubuntu-vulkan-x64.tar.gz`,
    size: 36976824,
    sha256: "0bbcf2093f15c64c8a9bf54b809c9b2c812b982992dc2fbc9b36720c1d32cf13",
    url: "",
  },
  "win32-x64": {
    file: `llama-${LLAMA}-bin-win-vulkan-x64.zip`,
    size: 38939211,
    sha256: "e58fa9a137d8046c69334005ad6fb3e904ddc7e56f2a61ad1b844335826ef3f4",
    url: "",
  },
  "darwin-arm64": {
    file: `llama-${LLAMA}-bin-macos-arm64.tar.gz`,
    size: 16644358,
    sha256: "264fd872de61679c45ad57e1e21c2a2a54e29b35734ecf3d50f24166447ab8d2",
    url: "",
  },
  "darwin-x64": {
    file: `llama-${LLAMA}-bin-macos-x64.tar.gz`,
    size: 12434934,
    sha256: "34c19771545479a783d3b68c446383ab703033890c052d3ff0b860a5c9f59e56",
    url: "",
  },
};
for (const d of Object.values(ENGINES)) d.url = LLAMA_URL + d.file;

const TECTONICS: Record<string, Download> = {
  "linux-x64": {
    file: "tectonic-0.17.0-x86_64-unknown-linux-gnu.tar.gz",
    size: 22749118,
    sha256: "1a715688baf591e650c8aeb160ae934e181685eecbb38b317de30b269ac5d606",
    url: "",
  },
  "win32-x64": {
    file: "tectonic-0.17.0-x86_64-pc-windows-msvc.zip",
    size: 21060223,
    sha256: "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f",
    url: "",
  },
  "darwin-arm64": {
    file: "tectonic-0.17.0-aarch64-apple-darwin.tar.gz",
    size: 21704674,
    sha256: "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667",
    url: "",
  },
  "darwin-x64": {
    file: "tectonic-0.17.0-x86_64-apple-darwin.tar.gz",
    size: 21790177,
    sha256: "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80",
    url: "",
  },
};
for (const d of Object.values(TECTONICS)) d.url = TECTONIC_URL + d.file;

const TYPST_URL = "https://github.com/typst/typst/releases/download/v0.15.1/";
const TYPSTS: Record<string, Download> = {
  "linux-x64": {
    file: "typst-x86_64-unknown-linux-musl.tar.xz",
    size: 17462992,
    sha256: "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c",
    url: "",
  },
  "win32-x64": {
    file: "typst-x86_64-pc-windows-msvc.zip",
    size: 22463684,
    sha256: "19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736",
    url: "",
  },
  "darwin-arm64": {
    file: "typst-aarch64-apple-darwin.tar.xz",
    size: 14438168,
    sha256: "48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a",
    url: "",
  },
  "darwin-x64": {
    file: "typst-x86_64-apple-darwin.tar.xz",
    size: 15635600,
    sha256: "7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa",
    url: "",
  },
};
for (const d of Object.values(TYPSTS)) d.url = TYPST_URL + d.file;

export const MODEL_FILES: Download[] = [
  {
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    size: 5680522464,
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    url: MODEL_URL + "Qwen3.5-9B-Q4_K_M.gguf",
  },
  {
    file: "mmproj-F16.gguf",
    size: 918166080,
    sha256: "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f",
    url: MODEL_URL + "mmproj-F16.gguf",
  },
];

const PLATFORM = `${process.platform}-${process.arch}`;

function component(id: ComponentId): Component | null {
  if (id === "model") return { label: "the model", files: MODEL_FILES, unpack: false };
  const table = { engine: ENGINES, tectonic: TECTONICS, typst: TYPSTS }[id];
  const d = table[PLATFORM];
  if (!d) return null;
  const label = { engine: "the engine", tectonic: "the LaTeX engine (Tectonic)", typst: "Typst" }[id];
  return { label, files: [d], unpack: true };
}

export const supported = (id: ComponentId) => component(id) !== null;
export const sizeOf = (id: ComponentId) => component(id)?.files.reduce((n, f) => n + f.size, 0) ?? 0;

/** Where downloaded components live: <userData>/components/<id>/ */
export const dirOf = (base: string, id: ComponentId) => join(base, "components", id);

export type ProgramId = Exclude<ComponentId, "model">;
const PROGRAMS: Record<ProgramId, string> = { engine: "llama-server", tectonic: "tectonic", typst: "typst" };
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

/**
 * Programs a package ships itself. Flathub doesn't let an app download programs when it runs, so the Flatpak
 * builds llama-server, Tectonic and Typst into /app/bin and only the model is downloaded. The folder is the one
 * INKTYSET_BUNDLED names, else /app/bin inside a Flatpak (FLATPAK_ID is set in every Flatpak), else none: the
 * other packages (AppImage, deb, rpm, Windows, macOS) ship no programs and download them as before.
 */
export function bundledDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.INKTYSET_BUNDLED || (env.FLATPAK_ID ? "/app/bin" : null);
}

/** The package's own copy of this program, when it ships one: used as it is, never downloaded. */
export function bundled(id: ProgramId, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = bundledDir(env);
  const path = dir && join(dir, exe(PROGRAMS[id]));
  return path && existsSync(path) ? path : null;
}

/** The program to run: the package's own copy, else the downloaded one (null: neither is here yet). */
export async function programPath(
  base: string,
  id: ProgramId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const own = bundled(id, env);
  if (own) return own;
  return (await upToDate(base, id)) ? await findFile(dirOf(base, id), exe(PROGRAMS[id])) : null;
}

/** What an unpacked component was installed from (written by install, read by upToDate). */
const INSTALLED = ".installed";
const archives = (c: Component) => c.files.map((f) => f.file).join("\n");

/**
 * Is the downloaded copy the one pinned here? One installed from another release (an older engine) counts as
 * missing, so the window offers the pinned one to download (install replaces the folder). Copies from before
 * INSTALLED was written: the engine was older than its pin is now; Tectonic and Typst haven't changed since.
 */
export async function upToDate(base: string, id: ProgramId): Promise<boolean> {
  const c = component(id);
  if (!c) return true; // nothing to download for this system: whatever is there
  const was = await readFile(join(dirOf(base, id), INSTALLED), "utf8").catch(() => null);
  return was === null ? id !== "engine" : was.trim() === archives(c);
}

/** A file inside an unpacked component, found by name (archives nest it differently per system). */
export async function findFile(dir: string, name: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name);
  }
  return null;
}

async function sha256Of(path: string, onBytes?: (n: number) => void): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    hash.update(chunk as Buffer);
    onBytes?.((chunk as Buffer).length);
  }
  return hash.digest("hex");
}

/** Check model files someone already has (a folder they point us to): sizes, then checksums. */
export async function verifyModelDir(dir: string, onProgress: (done: number, total: number) => void) {
  const total = MODEL_FILES.reduce((n, f) => n + f.size, 0);
  let done = 0;
  for (const f of MODEL_FILES) {
    const path = join(dir, f.file);
    const st = await stat(path).catch(() => null);
    if (!st || st.size !== f.size) throw new Error(msg("modelWrongSize", { file: f.file }));
  }
  for (const f of MODEL_FILES) {
    const sum = await sha256Of(join(dir, f.file), (n) => onProgress((done += n), total));
    if (sum !== f.sha256) throw new Error(msg("modelWrongSum", { file: f.file }));
  }
}

export interface Progress {
  done: number;
  total: number;
  phase: "download" | "verify" | "unpack";
}

/** Download (resuming any partial file), verify, and unpack one component into dirOf(base, id). */
export async function install(
  base: string,
  id: ComponentId,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
) {
  const c = component(id);
  if (!c) throw new Error(`${id} is not available for this system (${PLATFORM}).`);
  const dir = dirOf(base, id);
  const parts = join(base, "components", "downloads");
  await mkdir(parts, { recursive: true });
  const total = c.files.reduce((n, f) => n + f.size, 0);
  let before = 0;
  for (const f of c.files) {
    const final = c.unpack ? join(parts, f.file) : join(dir, f.file);
    if (!c.unpack && existsSync(final) && (await stat(final)).size === f.size) {
      before += f.size; // already here (verified when it was saved)
      continue;
    }
    const part = join(parts, f.file + ".part");
    await fetchResuming(f, part, (n) => onProgress({ phase: "download", done: before + n, total }), signal);
    onProgress({ phase: "verify", done: before + f.size, total });
    if ((await sha256Of(part)) !== f.sha256) {
      await rm(part, { force: true });
      throw new Error(msg("damaged", { file: f.file }));
    }
    await mkdir(dir, { recursive: true });
    await rename(part, final);
    before += f.size;
    if (c.unpack) {
      onProgress({ phase: "unpack", done: before, total });
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      // tar unpacks .tar.gz everywhere, and .zip too on Windows and macOS (bsdtar)
      const r = await run("tar", ["-xf", final, "-C", dir]);
      if (r.code !== 0) throw new Error(msg("unpackFailed", { file: f.file, error: r.stderr.trim() }));
      await rm(final, { force: true });
      if (process.platform !== "win32") {
        for (const name of ["llama-server", "tectonic", "typst"]) {
          const bin = await findFile(dir, name);
          if (bin) await chmod(bin, 0o755);
        }
      }
    }
  }
  if (c.unpack) await writeFile(join(dir, INSTALLED), archives(c) + "\n");
}

async function fetchResuming(f: Download, part: string, onBytes: (n: number) => void, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const have = existsSync(part) ? (await stat(part)).size : 0;
    if (have === f.size) return;
    if (have > f.size) await rm(part);
    try {
      const res = await fetch(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal });
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
      const resumed = res.status === 206;
      const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
      let got = resumed ? have : 0;
      onBytes(got);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        got += chunk.length;
        onBytes(got);
      }
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve())),
      );
      if (got === f.size) return;
      throw new Error("the connection closed early");
    } catch (e) {
      if (signal.aborted) throw new Error(msg("downloadStopped"), { cause: e });
      if (attempt >= 5)
        throw new Error(msg("downloadFailed", { file: f.file, error: (e as Error).message }), { cause: e });
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // then resume where it stopped
    }
  }
}
