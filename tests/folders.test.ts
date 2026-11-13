import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { pagesFolderIn, rememberFolder } from "../src/folders.ts";

test("folders: an empty folder or one with pages is used as it is, any other gets an Inktyset folder", async () => {
  const empty = scratch("folders-empty");
  writeFileSync(join(empty, ".hidden"), ""); // a file the user doesn't see doesn't count
  expect(await pagesFolderIn(empty)).toBe(resolve(empty));

  const pages = scratch("folders-pages");
  writeFileSync(join(pages, "state.json"), "{}");
  writeFileSync(join(pages, "notes.txt"), "");
  expect(await pagesFolderIn(pages)).toBe(resolve(pages));

  const documents = scratch("folders-documents");
  mkdirSync(join(documents, "thesis"));
  expect(await pagesFolderIn(documents)).toBe(join(resolve(documents), "Inktyset"));
});

test("folders: the one left comes first, the one opened is not offered, a few are kept", () => {
  expect(rememberFolder(["/b", "/c"], "/a", "/c")).toEqual(["/a", "/b"]);
  expect(rememberFolder(["/a", "/b"], "/b", "/z")).toEqual(["/b", "/a"]);
  expect(rememberFolder(["/1", "/2", "/3", "/4", "/5", "/6"], "/0", "/x")).toHaveLength(6);
});
