import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { Core, type Renderer, type Shell, sessionFolder, sessionName } from "../src/core.ts";

test("sessions: a name is one line; its folder's name is safe on every system", () => {
  expect(sessionName("  Lecture\n 3  ")).toBe("Lecture 3");
  expect(sessionFolder("Lecture 3")).toBe("Lecture 3");
  expect(sessionFolder('a/b\\c:d*e?"f<g>h|')).toBe("a_b_c_d_e__f_g_h_");
  expect(sessionFolder("..hidden. ")).toBe("hidden");
  expect(sessionFolder("CON")).toBe("session");
  expect(sessionFolder("")).toBe("session");
  expect(sessionFolder("Cours d'analyse — شرح")).toBe("Cours d'analyse — شرح");
});

/** A core on scratch folders, with a shell whose trash just removes. */
function core(name: string) {
  const dir = scratch(name);
  const userData = join(dir, "user");
  mkdirSync(userData);
  const c = new Core(join(dir, "pages"), userData);
  c.shell = { trash: (p: string) => rm(p, { recursive: true, force: true }) } as unknown as Shell;
  return c;
}

test("sessions: new, open, rename, delete; the first one is the pages folder's own", async () => {
  const c = core("sessions-basic");
  await c.lib.init();
  expect(c.session).toBe("");
  expect((await c.sessions()).map((s) => s.id)).toEqual([""]);

  const id = await c.newSession("Lecture 3");
  expect(id).toBe("Lecture 3");
  expect(c.session).toBe(id);
  expect(c.lib.dir).toBe(join(c.folder, "sessions", "Lecture 3"));
  // another by the same name: its own folder
  expect(await c.newSession("Lecture 3")).toBe("Lecture 3 2");
  const ids = (await c.sessions()).map((s) => s.id);
  expect(ids.at(-1)).toBe(""); // made before the others: last, the newest first
  expect(ids.slice(0, -1).sort()).toEqual(["Lecture 3", "Lecture 3 2"]);

  // no pages yet: its folder takes the new name (named just after it was made)
  const renamed = await c.renameSession(id, "Analysis");
  expect(renamed).toBe("Analysis");
  expect(c.session).toBe("Lecture 3 2"); // (the open one is still the open one)
  expect(existsSync(join(c.folder, "sessions", "Analysis", "state.json"))).toBe(true);
  expect(existsSync(join(c.folder, "sessions", "Lecture 3"))).toBe(false);
  expect((await c.sessions()).find((s) => s.id === "Analysis")?.name).toBe("Analysis");
  // the open one, renamed: still open, by its new id
  expect(await c.renameSession("Lecture 3 2", "Homework")).toBe("Homework");
  expect(c.session).toBe("Homework");
  expect(c.lib.dir).toBe(join(c.folder, "sessions", "Homework"));

  await c.deleteSession("Homework"); // the open one: the first is shown instead
  expect(c.session).toBe("");
  expect(existsSync(join(c.folder, "sessions", "Homework"))).toBe(false);
  await expect(c.deleteSession("")).rejects.toThrow();
  await expect(c.openSession("../elsewhere")).rejects.toThrow();
});

test("sessions: a file being added when another session opens goes to the session it was added to", async () => {
  const c = core("sessions-switch");
  await c.lib.init();
  const first = c.lib;
  let release!: () => void;
  const decoded = new Promise<void>((r) => (release = r));
  c.renderer = {
    image: async () => (await decoded, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
  } as unknown as Renderer;
  const photo = join(first.dir, "originals", "photo.jpg");
  writeFileSync(photo, "");
  const adding = c.addFile(photo, "photo.jpg", "file");
  await c.newSession("Other"); // opened while the photo is still being decoded
  release();
  await adding;
  await first.save();
  expect(first.pages.map((p) => p.label)).toEqual(["photo.jpg"]);
  expect(c.lib.pages).toEqual([]);
  expect(existsSync(first.scanPath(first.pages[0].id))).toBe(true);
});
