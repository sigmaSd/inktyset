import { createServer } from "node:http";
import { expect, test } from "vite-plus/test";
import { scratch } from "./_env.ts";
import { type Delta, Model } from "../src/model.ts";

/**
 * A model server on this computer that answers as llama-server does when asked to stream: some thinking, then the
 * text, a token an event, then its timings and usage. `plain`: it ignores "stream" and answers at once.
 */
async function fakeServer(plain = false) {
  const asked: { stream?: boolean; messages: unknown[] }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "m" }] }));
      const ask = JSON.parse(body);
      asked.push(ask);
      if (plain)
        return res.end(
          JSON.stringify({
            choices: [{ message: { content: "$x$" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 3 },
          }),
        );
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { reasoning_content: "a sum" } }] });
      send({ choices: [{ delta: { content: "$a" } }] });
      send({ choices: [{ delta: { content: " + b$" }, finish_reason: "stop" }] });
      send({
        choices: [],
        timings: { predicted_n: 7, predicted_per_second: 40, prompt_n: 120, prompt_ms: 1500 },
        usage: { prompt_tokens: 900, completion_tokens: 7 },
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

test("a page is read streamed: its thinking and text as they come; the prompt's time and all its tokens are kept when the engine says them", async () => {
  const srv = await fakeServer();
  try {
    const model = new Model(scratch("model-stream"), () => {});
    model.config = { kind: "server", url: srv.url };
    const signal = new AbortController().signal;
    const page = Buffer.from("page");

    const seen: Delta[] = [];
    const r = await model.read(page, "Read it.", signal, [{ jpeg: Buffer.from("ex"), text: "$e$" }], (d) =>
      seen.push({ ...d }),
    );
    expect(r).toMatchObject({
      text: "$a + b$",
      thinking: "a sum",
      finish: "stop",
      tokens: 7,
      tps: 40,
      promptTokens: 120, // read now (the rest the engine had from the request before)
      promptSecs: 1.5,
      inTokens: 900, // all of it
    });
    expect(srv.asked[0].stream).toBe(true);
    expect(srv.asked[0].messages).toHaveLength(3); // the example asked and answered, then the page
    expect(seen.at(-1)).toEqual({ text: "$a + b$", thinking: "a sum", textTokens: 2, thinkTokens: 1 });

    const plain = await model.read(page, "Read it.", signal);
    expect(srv.asked[1].stream).toBe(true); // without examples too
    expect(plain.text).toBe("$a + b$");
  } finally {
    srv.close();
  }
});

test("a server that ignores the stream and answers at once is read all the same", async () => {
  const srv = await fakeServer(true);
  try {
    const model = new Model(scratch("model-plain"), () => {});
    model.config = { kind: "server", url: srv.url };
    const r = await model.read(Buffer.from("page"), "Read it.", new AbortController().signal);
    expect(r).toMatchObject({ text: "$x$", finish: "stop", tokens: 3, inTokens: 50, promptSecs: null });
  } finally {
    srv.close();
  }
});
