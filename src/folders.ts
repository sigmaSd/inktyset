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
 * The folder given with `--folder=<path>` (or `--folder <path>`), resolved from `cwd`, and the other arguments
 * (to start again without it once the user picks another folder).
 */
export function folderArg(args: readonly string[], cwd: string): { folder?: string; rest: string[] } {
  const rest: string[] = [];
  let folder: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--folder=")) folder = a.slice("--folder=".length);
    else if (a === "--folder" && i + 1 < args.length) folder = args[++i];
    else rest.push(a);
  }
  return { folder: folder ? resolve(cwd, folder) : undefined, rest };
}
