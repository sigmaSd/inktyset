import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import {
  bundled,
  bundledDir,
  dirOf,
  findFile,
  MODEL_FILES,
  programPath,
  sizeOf,
  verifyModelDir,
} from "../src/components.ts";

test("downloads: a program is found wherever its archive nested it", async () => {
  const dir = scratch("find");
  mkdirSync(`${dir}/llama-b1/bin`, { recursive: true });
  writeFileSync(`${dir}/llama-b1/bin/llama-server`, "");
  expect(await findFile(dir, "llama-server")).toBe(join(dir, "llama-b1", "bin", "llama-server"));
  expect(await findFile(dir, "tectonic")).toBeNull();
  expect(await findFile(`${dir}/missing`, "x")).toBeNull();
});

test("downloads: a model folder with missing or wrong files is refused before any checksum", async () => {
  const dir = scratch("model");
  await expect(verifyModelDir(dir, () => {})).rejects.toThrow(/missing or has the wrong size/);
  for (const f of MODEL_FILES) writeFileSync(`${dir}/${f.file}`, "too small");
  await expect(verifyModelDir(dir, () => {})).rejects.toThrow(/wrong size/);
});

test("downloads: the model is the two files, about 6.6 GB", () => {
  expect(MODEL_FILES.map((f) => f.file)).toEqual(["Qwen3.5-9B-Q4_K_M.gguf", "mmproj-F16.gguf"]);
  expect(sizeOf("model")).toBe(5680522464 + 918166080);
});

test("bundled programs: a Flatpak looks in /app/bin, INKTYSET_BUNDLED names another folder, others have none", () => {
  expect(bundledDir({ FLATPAK_ID: "io.github.sigmasd.inktyset" })).toBe("/app/bin");
  expect(bundledDir({ INKTYSET_BUNDLED: "/opt/x", FLATPAK_ID: "io.github.sigmasd.inktyset" })).toBe("/opt/x");
  expect(bundledDir({ APPIMAGE: "/home/me/Inktyset.AppImage" })).toBeNull();
  expect(bundledDir({})).toBeNull();
});

test("bundled programs: used before a downloaded copy, and only the ones the package has", async () => {
  const base = scratch("bundled-base");
  const shipped = scratch("bundled-bin");
  const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);
  writeFileSync(join(shipped, exe("llama-server")), "");
  writeFileSync(join(shipped, exe("typst")), "");
  mkdirSync(dirOf(base, "engine"), { recursive: true });
  writeFileSync(join(dirOf(base, "engine"), exe("llama-server")), "");
  mkdirSync(join(dirOf(base, "tectonic"), "nested"), { recursive: true });
  writeFileSync(join(dirOf(base, "tectonic"), "nested", exe("tectonic")), "");
  const env = { INKTYSET_BUNDLED: shipped };

  expect(bundled("engine", env)).toBe(join(shipped, exe("llama-server")));
  expect(bundled("tectonic", env)).toBeNull(); // not shipped: downloaded as usual
  expect(await programPath(base, "engine", env)).toBe(join(shipped, exe("llama-server")));
  expect(await programPath(base, "typst", env)).toBe(join(shipped, exe("typst")));
  expect(await programPath(base, "tectonic", env)).toBe(
    join(dirOf(base, "tectonic"), "nested", exe("tectonic")),
  );
  // without a bundled folder (AppImage, deb, rpm, Windows, macOS): the downloaded copies, or nothing yet
  expect(await programPath(base, "engine", {})).toBe(join(dirOf(base, "engine"), exe("llama-server")));
  expect(await programPath(base, "typst", {})).toBeNull();
});
