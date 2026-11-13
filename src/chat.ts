// The page chat (Compare view): questions about one page, answered by the same local model that reads the pages.
// Each page's chat is kept in the pages folder (chats/<id>.json, its pictures in chats/<id>/), like the pages.
// The model sees the page's scan and its current text, then the conversation: as much of it as fits in its
// context (fitHistory). An answer that rewrites the page carries the whole new text in one code block
// (proposalIn); the window shows it word by word against the current text, and Apply makes it a new version.
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

/** The whole new text of the page in an answer (its last code block), or undefined when it has none. */
export function proposalIn(answer: string): string | undefined {
  const blocks = [...answer.matchAll(CODE)];
  const body = blocks.at(-1)?.[1].trim();
  return body ? body : undefined;
}

/** What the model is told, for a page in LaTeX or Typst. */
export function chatInstructions(format: "latex" | "typst"): string {
  const name = format === "typst" ? "Typst" : "LaTeX";
  const fence = format === "typst" ? "typst" : "latex";
  return [
    `You help someone check the ${name} transcription of one handwritten page.`,
    `You are given a picture of the page and its current ${name} text, then their questions; they may add`,
    "pictures of parts of the page or of how it typesets.",
    "Answer briefly, in the language they write in. Write math between $...$ in explanations.",
    `When they ask you to change the text, say in one sentence what you changed, then give the complete new`,
    `${name} text of the page in a single \`\`\`${fence} block: the whole page, changing only what they asked.`,
    "Keep to what is written on the page: never add content that isn't there.",
  ].join("\n");
}
