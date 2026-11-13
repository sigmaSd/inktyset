import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { migrateDir } from "../src/migrate.ts";

test("migration: the old folder moves in one go when the new one doesn't exist", async () => {
  const dir = scratch("migrate-all");
  mkdirSync(`${dir}/old/pages`, { recursive: true });
  writeFileSync(`${dir}/old/state.json`, "{}");
  const r = await migrateDir(`${dir}/old`, `${dir}/new`);
  expect(r.moved).toEqual(["(all)"]);
  expect(existsSync(`${dir}/new/pages`)).toBe(true);
  expect(existsSync(`${dir}/old`)).toBe(false);
});

test("migration: entry by entry, never overwriting what's already there", async () => {
  const dir = scratch("migrate-some");
  mkdirSync(`${dir}/old/components`, { recursive: true });
  writeFileSync(`${dir}/old/settings.json`, "old");
  mkdirSync(`${dir}/new`, { recursive: true });
  writeFileSync(`${dir}/new/settings.json`, "new");
  const r = await migrateDir(`${dir}/old`, `${dir}/new`, ["settings.json", "components", "window.json"]);
  expect(r.moved).toEqual(["components"]);
  expect(r.kept).toEqual(["settings.json"]);
  expect(readFileSync(`${dir}/new/settings.json`, "utf8")).toBe("new");
  expect(existsSync(`${dir}/old/settings.json`)).toBe(true); // left, not lost
});
