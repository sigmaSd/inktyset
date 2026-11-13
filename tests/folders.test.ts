import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { launchArgs, pagesFolderIn } from "../src/folders.ts";

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

test("folders: --folder opens a folder for one run; the other arguments are kept to start again without it", () => {
  const cwd = resolve("/home/me");
  expect(launchArgs(["--dev", "--folder=private/pages"], cwd)).toEqual({
    folder: resolve(cwd, "private/pages"),
    cls: undefined,
    rest: ["--dev"],
  });
  expect(launchArgs(["--folder", "/srv/ink", "--no-window"], cwd)).toEqual({
    folder: resolve("/srv/ink"),
    cls: undefined,
    rest: ["--no-window"],
  });
  expect(launchArgs(["--dev"], cwd)).toEqual({ folder: undefined, cls: undefined, rest: ["--dev"] });
  expect(launchArgs(["--class=ghink", "--folder=/p"], cwd)).toEqual({
    folder: resolve("/p"),
    cls: "ghink",
    rest: [],
  });
  expect(launchArgs(["--class=../x y"], cwd).cls).toBeUndefined();
});
