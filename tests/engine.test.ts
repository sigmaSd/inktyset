import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { fakeEngine } from "./_engine.ts";
import { scratch } from "./_env.ts";
import { Model } from "../src/model.ts";

// (a script run as a program: not on Windows)
test.skipIf(process.platform === "win32")(
  "an engine stopped is gone before the next one starts (llama.cpp fits the next to the memory it freed)",
  async () => {
    const dir = scratch("engine-stop");
    const fake = fakeEngine(dir);
    const engine = (name: string) => {
      mkdirSync(join(dir, name));
      const m = new Model(join(dir, name), () => {}, name);
      m.config = {
        kind: "files",
        serverPath: fake.bin,
        modelFile: fake.modelFile,
        mmprojFile: fake.mmprojFile,
      };
      return m;
    };
    const app = engine("app");
    const other = engine("other");
    await app.ensure();
    const stopped = app.stop(); // not waited for here: the next engine's start waits itself
    expect(app.status).toBe("stopped");
    await other.ensure();
    await stopped;
    await other.stop();
    const kinds = fake.events().map((e) => e.split(" ")[0]);
    expect(kinds).toEqual(["start", "exit", "start", "exit"]);
    // the second started after the first had exited
    const [first, , second] = fake.events().map((e) => e.split(" ")[1]);
    expect(fake.events()[1]).toBe(`exit ${first}`);
    expect(second).not.toBe(first);
  },
  20_000, // engines started one after another, each a second or so
);

test("stopping an engine that isn't running settles at once", async () => {
  const m = new Model(scratch("engine-idle"), () => {});
  await m.stop();
  expect(m.status).toBe("stopped");
});
