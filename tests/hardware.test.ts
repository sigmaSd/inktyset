import { expect, test } from "vite-plus/test";
import { advise, parseDevices } from "../src/hardware.ts";

test("hardware: reads llama-server's device list", () => {
  const out =
    "Available devices:\n  Vulkan0: AMD Radeon 760M Graphics (RADV PHOENIX) (16045 MiB, 13904 MiB free)\n";
  expect(parseDevices(out)).toEqual([
    { name: "Vulkan0: AMD Radeon 760M Graphics (RADV PHOENIX)", totalMiB: 16045, freeMiB: 13904 },
  ]);
  expect(parseDevices("Available devices:\n")).toEqual([]);
});

test("hardware: warns about little memory, and about reading without a graphics chip", () => {
  expect(advise(30, [{ name: "Vulkan0: GPU", totalMiB: 16045, freeMiB: 14000 }])).toEqual([]);
  expect(advise(6, null)[0].level).toBe("bad");
  expect(advise(10, null)[0].level).toBe("warn");
  expect(
    advise(30, [])
      .map((a) => a.text)
      .join(),
  ).toContain("processor");
  expect(advise(30, [{ name: "CUDA0: small", totalMiB: 4096, freeMiB: 4000 }]).length).toBe(1);
});
