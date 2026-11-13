import { expect, test } from "vite-plus/test";
import { diffWords, type Part } from "../src/diff.ts";

const join = (parts: Part[], keep: "del" | "add") =>
  parts
    .filter((p) => p.op === "same" || p.op === keep)
    .map((p) => p.text)
    .join("");

test("diff: a changed command is one change, the rest kept", () => {
  const parts = diffWords("Let $\\alpha > 0$ be fixed.", "Let $\\beta > 0$ be fixed.");
  expect(parts).toEqual([
    { op: "same", text: "Let $" },
    { op: "del", text: "\\alpha" },
    { op: "add", text: "\\beta" },
    { op: "same", text: " > 0$ be fixed." },
  ]);
});

test("diff: both texts come back from the parts, whatever changed", () => {
  const cases = [
    ["", "new text"],
    ["old text", ""],
    ["a b c d e", "a x c e f"],
    ["\\section*{Intro}\nSoit $f$ continue.", "\\section*{Introduction}\nSoit $f$ une fonction continue.\n"],
    ["same", "same"],
    ["الدالة f مستمرة", "الدالة g مستمرة"],
  ];
  for (const [a, b] of cases) {
    const parts = diffWords(a, b);
    expect(join(parts, "del")).toBe(a);
    expect(join(parts, "add")).toBe(b);
  }
});

test("diff: a long page with one changed word stays small", () => {
  const words = Array.from({ length: 3000 }, (_, i) => `w${i}`);
  const a = words.join(" ");
  const b = words.map((w, i) => (i === 1500 ? "CHANGED" : w)).join(" ");
  const parts = diffWords(a, b);
  expect(parts.filter((p) => p.op !== "same")).toEqual([
    { op: "del", text: "w1500" },
    { op: "add", text: "CHANGED" },
  ]);
});
