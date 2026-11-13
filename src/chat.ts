// The page chat (Compare view): questions about one page, answered by the same local model that reads the pages.
// Each page's chat is kept in the pages folder (chats/<id>.json, its pictures in chats/<id>/), like the pages.
// The model sees the page's scan and its current text, then the conversation: as much of it as fits in its
// context (fitHistory). An answer that rewrites the page carries the whole new text in one code block
// (proposalIn), or, for a fix, only the changes as find-and-replace blocks (editsIn, applied here by
// applyEdits: a one-word fix costs the model a few tokens, not the whole page); the window shows the result word
// by word against the current text, and Apply makes it a new version.
// The queue (src/core.ts) answers a question before the next page, or at once with "Answer now".

/** A picture attached to a question: a part of the scan or of the preview, or the whole preview. */
export interface Attachment {
  /** Under the pages folder: chats/<id>/aN.jpg. */
  file: string;
  from: "scan" | "preview";
  w: number;
  h: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
  attach?: Attachment[];
  /** The model's reasoning before it answered (thinking). */
  thinking?: string;
  secs?: number;
  /** The page's whole new text, when the answer rewrites it; and what became of it. */
  proposal?: string;
  applied?: string;
  dismissed?: boolean;
  /** Changes the answer gave that weren't found in the page's text (not applied). */
  unplaced?: number;
  /** Cut off: the answer was longer than the model may write at once. */
  cut?: boolean;
  /** Stopped before it was done, or failed (why). */
  stopped?: boolean;
  err?: string;
}

export interface Chat {
  page: string;
  messages: ChatMessage[];
}

/** Roughly how many tokens a text takes (LaTeX is dense: about 3 characters each). */
export const textTokens = (s: string) => Math.ceil(s.length / 3);
/** Roughly how many tokens a picture takes: Qwen's vision sees 28 × 28 pixel squares. */
export const imageTokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);

/** What an older answer's rewrite becomes in the history: its text is the page's, sent once already. */
export const PROPOSED = "[the whole new text of the page was proposed here]";

/**
 * Which messages go to the model, newest first until `budget` tokens: the last question always, with its
 * pictures; pictures of the two latest questions; older pictures and older rewrites only named. Returns the
 * messages as they'll be sent (`images` false: its pictures are left out).
 */
export function fitHistory(
  messages: readonly ChatMessage[],
  budget: number,
): { message: ChatMessage; images: boolean; text: string }[] {
  const out: { message: ChatMessage; images: boolean; text: string }[] = [];
  let used = 0,
    questions = 0,
    rewrites = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.err && !m.text) continue; // a failure has nothing to tell the model
    let text = m.text;
    if (m.role === "assistant" && m.proposal !== undefined && rewrites++ > 0) text = withoutCode(text);
    const images = m.role === "user" && questions++ < 2;
    const cost =
      textTokens(text) + (images ? (m.attach ?? []).reduce((n, a) => n + imageTokens(a.w, a.h), 0) : 0) + 8;
    if (out.length && used + cost > budget) break;
    used += cost;
    out.unshift({ message: m, images, text });
  }
  return out;
}

const CODE = /```(?:latex|tex|typst|typ)?[ \t]*\n([\s\S]*?)\n?```/g;

/** An answer's code block replaced by a short note (an older rewrite, in the history). */
export const withoutCode = (text: string) => text.replace(CODE, PROPOSED);

/** Lines of a change block (<<<<<<< / ======= / >>>>>>>). */
const MARKERS = /^(?:<{5,}|={5,}|>{5,})/m;

/**
 * The whole new text of the page in an answer (its last code block), or undefined when it has none. A block
 * holding change markers is a change, not a page (a malformed one: nothing to apply).
 */
export function proposalIn(answer: string): string | undefined {
  const blocks = [...answer.matchAll(CODE)].filter((m) => !MARKERS.test(m[1]));
  const body = blocks.at(-1)?.[1].trim();
  return body ? body : undefined;
}

/**
 * Is this block the whole page rewritten, or only a piece of it (a line the model corrected)? A piece taken
 * for the page would make Apply drop the rest: only a block at least 60% as long as the page counts.
 */
export const isWholePage = (block: string, page: string) =>
  page.trim().length < 200 || block.length >= 0.6 * page.trim().length;

// the model writes SEARCH (as code-editing tools taught it) or FIND (as asked before 0.9.2)
const EDIT = /<{5,}[ \t]*(?:SEARCH|FIND)?[^\n]*\n([\s\S]*?)\n?={5,}[^\n]*\n([\s\S]*?)\n?>{5,}[^\n]*/g;

// …and sometimes leaves out the opening line, inside a code block: the code block's start is then the start
// (seen with the real model, one answer in four)
const HEADLESS = /```\w*[ \t]*\n((?:(?!<{5,})[\s\S])*?)\n?={5,}[^\n]*\n([\s\S]*?)\n?>{5,}[^\n]*\n?```/g;

/** The changes in an answer, as find-and-replace blocks (see chatInstructions). */
export function editsIn(answer: string): { find: string; replace: string }[] {
  const found = [...answer.matchAll(EDIT)];
  const blocks = found.length ? found : [...answer.matchAll(HEADLESS)];
  return blocks.map((m) => ({ find: m[1], replace: m[2] })).filter((e) => e.find.trim());
}

/** An answer with its change blocks taken out (they're shown as the text they make). */
export const withoutEdits = (text: string) =>
  text
    .replace(EDIT, "")
    .replace(HEADLESS, "")
    .replace(/```\w*\s*```/g, "")
    .trim();

/**
 * The page's text with these changes made: each one wherever its text appears, as written or with other spacing
 * (LaTeX doesn't care, the model often doesn't copy it exactly). `unplaced`: how many weren't found.
 */
export function applyEdits(text: string, edits: { find: string; replace: string }[]) {
  let out = text,
    unplaced = 0;
  for (const { find, replace } of edits) {
    if (out.includes(find)) {
      out = out.split(find).join(replace);
      continue;
    }
    const chars = [...new Intl.Segmenter().segment(find.replace(/\s+/g, ""))].map((g) => g.segment);
    const loose = new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "g");
    if (chars.length && loose.test(out)) out = out.replace(loose, () => replace);
    else unplaced++;
  }
  return { text: out, unplaced };
}

/**
 * What the model is told, for a page in LaTeX or Typst: the chat's own instructions (the reading ones are for
 * transcribing, these for talking and fixing), with the page's language and the user's notes on their writing.
 */
export function chatInstructions(format: "latex" | "typst", language = "", notes = ""): string {
  const name = format === "typst" ? "Typst" : "LaTeX";
  const fence = format === "typst" ? "typst" : "latex";
  return [
    `You help someone check the ${name} transcription of one handwritten page.`,
    `You are given a picture of the page and its current ${name} text, then their messages; they may add`,
    "pictures of parts of the page or of how it typesets.",
    "When they say something is wrong, or ask for a change, make the change; don't ask whether they want it.",
    "Say in one sentence what you changed, then give each change as a block like this:",
    "<<<<<<< SEARCH",
    `the exact text to change, copied from the page's current ${name}`,
    "=======",
    "the new text",
    ">>>>>>> REPLACE",
    "Copy the SEARCH text exactly, with a little around it so it is found; it is changed everywhere it appears.",
    "Never put a change block inside a code block, and never give only a part of the page in a code block.",
    "Use one block per change. Only when most of the page changes, give the whole new text in one",
    `\`\`\`${fence} block instead.`,
    "Otherwise answer briefly, in the language they write in, with math between $...$.",
    "Keep to what is written on the page: never add content that isn't there.",
    "A word that was read as math is plain text: write it outside $...$.",
    ...(language && language !== "English" ? [`The prose on the page is in ${language}.`] : []),
    ...(notes.trim() ? ["Notes from the person who wrote the page, about their writing:", notes.trim()] : []),
  ].join("\n");
}
