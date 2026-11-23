import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { Core } from "../src/core.ts";
import { serve } from "../src/server.ts";

test("right-click menu: a picture's address gives its file on disk, only for the pages' own pictures", async () => {
  const dir = scratch("files-at");
  mkdirSync(join(dir, "user"));
  const core = new Core(join(dir, "pages"), join(dir, "user"));
  await core.lib.init();
  const lib = core.lib.dir;
  mkdirSync(join(lib, "build", "page0001"), { recursive: true });
  writeFileSync(join(lib, "scans", "page0001.jpg"), "jpg");
  writeFileSync(join(lib, "build", "page0001", "render-1.png"), "png");
  writeFileSync(join(lib, "pages", "page0001.tex"), "tex");
  mkdirSync(join(dir, "ui"));
  const served = await serve(core, join(dir, "ui"));
  try {
    const at = (path: string) => served.fileAt(served.origin + path);
    expect(at("/files/scans/page0001.jpg?r=3")).toBe(join(lib, "scans", "page0001.jpg"));
    expect(at("/files/build/page0001/render-1.png?r=1")).toBe(join(lib, "build", "page0001", "render-1.png"));
    // not a picture folder, outside the pages, missing, or another site's address: nothing
    expect(at("/files/pages/page0001.tex")).toBeNull();
    expect(at("/files/../state.json")).toBeNull();
    expect(at("/files/scans/page0002.jpg")).toBeNull();
    expect(at("/index.html")).toBeNull();
    expect(served.fileAt("http://example.com/files/scans/page0001.jpg")).toBeNull();
    expect(served.fileAt("not an address")).toBeNull();
  } finally {
    served.close();
  }
});
