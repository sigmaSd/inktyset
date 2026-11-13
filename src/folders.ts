// Where the pages live. Inktyset keeps them in Documents/Inktyset unless the user picks another folder in
// Settings (Settings.folder); it then restarts there, and the folder it leaves stays as it is. No list of the
// folders used before is kept: where the user keeps private pages is theirs to remember. `--folder=<path>` opens
// a folder for one run only, without touching the settings (a launcher of its own, for a private folder).
// The shell reads both before starting (shell/electron/main.ts).

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

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

/**
 * What a launcher asked for: `--folder=<path>` (resolved from `cwd`) and `--class=<name>`, the launcher the window
 * belongs to (shell/electron/main.ts); each also as `--name value`. And the other arguments, to start again.
 */
export function launchArgs(
  args: readonly string[],
  cwd: string,
): { folder?: string; cls?: string; rest: string[] } {
  const rest: string[] = [];
  const found: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(folder|class)(?:=(.*))?$/.exec(args[i]);
    if (m && m[2] !== undefined) found[m[1]] = m[2];
    else if (m && i + 1 < args.length) found[m[1]] = args[++i];
    else rest.push(args[i]);
  }
  const cls = /^[\w.-]+$/.test(found.class ?? "") ? found.class : undefined; // a desktop entry's name
  return { folder: found.folder ? resolve(cwd, found.folder) : undefined, cls, rest };
}
