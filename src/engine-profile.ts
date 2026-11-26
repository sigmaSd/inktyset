// Engine profiles: how llama.cpp's server is started for a model, beyond the model itself. Mostly the options that
// decide what goes on the graphics chip and what stays in the computer's memory: with a model the chip can't
// hold, llama.cpp's --fit gives the chip's memory to the context and the computing's scratch first, and the
// model gets what is left (a 53248-token context once left 1 layer of Inkling 2 Mini on a 16 GB card, the rest
// on the processor). A Compare models column can carry one (src/showdown.ts); src/model.ts adds its options.
//
// Options are written as the engine in use names them, read from its --help (one release's --no-mmap is a later
// one's --load-mode none). One it doesn't know is left out and reported, never passed: the server would refuse to
// start.
//
// fitPreview asks llama-fit-params (beside the server, in llama.cpp's releases) where a model would go with a
// profile, in a few seconds and without loading it: what would be on the chip (the model's part, the context, the
// scratch), what in the computer's memory.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EngineProfile {
  /** How many tokens the engine holds (-c). None: the reading's own (instructions, picture, examples, answer). */
  ctx?: number;
  /** The batch a prompt is read in (-ub, 512 by default): smaller, less scratch memory on the chip. */
  ubatch?: number;
  /** Flash attention (-fa). */
  flashAttn?: "on" | "off" | "auto";
  /** The context's memory (the KV cache) in the computer's memory, not the chip's (-nkvo). */
  kvOnCpu?: boolean;
  /** The KV cache's precision (-ctk, -ctv): q8_0 halves it. */
  kvType?: "f16" | "q8_0" | "q4_0";
  /**
   * false: weights left in the computer's memory are computed there. By default llama.cpp copies them to the chip
   * to read a long prompt, which needs room for the copies there (--no-op-offload).
   */
  opOffload?: boolean;
  /** The vision part (the mmproj) on the processor (--no-mmproj-offload). */
  visionOnCpu?: boolean;
  /** How the model file is read: "none" reads it into memory (the old --no-mmap), "mmap" maps it, "mlock" pins it. */
  loadMode?: "auto" | "none" | "mmap" | "mlock";
  /** More options, as typed for llama-server. */
  extra?: string;
}

const FLASH = ["on", "off", "auto"] as const;
const KV_TYPES = ["f16", "q8_0", "q4_0"] as const;
const LOAD_MODES = ["auto", "none", "mmap", "mlock"] as const;

/** A positive whole number, or nothing. */
const count = (x: unknown) => {
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const oneOf = <T extends string>(x: unknown, values: readonly T[]) =>
  values.includes(x as T) ? (x as T) : undefined;

/** A profile as the window sends it, checked: only what is set, in one order. None set: undefined. */
export function cleanProfile(p: unknown): EngineProfile | undefined {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  const clean: EngineProfile = {
    ctx: count(o.ctx),
    ubatch: count(o.ubatch),
    flashAttn: oneOf(o.flashAttn, FLASH),
    kvOnCpu: o.kvOnCpu === true || undefined,
    kvType: oneOf(o.kvType, KV_TYPES),
    opOffload: o.opOffload === false ? false : undefined,
    visionOnCpu: o.visionOnCpu === true || undefined,
    loadMode: oneOf(o.loadMode, LOAD_MODES),
    extra: String(o.extra ?? "").trim() || undefined,
  };
  const set = Object.entries(clean).filter(([, v]) => v !== undefined);
  return set.length ? (Object.fromEntries(set) as EngineProfile) : undefined;
}

/** The same profile, the same key ("" none): for a column's key and to tell two columns apart. */
export const profileKey = (p: EngineProfile | undefined) => {
  const c = cleanProfile(p);
  return c ? JSON.stringify(c) : "";
};

/** What an option takes after it: nothing, a value, or a value it may go without ("[on|off|auto]"). */
export type Arity = "none" | "value" | "optional";
export type Flags = Map<string, Arity>;

/**
 * The options in a llama.cpp program's --help: each line that starts with them, as
 * "-ub,   --ubatch-size N      physical maximum batch size", the value's name one space after the last.
 */
export function parseHelp(help: string): Flags {
  const flags: Flags = new Map();
  for (const line of help.split("\n")) {
    if (!line.startsWith("-")) continue;
    const names: string[] = [];
    let rest = line;
    for (;;) {
      const m = /^(-{1,2}[A-Za-z0-9][\w.-]*)(,\s*)?/.exec(rest);
      if (!m) break;
      names.push(m[1]);
      rest = rest.slice(m[0].length);
      if (!m[2]) break;
    }
    // the value's name is one space after the options; the description is further
    const value = /^ (\S+)/.exec(rest)?.[1];
    const arity: Arity = !value ? "none" : value.startsWith("[") ? "optional" : "value";
    for (const n of names) flags.set(n, arity);
  }
  return flags;
}

const helps = new Map<string, Promise<Flags>>();

/** The options a llama.cpp program knows (its --help), once per program file. */
export async function programFlags(bin: string): Promise<Flags> {
  const { mtimeMs } = await stat(bin);
  const key = `${bin}\n${mtimeMs}`;
  let flags = helps.get(key);
  if (!flags) {
    flags = new Promise<string>((resolve, reject) =>
      execFile(bin, ["--help"], { timeout: 15_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
        err && !stdout ? reject(err) : resolve(stdout + stderr),
      ),
    ).then(parseHelp);
    flags.catch(() => helps.delete(key));
    helps.set(key, flags);
  }
  return await flags;
}

/** Options typed on one line: by spaces, a quoted part kept whole. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** A value that isn't another option ("-1" is a value). */
const isValue = (s: string | undefined) => s !== undefined && (!s.startsWith("-") || /^-\d/.test(s));

/**
 * The profile's options as `flags` (a program's --help) names them, after the reading's own; what the program
 * doesn't know, in `skipped` (as the profile says it). The context (-c) is the caller's: it has the reading's.
 */
export function profileArgs(p: EngineProfile | undefined, flags: Flags) {
  const args: string[] = [];
  const skipped: string[] = [];
  if (!p) return { args, skipped };
  const pick = (names: string[]) => names.find((n) => flags.has(n));
  const add = (said: string, names: string[], ...values: string[]) => {
    const f = pick(names);
    if (f) args.push(f, ...values);
    else skipped.push(said);
  };
  if (p.ubatch) add(`-ub ${p.ubatch}`, ["-ub", "--ubatch-size"], String(p.ubatch));
  if (p.flashAttn) add(`-fa ${p.flashAttn}`, ["-fa", "--flash-attn"], p.flashAttn);
  if (p.kvOnCpu) add("-nkvo", ["-nkvo", "--no-kv-offload"]);
  if (p.kvType) {
    add(`-ctk ${p.kvType}`, ["-ctk", "--cache-type-k"], p.kvType);
    add(`-ctv ${p.kvType}`, ["-ctv", "--cache-type-v"], p.kvType);
  }
  if (p.opOffload === false) add("--no-op-offload", ["--no-op-offload"]);
  if (p.visionOnCpu) add("--no-mmproj-offload", ["--no-mmproj-offload"]);
  if (p.loadMode && p.loadMode !== "auto") {
    const lm = pick(["-lm", "--load-mode"]);
    if (lm) args.push(lm, p.loadMode);
    // before --load-mode
    else if (p.loadMode === "none" && flags.has("--no-mmap")) args.push("--no-mmap");
    else if (p.loadMode === "mlock" && flags.has("--mlock")) args.push("--mlock");
    else if (p.loadMode !== "mmap") skipped.push(`--load-mode ${p.loadMode}`); // (mmap: older engines' only way)
  }
  const extra = splitArgs(p.extra ?? "");
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    const arity = flags.get(a);
    if (!arity) {
      // not an option it knows: left out, with its value
      skipped.push(isValue(extra[i + 1]) && a.startsWith("-") ? `${a} ${extra[++i]}` : a);
      continue;
    }
    args.push(a);
    if (arity === "value" || (arity === "optional" && isValue(extra[i + 1]))) {
      if (extra[i + 1] !== undefined) args.push(extra[++i]);
    }
  }
  return { args, skipped };
}

/** Where a model would go, in MiB (llama-fit-params's figures). */
export interface FitPreview {
  /** The graphics chips (none: the processor alone): their memory, and what would be on each. */
  devices: { name: string; total: number; free: number; model: number; context: number; compute: number }[];
  /** What would be in the computer's memory. */
  host: { model: number; context: number; compute: number };
  /**
   * The layers on the chips as llama.cpp counts them, and how many of those keep part of their weights (a mixture
   * of experts' experts) in the computer's memory. Null: it all fits as asked, nothing moved.
   */
  layers: { total: number; partial: number } | null;
  /** The vision part (its file's size): on the chip besides the above, unless the profile keeps it on the processor. */
  vision: number;
  /** The options llama.cpp chose (-ngl, -ot…). */
  fitted: string;
  /** What llama.cpp said went wrong ("" nothing). */
  problem: string;
}

const MEMORY_TABLE = "memory breakdown [MiB]";
const DEVICE_ROW = /\|\s+- (.+?)\s*\|\s*(\d+) = (\d+) \+ \(\s*(\d+) =\s*(\d+) \+\s*(\d+) \+\s*(\d+)\s*\)/;
const HOST_ROW = /\|\s+- Host\s*\|\s*(\d+) =\s*(\d+) \+\s*(\d+) \+\s*(\d+)/;
const LAYERS_ROW = /common_params_fit_impl:\s+- .+?: +(\d+) layers(?: \((\d+) overflowing\))?, +\d+ MiB used/;

/**
 * llama-fit-params's answer, read: its log (-lv 4) and the options it printed. Its last memory table is the layout
 * it chose (or, when nothing had to move, the one asked for).
 */
export function parseFit(log: string, printed: string): Omit<FitPreview, "vision"> {
  let devices: FitPreview["devices"] = [];
  let host: FitPreview["host"] = { model: 0, context: 0, compute: 0 };
  let layers: FitPreview["layers"] = null;
  const problems: string[] = [];
  for (const line of log.split("\n")) {
    // each layout it tries has its table, and its summary after it: the last one's are the choice
    if (line.includes(MEMORY_TABLE)) {
      devices = [];
      host = { model: 0, context: 0, compute: 0 };
      layers = null;
      continue;
    }
    const d = DEVICE_ROW.exec(line);
    if (d) {
      const [, name, total, free, , model, context, compute] = d;
      devices.push({ name, total: +total, free: +free, model: +model, context: +context, compute: +compute });
      continue;
    }
    const h = HOST_ROW.exec(line);
    if (h) {
      host = { model: +h[2], context: +h[3], compute: +h[4] };
      continue;
    }
    const l = LAYERS_ROW.exec(line);
    if (l) {
      layers ??= { total: 0, partial: 0 };
      layers.total += +l[1];
      layers.partial += +(l[2] ?? 0);
      continue;
    }
    // "0.00.382.131 W common_fit_params: failed to fit params…", or an error
    const said = /^\S+ ([EW]) (.*)$/.exec(line);
    if (said && (said[1] === "E" || /fail|abort/i.test(said[2]))) problems.push(said[2].trim());
  }
  return { devices, host, layers, fitted: printed.trim(), problem: problems.join("\n") };
}

/** llama-fit-params, beside a llama.cpp server program (null: this engine came without it). */
export function fitTool(server: string): string | null {
  const f = join(dirname(server), process.platform === "win32" ? "llama-fit-params.exe" : "llama-fit-params");
  return existsSync(f) ? f : null;
}

/**
 * Where llama.cpp would put a model started with `profile` (and `ctx` tokens), without loading it. The profile's
 * options that only the server knows (the vision part's place, how the file is read) don't change it.
 */
export async function fitPreview(o: {
  server: string;
  model: string;
  mmproj?: string;
  ctx: number;
  profile?: EngineProfile;
}): Promise<FitPreview> {
  const tool = fitTool(o.server);
  if (!tool) throw new Error(`no llama-fit-params beside ${o.server}`);
  const { args } = profileArgs(o.profile, await programFlags(tool));
  const ctx = o.profile?.ctx ?? o.ctx;
  const { log, printed, failed } = await new Promise<{ log: string; printed: string; failed: string }>(
    (resolve) =>
      execFile(
        tool,
        ["-m", o.model, "-c", String(ctx), "-np", "1", ...args, "-lv", "4"],
        { timeout: 120_000, maxBuffer: 32 << 20 },
        (err, stdout, stderr) => resolve({ log: stderr, printed: stdout, failed: err ? err.message : "" }),
      ),
  );
  const fit = parseFit(log, printed);
  const vision = o.mmproj && !o.profile?.visionOnCpu ? ((await stat(o.mmproj)).size / 2 ** 20) | 0 : 0;
  // a failure it didn't explain in its log: the program's own (a refused option, a model it can't read)
  const problem = fit.problem || (failed ? log.trim().split("\n").at(-1) || failed : "");
  return { ...fit, vision, problem };
}
