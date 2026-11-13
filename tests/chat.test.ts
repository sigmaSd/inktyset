import { expect, test } from "vite-plus/test";
import {
  applyEdits,
  type ChatMessage,
  editsIn,
  fitHistory,
  imageTokens,
  isWholePage,
  PROPOSED,
  proposalIn,
  withoutEdits,
} from "../src/chat.ts";

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

test("chat: a fix comes as find-and-replace blocks, applied with any spacing", () => {
  const answer =
    "I replaced it.\n<<<<<<< FIND\nI\\alpha_i,\n=======\nici,\n>>>>>>> REPLACE\nand\n<<<<<<< FIND\n\\R\n=======\n\\mathbb{R}\n>>>>>>> REPLACE";
  const edits = editsIn(answer);
  expect(edits).toEqual([
    { find: "I\\alpha_i,", replace: "ici," },
    { find: "\\R", replace: "\\mathbb{R}" },
  ]);
  const page = "On a $I \\alpha _ i ,$ x \\in \\R and y \\in \\R.";
  expect(applyEdits(page, edits)).toEqual({
    text: "On a $ici,$ x \\in \\mathbb{R} and y \\in \\mathbb{R}.",
    unplaced: 0,
  });
  expect(applyEdits(page, [{ find: "\\beta", replace: "b" }]).unplaced).toBe(1);
  expect(withoutEdits(answer)).toBe("I replaced it.\n\nand");
});

test("chat: SEARCH blocks too, and change markers or a piece of the page are never taken as the whole page", () => {
  const fenced = "C'est corrigé.\n```latex\n<<<<<<< SEARCH\nI\\alpha_i,\n=======\nIc\n>>>>>>> REPLACE\n```";
  expect(editsIn(fenced)).toEqual([{ find: "I\\alpha_i,", replace: "Ic" }]);
  expect(proposalIn(fenced)).toBeUndefined(); // the markers' block is a change, not a new page
  expect(withoutEdits(fenced)).toBe("C'est corrigé.");
  const page = "x".repeat(1000);
  expect(isWholePage("one corrected line", page)).toBe(false);
  expect(isWholePage("y".repeat(900), page)).toBe(true);
  expect(isWholePage("short", "a short page")).toBe(true);
});
