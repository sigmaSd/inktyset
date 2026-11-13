// What Inktyset downloads on first use, pinned and checksummed: the engine (llama.cpp's server, the
// build for this system), the model (two files), Tectonic (a self-contained LaTeX, only when no working TeX
// is installed) and Typst (for Typst output, when none is installed). Downloads resume after an interruption
// and are checked (SHA-256) before use.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
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

const LLAMA = "b12061"; // llama.cpp release: Vulkan builds (Linux, Windows) and Metal (macOS)
const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA}/`;
const TECTONIC_URL = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/";
const MODEL_URL =
  "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/";

const ENGINES: Record<string, Download> = {
  "linux-x64": {
    file: `llama-${LLAMA}-bin-ubuntu-vulkan-x64.tar.gz`,
    size: 35738172,
    sha256: "c03da3667d77dfcab3fb4d9a0bd0f3a067101cad94959ad08107a7ca299ca6d3",
    url: "",
  },
  "win32-x64": {
    file: `llama-${LLAMA}-bin-win-vulkan-x64.zip`,
    size: 37550614,
    sha256: "6273df0ac33de2d4d18c77d4787fc8630bb815e8c691a9fbb3ab4df5f0f2e9cc",
    url: "",
  },
  "darwin-arm64": {
    file: `llama-${LLAMA}-bin-macos-arm64.tar.gz`,
    size: 16542711,
    sha256: "b107a8373f7af640ff2744521792d3bc4742b9a86e73f52aa8636b30e3e7c554",
    url: "",
  },
  "darwin-x64": {
    file: `llama-${LLAMA}-bin-macos-x64.tar.gz`,
    size: 12281949,
    sha256: "e5790e87e886f621b857514699ffc797b6df8b518a1fc2acd0d0a2d9c60e42c3",
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
    if (!st || st.size !== f.size)
      throw new Error(`${f.file} is missing or has the wrong size in that folder.`);
  }
  for (const f of MODEL_FILES) {
    const sum = await sha256Of(join(dir, f.file), (n) => onProgress((done += n), total));
    if (sum !== f.sha256)
      throw new Error(`${f.file} in that folder is not the expected file (checksum differs).`);
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
      throw new Error(`The download of ${f.file} was damaged. Try again.`);
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
      if (r.code !== 0) throw new Error(`Could not unpack ${f.file}: ${r.stderr.trim()}`);
      await rm(final, { force: true });
      if (process.platform !== "win32") {
        for (const name of ["llama-server", "tectonic", "typst"]) {
          const bin = await findFile(dir, name);
          if (bin) await chmod(bin, 0o755);
        }
      }
    }
  }
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
      if (signal.aborted) throw new Error("Download stopped.", { cause: e });
      if (attempt >= 5)
        throw new Error(`Download of ${f.file} failed: ${(e as Error).message}`, { cause: e });
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // then resume where it stopped
    }
  }
}
