// A stand-in for llama-server, for the tests that start and stop engines: it answers /health and reads every page
// as nothing, writes "start <pid>" and "exit <pid>" to engine-events.txt beside it (and the options it was started
// with to engine-args.json), knows two options in its --help, and takes a moment to exit when stopped, as a real
// engine freeing its memory does. With `words`, it streams them instead (when asked to), a moment apart.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROGRAM = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
const events = join(dirname(process.argv[1]), "engine-events.txt");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("-ub,   --ubatch-size N                  physical maximum batch size");
  console.log("--op-offload, --no-op-offload           whether to offload host tensor operations");
  process.exit(0);
}
writeFileSync(join(dirname(process.argv[1]), "engine-args.json"), JSON.stringify(args));
const port = Number(args[args.indexOf("--port") + 1]);
appendFileSync(events, "start " + process.pid + "\\n");
createServer((req, res) => {
  if (req.url === "/health") return res.end("{}");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const words = join(dirname(process.argv[1]), "words.json");
    if (!JSON.parse(body).stream || !existsSync(words))
      return res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const delta of JSON.parse(readFileSync(words, "utf8"))) {
      await new Promise((ok) => setTimeout(ok, 250));
      res.write("data: " + JSON.stringify({ choices: [{ delta }] }) + "\\n\\n");
    }
    res.end("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\\n\\ndata: [DONE]\\n\\n");
  });
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
export function fakeEngine(dir: string, words?: { content?: string; reasoning_content?: string }[]) {
  const bin = join(dir, "llama-server.mjs");
  writeFileSync(bin, PROGRAM);
  if (words) writeFileSync(join(dir, "words.json"), JSON.stringify(words));
  chmodSync(bin, 0o755);
  const modelFile = join(dir, "model.gguf");
  const mmprojFile = join(dir, "mmproj.gguf");
  writeFileSync(modelFile, "");
  writeFileSync(mmprojFile, "");
  return {
    bin,
    modelFile,
    mmprojFile,
    /** The options the last engine started was given. */
    args: (): string[] => JSON.parse(readFileSync(join(dir, "engine-args.json"), "utf8")),
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
