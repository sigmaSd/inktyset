import { createServer } from "node:http";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { Model } from "../src/model.ts";

/** A model server on this computer that answers as llama-server does: streamed when asked, else at once. */
async function fakeServer() {
  const asked: { stream?: boolean; messages: unknown[] }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "m" }] }));
      const ask = JSON.parse(body);
      asked.push(ask);
      if (!ask.stream)
        return res.end(JSON.stringify({ choices: [{ message: { content: "$x$" }, finish_reason: "stop" }] }));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { content: "$a" } }] });
      send({ choices: [{ delta: { content: " + b$" }, finish_reason: "stop" }] });
      send({
        choices: [],
        timings: { predicted_n: 7, predicted_per_second: 40, prompt_n: 120, prompt_ms: 1500 },
      });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    asked,
    close: () => server.close(),
  };
}

test("reading with examples streams (a long request isn't cut off by fetch's wait); without, it doesn't; the prompt's time is kept when the engine says it", async () => {
  const srv = await fakeServer();
  try {
    const model = new Model(scratch("model-stream"), () => {});
    model.config = { kind: "server", url: srv.url };
    const signal = new AbortController().signal;
    const page = Buffer.from("page");

    const plain = await model.read(page, "Read it.", signal);
    expect(plain.text).toBe("$x$");
    expect(plain).toMatchObject({ promptTokens: null, promptSecs: null }); // the server didn't say
    expect(srv.asked[0].stream).toBeUndefined();

    const r = await model.read(page, "Read it.", signal, [{ jpeg: Buffer.from("ex"), text: "$e$" }]);
    expect(r).toMatchObject({
      text: "$a + b$",
      finish: "stop",
      tokens: 7,
      tps: 40,
      promptTokens: 120,
      promptSecs: 1.5,
    });
    expect(srv.asked[1].stream).toBe(true);
    expect(srv.asked[1].messages).toHaveLength(3); // the example asked and answered, then the page
  } finally {
    srv.close();
  }
});
