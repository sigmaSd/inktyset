import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { Library } from "../src/library.ts";
import { checkLocalUrl, isPrivateAddress } from "../src/local.ts";
import { apiBase } from "../src/model.ts";

test("versions: an older page becomes v1; switching keeps the corrections of the one left", async () => {
  const lib = new Library(scratch("versions"));
  await lib.init();
  const p = lib.add(lib.nextId(), "a.jpg", "file");
  p.status = "done";
  writeFileSync(lib.texPath(p.id), "first reading, corrected");
  await lib.ensureVersions(p);
  expect(p.versions?.map((v) => v.id)).toEqual(["v1"]);
  expect(p.current).toBe("v1");

  // a second reading arrives (what Core.#read does), and becomes the one shown
  const v2 = lib.nextVersion(p);
  expect(v2).toBe("v2");
  writeFileSync(lib.versionPath(p.id, v2), "second reading");
  p.versions!.push({
    id: v2,
    at: 2,
    prompt: lib.promptKey("other instructions"),
    model: "m",
    secs: 1,
    truncated: false,
  });
  await lib.saveCurrent(p);
  writeFileSync(lib.texPath(p.id), "second reading");
  p.current = v2;

  // more corrections on v2, then back to v1: both texts survive
  writeFileSync(lib.texPath(p.id), "second reading, corrected");
  await lib.useVersion(p, "v1");
  expect(readFileSync(lib.texPath(p.id), "utf8")).toBe("first reading, corrected");
  expect(await lib.versionText(p, "v2")).toBe("second reading, corrected");
  expect(p.current).toBe("v1");

  await expect(lib.deleteVersion(p, "v1")).rejects.toThrow(); // the one shown stays
  await lib.deleteVersion(p, "v2");
  expect(p.versions?.map((v) => v.id)).toEqual(["v1"]);
  expect(lib.nextVersion(p)).toBe("v2");
});

test("versions: the same instructions are kept once", () => {
  const lib = new Library(scratch("prompts"));
  const a = lib.promptKey("Transcribe this page.");
  expect(lib.promptKey("Transcribe this page.")).toBe(a);
  expect(lib.promptKey("Transcribe this page!")).not.toBe(a);
  expect(lib.prompts[a]).toBe("Transcribe this page.");
});

test("models: a server is used only on this computer or the local network", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.20",
    "169.254.1.1",
    "100.100.1.1",
    "::1",
    "fd12::1",
    "fe80::1",
    "::ffff:192.168.0.2",
  ])
    expect(isPrivateAddress(ip), ip).toBe(true);
  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])
    expect(isPrivateAddress(ip), ip).toBe(false);
  await expect(checkLocalUrl("http://127.0.0.1:11434")).resolves.toBeUndefined();
  await expect(checkLocalUrl("http://[::1]:1234/v1")).resolves.toBeUndefined();
  await expect(checkLocalUrl("https://8.8.8.8/v1")).rejects.toThrow();
  await expect(checkLocalUrl("ftp://127.0.0.1")).rejects.toThrow();
  await expect(checkLocalUrl("not a url")).rejects.toThrow();
});

test("models: a server's address leads to its OpenAI-style API", () => {
  expect(apiBase("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1");
  expect(apiBase("http://127.0.0.1:1234/v1/")).toBe("http://127.0.0.1:1234/v1");
});
