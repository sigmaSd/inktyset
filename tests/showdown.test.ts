import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { fakeEngine } from "./_engine.ts";
import { scratch } from "./_env.ts";
import { MODEL_FILES } from "../src/components.ts";
import { Core } from "../src/core.ts";
import { distance } from "../src/diff.ts";
import { keyOf } from "../src/library.ts";
import { pageMessages } from "../src/model.ts";
import { comboKey } from "../src/showdown.ts";

test("distance: spacing aside, the share of tokens that differ", () => {
  expect(distance("\\frac{a}{b}", "\\frac { a } { b }")).toBe(0);
  expect(distance("", "")).toBe(0);
  expect(distance("x + y", "a - b")).toBe(1);
  // one symbol of five changed: one removed, one added, of ten
  expect(distance("a + b = c", "a + d = c")).toBeCloseTo(0.2);
});

/** A core on scratch folders, with one page read and checked (its text is the answer key). */
async function setup(name: string) {
  const dir = scratch(name);
  mkdirSync(join(dir, "user"));
  const core = new Core(join(dir, "pages"), join(dir, "user"));
  await core.lib.init();
  // Inktyset's model, as if downloaded (built-in columns read with it)
  mkdirSync(core.model.modelDir(), { recursive: true });
  for (const f of MODEL_FILES) writeFileSync(join(core.model.modelDir(), f.file), "");
  await core.showdown.load();
  const lib = core.lib;
  const p = lib.add(lib.nextId(), "a.jpg", "file");
  writeFileSync(lib.scanPath(p.id), "jpg");
  writeFileSync(lib.texPath(p.id), "$a + b = c$");
  Object.assign(p, { status: "done", checked: true });
  return { core, lib, page: p.id };
}

/** A reading kept as the showdown keeps it. */
function reading(core: Core, cid: string, page: string, text: string, extra: Record<string, unknown> = {}) {
  const dir = join(core.lib.dir, "showdown", cid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${page}.tex`), text);
  const r = {
    at: 1,
    secs: 5,
    finish: "stop",
    prompt: keyOf(core.readingPrompt()),
    pic: 0,
    ok: true,
    err: "",
  };
  writeFileSync(
    join(dir, `${page}.json`),
    JSON.stringify({ ...r, pngs: [], rev: 1, unk: 0, empty: false, ...extra }),
  );
}

test("showdown: the app's model to start with; a model added twice is kept once", async () => {
  const { core } = await setup("showdown-add");
  const sd = core.showdown;
  expect(sd.contenders.map((c) => [c.kind, c.think])).toEqual([["builtin", false]]);
  const think = await sd.add({ kind: "builtin", think: true });
  expect(await sd.add({ kind: "builtin", think: true })).toBe(think);
  const server = await sd.add({
    kind: "server",
    url: " http://localhost:11434 ",
    name: "gemma",
    think: false,
  });
  expect(sd.contenders.find((c) => c.id === server)?.url).toBe("http://localhost:11434");
  await expect(
    sd.add({ kind: "files", modelFile: "/no/such.gguf", mmprojFile: "/no/mm.gguf", think: false }),
  ).rejects.toThrow();
  await expect(sd.add({ kind: "server", url: "", think: false })).rejects.toThrow();
  // kept for the next time, with this computer's settings (userData), not with the pages
  const saved = JSON.parse(await readFile(join(core.folder, "..", "user", "showdown.json"), "utf8"));
  expect(saved.contenders.map((c: { id: string }) => c.id)).toEqual(sd.contenders.map((c) => c.id));
});

test("showdown: a reading is scored against the checked text, and outdated once the instructions change", async () => {
  const { core, lib, page } = await setup("showdown-state");
  const sd = core.showdown;
  const [app] = sd.contenders;
  const other = await sd.add({ kind: "builtin", think: true });
  reading(core, app.id, page, "$a + b = c$");
  reading(core, other, page, "$a + d = c$");
  let s = await sd.state(lib);
  const cell = (id: string) =>
    s.contenders.find((c) => c.id === id)!.cells[page] as {
      state: string;
      reading: { score: number; outdated: boolean };
    };
  expect(cell(app.id).state).toBe("done");
  expect(cell(app.id).reading.score).toBe(0);
  expect(cell(other).reading.score).toBeGreaterThan(0);
  expect(s.contenders.find((c) => c.id === app.id)!.app).toBe(true);
  expect(cell(app.id).reading.outdated).toBe(false);

  core.settings.instructions = "My x looks like a y.";
  s = await sd.state(lib);
  expect(cell(app.id).reading.outdated).toBe(true);
});

test("showdown: Read missing queues each model's pages, model by model; Stop empties the queue", async () => {
  const { core, lib, page } = await setup("showdown-queue");
  const sd = core.showdown;
  const p2 = lib.add(lib.nextId(), "b.jpg", "file");
  writeFileSync(lib.scanPath(p2.id), "jpg");
  const [app] = sd.contenders;
  const other = await sd.add({ kind: "builtin", think: true });
  reading(core, app.id, page, "$a + b = c$"); // read already: not again
  await sd.queue(lib, "missing");
  const s = await sd.state(lib);
  expect(s.queued).toBe(3);
  expect(sd.next(lib)).toMatchObject({ contender: app.id, page: p2.id });
  const states = s.contenders.map((c) => [c.id, (c.cells[page] as { state: string }).state]);
  expect(states).toEqual([
    [app.id, "done"],
    [other, "queued"],
  ]);
  // one cell stopped: the others still wait
  sd.stop(lib, { contender: other, page });
  expect((await sd.state(lib)).queued).toBe(2);
  sd.stop(lib);
  expect(sd.next(lib)).toBeNull();
});

test("showdown: a reading kept becomes a version of its page, marked new; the page's text stays", async () => {
  const { core, lib, page } = await setup("showdown-keep");
  const sd = core.showdown;
  const other = await sd.add({ kind: "builtin", think: true });
  reading(core, other, page, "$a + d = c$");
  const vid = await sd.keep(lib, other, page);
  const p = lib.get(page)!;
  expect(p.fresh).toBe(vid);
  expect(p.current).not.toBe(vid);
  expect(await readFile(lib.versionPath(page, vid), "utf8")).toBe("$a + d = c$");
  expect(await readFile(lib.texPath(page), "utf8")).toBe("$a + b = c$");
});

test("showdown: removing a model takes its readings of the session with it", async () => {
  const { core, lib, page } = await setup("showdown-remove");
  const sd = core.showdown;
  const other = await sd.add({ kind: "builtin", think: true });
  reading(core, other, page, "x");
  await sd.remove(other, lib);
  expect(sd.contenders.some((c) => c.id === other)).toBe(false);
  expect(await sd.reading(lib, other, page)).toBeNull();
});

test("showdown: a column's own instructions are read with; editing it makes its readings outdated", async () => {
  const { core, lib, page } = await setup("showdown-own");
  const sd = core.showdown;
  const own = await sd.add({ kind: "builtin", think: false, prompt: "  Transcribe faithfully.  " });
  const col = sd.contenders.find((c) => c.id === own)!;
  expect(col.prompt).toBe("Transcribe faithfully.");
  // the writing language's rule is still added; the app's own instructions aren't used
  expect(sd.promptFor(col).startsWith("Transcribe faithfully.")).toBe(true);
  expect(sd.promptFor(col)).not.toBe(core.readingPrompt());
  // the same model with Settings' instructions is another column
  expect(sd.contenders).toHaveLength(2);

  const dir = join(lib.dir, "showdown", own);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${page}.tex`), "x");
  const r = { at: 1, secs: 1, finish: "stop", prompt: keyOf(sd.promptFor(col)), pic: 0, ok: true, err: "" };
  writeFileSync(
    join(dir, `${page}.json`),
    JSON.stringify({ ...r, combo: "", pngs: [], rev: 1, unk: 0, empty: false }),
  );
  const outdated = async () =>
    (
      (await sd.state(lib)).contenders.find((c) => c.id === own)!.cells[page] as {
        reading: { outdated: boolean };
      }
    ).reading.outdated;
  expect(await outdated()).toBe(false);
  // Settings' instructions don't matter to it
  core.settings.instructions = "My x looks like a y.";
  expect(await outdated()).toBe(false);
  // its own changed: outdated, and kept
  await sd.edit(own, { kind: "builtin", think: false, prompt: "Transcribe, and keep the margins." });
  expect(await outdated()).toBe(true);
  expect(await sd.reading(lib, own, page)).not.toBeNull();
});

test("showdown: a duplicate sits beside its column, without its readings; Use takes the instructions too", async () => {
  const { core, lib, page } = await setup("showdown-dup");
  const sd = core.showdown;
  const own = await sd.add({ kind: "builtin", think: true, prompt: "Mine." });
  reading(core, own, page, "x");
  const copy = await sd.duplicate(own);
  const ids = sd.contenders.map((c) => c.id);
  expect(ids.indexOf(copy)).toBe(ids.indexOf(own) + 1);
  expect(sd.contenders.find((c) => c.id === copy)).toMatchObject({ think: true, prompt: "Mine." });
  expect(await sd.reading(lib, copy, page)).toBeNull();

  core.settings.instructions = "notes";
  core.setSettings = async (next) => void Object.assign(core.settings, next); // no settings file here
  await sd.use(own);
  expect(core.settings).toMatchObject({ modelKind: "builtin", prompt: "Mine.", instructions: "" });
});

test("showdown: a column outlives its model's files: kept, says why, skipped by Read missing, still editable", async () => {
  const { core, lib, page } = await setup("showdown-gone");
  const sd = core.showdown;
  const models = join(lib.dir, "..", "models");
  mkdirSync(models, { recursive: true });
  const [model, mmproj] = [join(models, "m.gguf"), join(models, "mm.gguf")];
  writeFileSync(model, "");
  writeFileSync(mmproj, "");
  const col = await sd.add({ kind: "files", modelFile: model, mmprojFile: mmproj, think: false });
  reading(core, col, page, "$a + b = c$");
  const c = () => sd.contenders.find((x) => x.id === col)!;
  expect(sd.gone(c())).toBe("");

  rmSync(model);
  expect(sd.gone(c())).toContain(model);
  const s = await sd.state(lib);
  const shown = s.contenders.find((x) => x.id === col)!;
  expect(shown.gone).toContain(model);
  expect((shown.cells[page] as { reading: unknown }).reading).not.toBeNull(); // its readings stay
  // asked by name: refused, with why
  await expect(sd.queue(lib, [{ contender: col, page }])).rejects.toThrow(model);
  // Read missing: the others, not this one
  await sd.queue(lib, "missing");
  expect(sd.next(lib)?.contender).not.toBe(col);
  // its instructions can still change; new files must be there
  await sd.edit(col, { kind: "files", modelFile: model, mmprojFile: mmproj, think: false, prompt: "Mine." });
  expect(c().prompt).toBe("Mine.");
  await expect(
    sd.edit(col, { kind: "files", modelFile: join(models, "other.gguf"), mmprojFile: mmproj, think: false }),
  ).rejects.toThrow();
});

test("showdown examples: checked pages shown first, never the page read; any count from 0", async () => {
  const { core, lib, page } = await setup("showdown-examples");
  const sd = core.showdown;
  const more = [1, 2, 3].map((i) => {
    const p = lib.add(lib.nextId(), `${i}.jpg`, "file");
    writeFileSync(lib.scanPath(p.id), "jpg");
    writeFileSync(lib.texPath(p.id), `page ${i}`);
    Object.assign(p, { status: "done", checked: i !== 2 }); // the second isn't checked
    return p.id;
  });
  const two = await sd.add({ kind: "builtin", think: false, examples: 2 });
  const col = sd.contenders.find((c) => c.id === two)!;
  // the first checked pages, but never the page itself
  expect(sd.examplesFor(lib, col, more[2])).toEqual([page, more[0]]);
  expect(sd.examplesFor(lib, col, page)).toEqual([more[0], more[2]]);
  // no cap (memory is the limit), never below 0
  const many = await sd.add({ kind: "builtin", think: true, examples: 9 });
  expect(sd.contenders.find((c) => c.id === many)!.examples).toBe(9);
  expect(
    sd.examplesFor(
      lib,
      sd.contenders.find((c) => c.id === many)!,
      page,
    ),
  ).toHaveLength(2); // as many as there are
  const none = await sd.add({ kind: "builtin", think: true, prompt: "x", examples: -1 });
  expect(sd.contenders.find((c) => c.id === none)!.examples).toBeUndefined();
});

test("showdown examples: the engine sees each as a page answered with its text, then the page", () => {
  const m = pageMessages(Buffer.from("p"), "Read it.", [
    { jpeg: Buffer.from("a"), text: "$a$" },
    { jpeg: Buffer.from("b"), text: "$b$" },
  ]);
  expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  expect(m[1].content).toBe("$a$");
  expect(JSON.stringify(m.at(-1))).toContain(Buffer.from("p").toString("base64"));
  expect(pageMessages(Buffer.from("p"), "Read it.")).toHaveLength(1);
});

test("showdown examples: a column's key is the same without them, another with them", () => {
  const plain = { kind: "builtin" as const, think: false };
  expect(comboKey({ ...plain, examples: 0 })).toBe(comboKey(plain)); // readings from before stay current
  expect(comboKey({ ...plain, examples: 2 })).not.toBe(comboKey(plain));
});

// (a script run as a program: not on Windows)
test.skipIf(process.platform === "win32")(
  "showdown: the app's model is loaded again after the readings only if a reading stopped it",
  async () => {
    const { core, lib, page } = await setup("showdown-reload");
    const fake = fakeEngine(scratch("showdown-reload-engine"));
    const files = { modelFile: fake.modelFile, mmprojFile: fake.mmprojFile };
    await core.setSettings({ serverPath: fake.bin, modelKind: "files", ...files });
    core.missing = { engine: false, model: false };
    const sd = core.showdown;
    const other = await sd.add({ kind: "files", ...files, think: false });
    try {
      // never loaded: it stays so (it would hold the graphics chip's memory for nothing)
      await sd.run({ lib, contender: other, page });
      await new Promise((r) => setTimeout(r, 1000)); // (a load would be under way by now)
      expect(core.model.running).toBe(false);
      expect(core.model.status).toBe("stopped");

      // loaded: stopped for the reading, loaded again after it
      await core.model.ensure();
      await sd.run({ lib, contender: other, page });
      for (let i = 0; i < 100 && core.model.status !== "ready"; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(core.model.status).toBe("ready");
    } finally {
      await core.model.stop();
      await sd.engine.stop();
    }
  },
  20_000, // engines started one after another, each a second or so
);
