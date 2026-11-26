// The README's and website's screenshots: headless Chrome, driven over its DevTools protocol, opens the window's
// page of a running Inktyset (started with --dev, on a copy of some pages) and saves PNGs.
//
//   INKTYSET_DATA=… INKTYSET_USERDATA=… electron . --dev --no-window     (prints the link)
//   node tools/screenshots.ts '<link with ?k=…>' docs/screenshots [pages|compare-models]
//
// pages (the default): the page list and the Compare view of the first page. compare-models: the Compare models
// view, and its column marked closest opened (pages read by several models, one of them checked).
//
// Needs google-chrome or chromium on PATH. Only the page is captured, not the window around it. Dark theme
// only: the README and the website show the app dark.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "../src/run.ts";

const [link, out = "docs/screenshots", set = "pages"] = process.argv.slice(2);
if (!link?.includes("?k=") || !["pages", "compare-models"].includes(set)) {
  console.error(
    "usage: node tools/screenshots.ts '<link printed by --dev>' [out-dir] [pages|compare-models]",
  );
  process.exit(2);
}
const chrome = which("google-chrome") ?? which("chromium-browser") ?? which("chromium");
if (!chrome) throw new Error("google-chrome or chromium is needed");

const tmp = process.env.TMPDIR ?? join(process.env.HOME!, "dev", "tmp");
mkdirSync(tmp, { recursive: true });
const profile = mkdtempSync(join(tmp, "inktyset-shots-"));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(
  chrome,
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
  {
    stdio: "ignore",
  },
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ws: WebSocket | undefined;
for (let i = 0; i < 50 && !ws; i++) {
  await sleep(200);
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {
    /* not up yet */
  }
}
if (!ws) throw new Error("Chrome did not start");
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
  if (m.id && pending.has(m.id)) {
    if (m.error) console.error(m.error.message);
    pending.get(m.id)!(m.result);
    pending.delete(m.id);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<unknown>((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = (expression: string) => send("Runtime.evaluate", { expression, awaitPromise: true });
const shot = async (name: string) => {
  const r = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
  writeFileSync(join(out, name), Buffer.from(r.data, "base64"));
  console.log(`${out}/${name}`);
};
const theme = (dark: boolean) =>
  send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
  });

mkdirSync(out, { recursive: true });
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: link });
await sleep(3000);

for (const dark of [true]) {
  const suffix = "dark";
  await theme(dark);
  if (set === "compare-models") {
    await js(`document.querySelector("[data-act=showdown]").click()`);
    await sleep(2000);
    await shot(`compare-models-${suffix}.png`);
    // the reading closest to the checked text, against it
    await js(`(() => {
      const cols = [...document.querySelectorAll(".sd-sum")];
      const i = cols.findIndex((c) => c.classList.contains("best"));
      const cells = [...document.querySelectorAll(".sd-cell[data-sd=open]")];
      (cells[i] ?? cells[0]).click();
    })()`);
    await sleep(2000);
    await shot(`compare-models-reading-${suffix}.png`);
    continue;
  }
  await js(`document.querySelector("#compare").open && document.querySelector("#compare").close()`);
  await sleep(600);
  await shot(`list-${suffix}.png`);
  await js(`document.querySelector(".card [data-act=compare]").click()`);
  await sleep(1800);
  await shot(`compare-formula-${suffix}.png`);
}

ws.close();
proc.kill();
await sleep(1000); // Chrome writes its profile until it's gone
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
