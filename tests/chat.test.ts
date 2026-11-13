import { expect, test } from "vite-plus/test";
import { type ChatMessage, fitHistory, imageTokens, PROPOSED, proposalIn } from "../src/chat.ts";

const q = (text: string, attach = 0): ChatMessage => ({
  role: "user",
  text,
  at: 0,
  attach: Array.from({ length: attach }, (_, i) => ({ file: `a${i}.jpg`, from: "scan", w: 560, h: 280 })),
});
const a = (text: string, proposal?: string): ChatMessage => ({ role: "assistant", text, at: 0, proposal });

test("chat: a rewrite is the answer's last code block", () => {
  expect(proposalIn("Changed it.\n```latex\n$x^2$\n```")).toBe("$x^2$");
  expect(proposalIn("Here:\n```\nfirst\n```\nthen\n```typst\nsecond\n```")).toBe("second");
  expect(proposalIn("No code, just $x$.")).toBeUndefined();
  expect(proposalIn("```latex\n\n```")).toBeUndefined();
});

test("chat: the newest messages go first, and the last question always goes", () => {
  const long = "x".repeat(3000); // about 1000 tokens
  const msgs = [q(long), a(long), q(long), a(long), q("last")];
  const fit = fitHistory(msgs, 2100);
  expect(fit.at(-1)!.text).toBe("last");
  expect(fit.length).toBe(3); // the last question, and as much before it as fits
  expect(fitHistory([q("x".repeat(30000))], 10)).toHaveLength(1);
});

test("chat: older pictures and older rewrites are only named", () => {
  const msgs = [
    q("one", 1),
    a("A\n```latex\nold\n```", "old"),
    q("two", 1),
    q("three", 1),
    a("B\n```latex\nnew\n```", "new"),
  ];
  const fit = fitHistory(msgs, 100_000);
  expect(fit.map((m) => m.images)).toEqual([false, false, true, true, false]);
  expect(fit[1].text).toBe(`A\n${PROPOSED}`);
  expect(fit[4].text).toContain("new"); // the latest rewrite stays whole
  expect(imageTokens(560, 280)).toBe(200);
});
