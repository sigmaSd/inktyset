// Running other programs (TeX, tar, scanimage) and finding them.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a program to the end; never throws (a missing program is code null, its error in stderr). */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<Result> {
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "";
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          stderr += `\n(stopped after ${Math.round(opts.timeoutMs! / 1000)} s)`;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const EXTS = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

/** The full path of a program, looked up in PATH and then in `extra` folders; null when absent. */
export function which(name: string, extra: string[] = []): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of EXTS) {
      const p = join(dir, name + ext.toLowerCase());
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* unreadable: skip */
      }
    }
  }
  return null;
}
