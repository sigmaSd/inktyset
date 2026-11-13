// The app was called hand2tex before Inktyset (2026-11-13): its folders move over once, at start. Entry by entry
// and never overwriting (as in MedStation's src/migrate.ts): anything already in the new folder stays, and what
// couldn't move is left where it was (and said so in the journal).

import { existsSync } from "node:fs";
import { readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Move `from` to `to`: in one go when `to` doesn't exist yet, else entry by entry (only `only` when given),
 * skipping what's already there. Returns what moved and what was left.
 */
export async function migrateDir(from: string, to: string, only?: string[]) {
  const moved: string[] = [],
    kept: string[] = [];
  if (!existsSync(from)) return { moved, kept };
  if (!existsSync(to) && !only) {
    await rename(from, to);
    return { moved: ["(all)"], kept };
  }
  for (const name of only ?? (await readdir(from))) {
    const a = join(from, name),
      b = join(to, name);
    if (!existsSync(a)) continue;
    if (existsSync(b)) {
      kept.push(name);
      continue;
    }
    try {
      await rename(a, b);
      moved.push(name);
    } catch {
      kept.push(name); // another disk, or in use: left in place
    }
  }
  await rmdir(from).catch(() => {}); // only if nothing is left in it
  return { moved, kept };
}
