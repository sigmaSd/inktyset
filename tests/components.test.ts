import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { findFile, MODEL_FILES, sizeOf, verifyModelDir } from "../src/components.ts";

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
