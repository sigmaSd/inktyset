// The reading benchmark (bench/README.md): pages with a known right answer, read by local models as Inktyset reads
// a page (src/model.ts read(): its instructions, temperature 0, thinking off, at most 4096 tokens written), timed,
// and scored as Compare models scores a reading against a checked page (src/diff.ts distance).
//   node tools/bench.ts [--pages id,id] [--models text] [--ctx 12288] [--engine path/to/llama-server]
//   node tools/bench.ts --rescore bench/runs/<time>     (the scores of a run again, from its saved texts)
// --models keeps the models whose name contains the text (any case).
//
// Two scores, each the share of tokens that differ from the page's answer (0% the same), as Compare models shows
// them: "off" on the whole LaTeX; "content off" on what it says, the layout aside (src/score.ts: the math parsed by
// KaTeX), so a misread symbol isn't drowned by a choice between align* and $...$ lines; and the formulas of the
// answer found exactly in the reading.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { programPath } from "../src/components.ts";
import { distance } from "../src/diff.ts";
import { cleanProfile, type EngineProfile, profileArgs, programFlags } from "../src/engine-profile.ts";
import { pageMessages } from "../src/model.ts";
import { cleanLatex, PROMPT } from "../src/pipeline.ts";
import { scorePage } from "../src/score.ts";

const BENCH = fileURLToPath(new URL("../bench/", import.meta.url));
const run = promisify(execFile);

interface Page {
  id: string;
  about: string;
  pdf: string;
  sha256: string;
}
interface ModelEntry {
  name: string;
  model: string;
  mmproj: string;
  engine?: EngineProfile;
}

const { values } = parseArgs({
  options: {
    pages: { type: "string" },
    models: { type: "string" },
    ctx: { type: "string", default: "12288" },
    engine: { type: "string" },
    rescore: { type: "string" },
  },
});
const home = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

const score = (text: string, right: string) => {
  const said = scorePage(text, right);
  return { off: distance(text, right), contentOff: said.off, formulas: said.formulas };
};

const pages = (JSON.parse(readFileSync(join(BENCH, "pages.json"), "utf8")) as Page[]).filter(
  (p) => !values.pages || values.pages.split(",").includes(p.id),
);
// (a run scored again needs neither models nor an engine)
const reading = !values.rescore;
const modelsFile = join(BENCH, "models.json");
if (reading && !existsSync(modelsFile)) {
  console.error(
    "no bench/models.json: copy bench/models.example.json and point it at this computer's models",
  );
  process.exit(2);
}
const models = (reading ? (JSON.parse(readFileSync(modelsFile, "utf8")) as ModelEntry[]) : [])
  .filter((m) => !values.models || m.name.toLowerCase().includes(values.models.toLowerCase()))
  .map((m) => ({ ...m, model: home(m.model), mmproj: home(m.mmproj), engine: cleanProfile(m.engine) }));
const userData = process.env.INKTYSET_USERDATA ?? join(homedir(), ".config", "Inktyset");
const server = reading ? (values.engine ?? (await programPath(userData, "engine"))) : null;
if (reading && !server) {
  console.error(`no engine: --engine, or download it in Inktyset (looked in ${userData})`);
  process.exit(2);
}
if (reading && (!pages.length || !models.length)) {
  console.error("no pages or no models to run");
  process.exit(2);
}

// ------------------------------------------------------------------------------------------------ the pages

/** The page as Inktyset sends it: its PDF (downloaded once, checked) rendered as a JPEG, long side 1600, 0.92. */
async function pagePicture(p: Page): Promise<Buffer> {
  const cache = join(BENCH, "cache");
  mkdirSync(cache, { recursive: true });
  const pdf = join(cache, `${p.id}.pdf`);
  const jpg = join(cache, `${p.id}.jpg`);
  if (!existsSync(jpg)) {
    if (!existsSync(pdf)) {
      const r = await fetch(p.pdf);
      if (!r.ok) throw new Error(`${p.id}: ${r.status} ${p.pdf}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const sum = createHash("sha256").update(bytes).digest("hex");
      if (sum !== p.sha256) throw new Error(`${p.id}: the PDF isn't the one listed (sha256 ${sum})`);
      await writeFile(pdf, bytes);
    }
    const out = join(cache, p.id);
    await run("pdftoppm", ["-jpeg", "-jpegopt", "quality=92", "-scale-to", "1600", "-singlefile", pdf, out]);
  }
  return await readFile(jpg);
}

const answer = (p: Page) => {
  const f = join(BENCH, "answers", `${p.id}.tex`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};

// ------------------------------------------------------------------------------------------------ the engine

/** The graphics card with the most memory (Linux, amdgpu): how much of it is in use, in MiB; null elsewhere. */
const vramFile = (() => {
  try {
    const cards = readdirSync("/sys/class/drm").filter((c) => /^card\d+$/.test(c));
    const total = (c: string) =>
      Number(readFileSync(`/sys/class/drm/${c}/device/mem_info_vram_total`, "utf8"));
    const best = cards
      .filter((c) => existsSync(`/sys/class/drm/${c}/device/mem_info_vram_used`))
      .sort((a, b) => total(b) - total(a))[0];
    return best ? `/sys/class/drm/${best}/device/mem_info_vram_used` : null;
  } catch {
    return null;
  }
})();
const vramMiB = () => (vramFile ? Math.round(Number(readFileSync(vramFile, "utf8")) / 2 ** 20) : null);

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** An engine as Inktyset starts it (src/model.ts), with the model's profile; resolves once it answers /health. */
async function start(m: (typeof models)[number], logs: string) {
  const port = await freePort();
  const { args: extra, skipped } = profileArgs(m.engine, await programFlags(server!));
  if (skipped.length) console.log(`  not known to this engine, left out: ${skipped.join(", ")}`);
  const ctx = m.engine?.ctx ?? Number(values.ctx);
  const args = ["-m", m.model, "--mmproj", m.mmproj, "-c", String(ctx), "-np", "1", "--host", "127.0.0.1"];
  args.push("--port", String(port), "--jinja", "--no-webui", ...extra);
  const log = openSync(join(logs, `${slug(m.name)}.log`), "w");
  const t0 = Date.now();
  const proc = spawn(server!, args, { stdio: ["ignore", log, log] });
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`the engine exited (${proc.exitCode}): see its log`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { proc, url: `http://127.0.0.1:${port}/v1`, loadSecs: (Date.now() - t0) / 1000, args: extra, ctx };
}

function stop(proc: ChildProcess) {
  return new Promise<void>((ok) => {
    if (proc.exitCode !== null) return ok();
    const kill = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    proc.once("exit", () => {
      clearTimeout(kill);
      ok();
    });
    proc.kill();
  });
}

/** One reading, as Inktyset's read() asks it (streamed, so a slow one isn't cut off), timed. */
async function read(url: string, jpeg: Buffer) {
  let peak = vramMiB();
  const sample = setInterval(() => {
    const v = vramMiB();
    if (v !== null) peak = Math.max(peak ?? 0, v);
  }, 1000);
  const t0 = Date.now();
  const r = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: pageMessages(jpeg, PROMPT),
      temperature: 0,
      top_k: 1,
      repeat_penalty: 1.05,
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false, reasoning_effort: "none" },
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
  let raw = "",
    thinking = "",
    finish = "",
    rest = "";
  let timings: {
    prompt_n?: number;
    prompt_ms?: number;
    predicted_n?: number;
    predicted_per_second?: number;
  } = {};
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    rest += Buffer.from(chunk).toString("utf8");
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const e = JSON.parse(line.slice(6));
      const delta = e.choices?.[0]?.delta ?? {};
      raw += delta.content ?? "";
      thinking += delta.reasoning_content ?? "";
      if (e.choices?.[0]?.finish_reason) finish = e.choices[0].finish_reason;
      if (e.timings) timings = e.timings;
    }
  }
  clearInterval(sample);
  return {
    totalSecs: (Date.now() - t0) / 1000,
    promptTokens: timings.prompt_n ?? null,
    promptSecs: timings.prompt_ms ? timings.prompt_ms / 1000 : null,
    writtenTokens: timings.predicted_n ?? null,
    writeTps: timings.predicted_per_second ?? null,
    finish,
    peakVramMiB: peak,
    text: cleanLatex(raw),
    thinking,
  };
}

// ------------------------------------------------------------------------------------------------ the run

if (values.rescore) {
  // a run's scores again: its texts against the answers as they are now
  const dir = values.rescore;
  const rows = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as Record<string, unknown>[];
  for (const r of rows) {
    if (r.error) continue;
    const p = pages.find((x) => x.id === r.page);
    const right = p && answer(p);
    if (!right) continue;
    Object.assign(
      r,
      score(readFileSync(join(dir, `${r.page}--${slug(String(r.model))}.tex`), "utf8"), right),
    );
  }
  await writeFile(join(dir, "results.json"), JSON.stringify(rows, null, 2));
  table(rows);
  process.exit(0);
}

const out = join(BENCH, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
const logs = join(out, "logs");
mkdirSync(logs, { recursive: true });
const pictures = new Map<string, Buffer>();
for (const p of pages) pictures.set(p.id, await pagePicture(p));

const results: Record<string, unknown>[] = [];
for (const m of models) {
  console.log(`${m.name}: starting the engine…`);
  let e: Awaited<ReturnType<typeof start>>;
  try {
    e = await start(m, logs);
  } catch (err) {
    console.log(`  ${(err as Error).message}`);
    results.push({ model: m.name, error: (err as Error).message });
    continue;
  }
  try {
    const loadedVramMiB = vramMiB();
    console.log(`  loaded in ${e.loadSecs.toFixed(0)} s`);
    for (const p of pages) {
      const { text, thinking, ...timed } = await read(e.url, pictures.get(p.id)!);
      const right = answer(p);
      const scored = right === null ? { off: null, contentOff: null, formulas: null } : score(text, right);
      const base = join(out, `${p.id}--${slug(m.name)}`);
      await writeFile(`${base}.tex`, text);
      if (thinking) await writeFile(`${base}.thinking.txt`, thinking);
      const row = {
        model: m.name,
        page: p.id,
        engine: e.args,
        ctx: e.ctx,
        loadSecs: e.loadSecs,
        loadedVramMiB,
        ...timed,
        thinkingChars: thinking.length,
        ...scored,
      };
      results.push(row);
      console.log(
        `  ${p.id}: ${timed.totalSecs.toFixed(1)} s` +
          (scored.off === null
            ? ""
            : `, ${(scored.off * 100).toFixed(1)}% off, ${(scored.contentOff! * 100).toFixed(1)}% content off, ` +
              `formulas ${scored.formulas!.right}/${scored.formulas!.of}`) +
          (timed.finish === "length" ? " (cut at 4096 tokens)" : ""),
      );
      await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
    }
  } finally {
    await stop(e.proc);
  }
}

table(results);
console.log(`\nsaved in ${out}`);

function table(results: Record<string, unknown>[]) {
  const cell = (v: unknown, digits = 1) => (typeof v === "number" ? v.toFixed(digits) : "–");
  const pct = (v: unknown) => cell(typeof v === "number" ? v * 100 : null);
  console.log(
    `\n${"model".padEnd(48)} ${"page".padEnd(12)} total s  prompt s  prompt t/s  write t/s  off %  content off %  formulas  card GB`,
  );
  for (const r of results) {
    if (r.error) {
      console.log(`${String(r.model).padEnd(48)} ${String(r.error)}`);
      continue;
    }
    const promptTps =
      typeof r.promptTokens === "number" && typeof r.promptSecs === "number"
        ? r.promptTokens / r.promptSecs
        : null;
    console.log(
      [
        String(r.model).padEnd(48),
        String(r.page).padEnd(12),
        cell(r.totalSecs).padStart(7),
        cell(r.promptSecs).padStart(9),
        cell(promptTps, 0).padStart(11),
        cell(r.writeTps).padStart(10),
        pct(r.off).padStart(6),
        pct(r.contentOff).padStart(14),
        (r.formulas
          ? `${(r.formulas as { right: number }).right}/${(r.formulas as { of: number }).of}`
          : "–"
        ).padStart(9),
        cell(typeof r.peakVramMiB === "number" ? r.peakVramMiB / 1024 : null).padStart(8),
      ].join(" "),
    );
  }
}
