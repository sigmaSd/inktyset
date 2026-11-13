import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { Library } from "../src/library.ts";

test("library: reads the Python version's state.json; a page cut off mid-read goes back in the queue", async () => {
  const dir = scratch("python-state");
  writeFileSync(
    `${dir}/state.json`,
    JSON.stringify({
      pages: [
        {
          id: "page0001",
          label: "a.jpg",
          origin: "file",
          status: "done",
          added: 1,
          rev: 3,
          ok: true,
          err: "",
          unk: 0,
          secs: 80,
          truncated: false,
          pngs: [],
        },
        {
          id: "page0002",
          label: "b.jpg",
          origin: "phone",
          status: "working",
          added: 2,
          rev: 1,
          ok: null,
          err: "",
          unk: 0,
          secs: null,
          truncated: false,
          pngs: [],
        },
      ],
      counter: 2,
      settings: { language: "french" },
      seen_phone: ["Thesis/x.jpg"],
    }),
  );
  const lib = new Library(dir);
  await lib.init();
  expect(lib.pages.map((p) => p.status)).toEqual(["done", "queued"]);
  expect(lib.settings.language).toBe("french");
  expect(lib.seenPhone.has("Thesis/x.jpg")).toBe(true);
  expect(lib.nextId()).toBe("page0003");
});

test("library: a new page is saved, and found again after a restart", async () => {
  const dir = scratch("roundtrip");
  const lib = new Library(dir);
  await lib.init();
  lib.add(lib.nextId(), "scan.png", "scan");
  await lib.save();
  const saved = JSON.parse(readFileSync(`${dir}/state.json`, "utf8")) as { pages: { id: string }[] };
  expect(saved.pages.map((p) => p.id)).toEqual(["page0001"]);
  expect(new Library(dir).pages[0].label).toBe("scan.png");
});
