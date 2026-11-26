// A stand-in for llama-server, for the tests that start and stop engines: it answers /health and reads every page
// as nothing, writes "start <pid>" and "exit <pid>" to engine-events.txt beside it, and takes a moment to exit when
// stopped, as a real engine freeing its memory does.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROGRAM = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
const events = join(dirname(process.argv[1]), "engine-events.txt");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
appendFileSync(events, "start " + process.pid + "\\n");
createServer((req, res) => {
  if (req.url === "/health") return res.end("{}");
  req.resume();
  req.on("end", () =>
    res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })),
  );
}).listen(port, "127.0.0.1");
setTimeout(() => process.exit(0), 60_000).unref(); // never left running by a test that failed
process.on("SIGTERM", () =>
  setTimeout(() => {
    appendFileSync(events, "exit " + process.pid + "\\n");
    process.exit(0);
  }, 300),
);
`;

/** The fake engine in `dir`, with a model and vision file for it to "load". */
export function fakeEngine(dir: string) {
  const bin = join(dir, "llama-server.mjs");
  writeFileSync(bin, PROGRAM);
  chmodSync(bin, 0o755);
  const modelFile = join(dir, "model.gguf");
  const mmprojFile = join(dir, "mmproj.gguf");
  writeFileSync(modelFile, "");
  writeFileSync(mmprojFile, "");
  return {
    bin,
    modelFile,
    mmprojFile,
    /** What its engines did, in order: ["start 12", "exit 12", …]. */
    events: (): string[] => {
      try {
        return readFileSync(join(dir, "engine-events.txt"), "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
