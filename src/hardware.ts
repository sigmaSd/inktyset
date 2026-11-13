// What this computer can do for the model: its memory, and the graphics chips the engine can use (asked from
// llama-server itself, `--list-devices`, once the engine is downloaded). Shown at setup and in Settings, so
// nobody waits an hour for a page without knowing why.

import { freemem, totalmem } from "node:os";
import { run } from "./run.ts";

export interface Device {
  name: string; // "Vulkan0: AMD Radeon 760M Graphics (RADV PHOENIX)"
  totalMiB: number;
  freeMiB: number;
}

export interface Advice {
  level: "ok" | "warn" | "bad";
  id: "memLow" | "memTight" | "noGpu" | "smallGpu";
  /** GB the model needs, and this computer's. */
  need: number;
  have: number;
}

export interface Hardware {
  memoryGB: number;
  freeMemoryGB: number;
  /** null until the engine is there to ask. */
  devices: Device[] | null;
  /** What to tell the user, worded by the window in its language (app/ui/i18n.ts): nothing when all is well. */
  advice: Advice[];
}

/** About what the 9B model takes while reading: weights, image encoder and context. */
const NEEDS_GB = 8;

/** "  Vulkan0: AMD Radeon 760M Graphics (RADV PHOENIX) (16045 MiB, 13904 MiB free)" */
export function parseDevices(out: string): Device[] {
  const devices: Device[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s+(\S+: .*?) \((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
    if (m) devices.push({ name: m[1], totalMiB: Number(m[2]), freeMiB: Number(m[3]) });
  }
  return devices;
}

export function advise(memoryGB: number, devices: Device[] | null): Hardware["advice"] {
  const advice: Hardware["advice"] = [];
  const gb = { need: NEEDS_GB, have: Math.round(memoryGB) };
  if (memoryGB < NEEDS_GB) {
    advice.push({
      level: "bad",
      id: "memLow",
      ...gb,
    });
  } else if (memoryGB < NEEDS_GB + 4) {
    advice.push({
      level: "warn",
      id: "memTight",
      ...gb,
    });
  }
  if (devices && !devices.length) {
    advice.push({
      level: "warn",
      id: "noGpu",
      ...gb,
    });
  } else if (devices && devices.every((d) => d.totalMiB < NEEDS_GB * 1024 * 0.75)) {
    advice.push({
      level: "warn",
      id: "smallGpu",
      ...gb,
    });
  }
  return advice;
}

export async function checkHardware(serverPath: string | null): Promise<Hardware> {
  const memoryGB = totalmem() / 1024 ** 3;
  let devices: Device[] | null = null;
  if (serverPath) {
    const r = await run(serverPath, ["--list-devices"], { timeoutMs: 30_000 });
    if (r.code === 0) devices = parseDevices(r.stdout + "\n" + r.stderr);
  }
  return { memoryGB, freeMemoryGB: freemem() / 1024 ** 3, devices, advice: advise(memoryGB, devices) };
}
