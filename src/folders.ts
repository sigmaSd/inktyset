// Where the pages live. Inktyset keeps them in Documents/Inktyset unless the user picks another folder in
// Settings (Settings.folder); it then restarts there, and the folder it leaves stays as it is, listed so the user
// can go back to it. The shell reads the setting before starting (shell/electron/main.ts).

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** How many other folders are remembered. */
const RECENT = 6;

/**
 * The folder the pages go in when the user picks `chosen`: the folder itself when it already holds Inktyset's
 * pages or is empty, else an "Inktyset" folder inside it, so the files already there are never mixed with ours.
 */
export async function pagesFolderIn(chosen: string): Promise<string> {
  const dir = resolve(chosen);
  if (await isPagesFolder(dir)) return dir;
  const entries = await readdir(dir).catch(() => [] as string[]);
  if (!entries.filter((e) => !e.startsWith(".")).length) return dir;
  return join(dir, "Inktyset");
}

/** Does this folder hold Inktyset's pages? (Its state.json, src/library.ts.) */
export async function isPagesFolder(dir: string): Promise<boolean> {
  return !!(await stat(join(dir, "state.json")).catch(() => null))?.isFile();
}

/** The folders to offer: the one just left first, without the one in use, at most a few. */
export function rememberFolder(recent: readonly string[], left: string, now: string): string[] {
  return [...new Set([left, ...recent])].filter((d) => d !== now).slice(0, RECENT);
}
