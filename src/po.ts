// Gettext .po catalogs, the format translators know (Poedit, Weblate): reading one, writing one, and choosing
// the plural form. Inktyset's English text lives in the code (src/i18n.ts, app/ui/i18n.ts, the website's
// template); each entry's msgctxt is its key, so changing the English marks the translations fuzzy instead of
// losing them. tools/i18n.ts writes the templates and merges them into each language's file.

export interface PoEntry {
  ctx: string;
  id: string;
  plural?: string;
  /** One string, or one per plural form. */
  str: string[];
  fuzzy: boolean;
  /** "#." lines: what the translator should know. */
  comments: string[];
  /** The English it was translated from, when it changed since ("#| msgid"). */
  previous?: string;
}

export interface Catalog {
  headers: Record<string, string>;
  entries: PoEntry[];
}

const unquote = (s: string) =>
  JSON.parse(
    s
      .trim()
      .replace(/\\(?!["\\nt])/g, "\\\\")
      .replace(/\t/g, "\\t"),
  ) as string;

export function parsePo(text: string): Catalog {
  const entries: PoEntry[] = [];
  let cur: Partial<PoEntry> & { str: string[]; comments: string[] } = { str: [], comments: [], fuzzy: false };
  let field: "ctx" | "id" | "plural" | number | "previous" | null = null;
  const flush = () => {
    if (cur.id !== undefined) entries.push({ ctx: "", fuzzy: false, ...cur, id: cur.id } as PoEntry);
    cur = { str: [], comments: [], fuzzy: false };
    field = null;
  };
  const append = (s: string) => {
    if (field === null) return;
    if (typeof field === "number") cur.str[field] = (cur.str[field] ?? "") + s;
    else cur[field] = (cur[field] ?? "") + s;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    let m: RegExpExecArray | null;
    if (line.startsWith("#~")) continue; // obsolete
    if (line.startsWith("#,")) {
      if (cur.id !== undefined) flush();
      if (/\bfuzzy\b/.test(line)) cur.fuzzy = true;
    } else if (line.startsWith("#.")) {
      if (cur.id !== undefined) flush();
      cur.comments.push(line.slice(2).trim());
    } else if ((m = /^#\|\s*msgid\s+(".*")$/.exec(line))) {
      if (cur.id !== undefined) flush();
      cur.previous = unquote(m[1]);
      field = "previous";
    } else if (line.startsWith("#")) {
      if (cur.id !== undefined) flush();
    } else if ((m = /^msgctxt\s+(".*")$/.exec(line))) {
      if (cur.id !== undefined) flush();
      cur.ctx = unquote(m[1]);
      field = "ctx";
    } else if ((m = /^msgid\s+(".*")$/.exec(line))) {
      if (cur.id !== undefined) flush();
      cur.id = unquote(m[1]);
      field = "id";
    } else if ((m = /^msgid_plural\s+(".*")$/.exec(line))) {
      cur.plural = unquote(m[1]);
      field = "plural";
    } else if ((m = /^msgstr(?:\[(\d+)\])?\s+(".*")$/.exec(line))) {
      field = m[1] === undefined ? 0 : Number(m[1]);
      cur.str[field] = unquote(m[2]);
    } else if (line.startsWith('"')) append(unquote(line));
  }
  flush();
  const headerEntry = entries.find((e) => e.id === "" && !e.ctx);
  const headers: Record<string, string> = {};
  for (const l of (headerEntry?.str[0] ?? "").split("\n")) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return { headers, entries: entries.filter((e) => e !== headerEntry) };
}

const quote = (s: string) => {
  const q = (x: string) => JSON.stringify(x);
  if (!s.includes("\n") || s.indexOf("\n") === s.length - 1) return q(s);
  return (
    '""\n' +
    s
      .split(/(?<=\n)/)
      .map(q)
      .join("\n")
  ); // one line per line, as Poedit and Weblate write it
};

export function writePo(cat: Catalog): string {
  const head = Object.entries(cat.headers)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join("");
  let out = `msgid ""\nmsgstr ${quote(head)}\n`;
  for (const e of cat.entries) {
    out += "\n";
    for (const c of e.comments) out += `#. ${c}\n`;
    if (e.fuzzy) out += "#, fuzzy\n";
    if (e.previous !== undefined) out += `#| msgid ${quote(e.previous).replace(/\n/g, "\n#| ")}\n`;
    if (e.ctx) out += `msgctxt ${quote(e.ctx)}\n`;
    out += `msgid ${quote(e.id)}\n`;
    if (e.plural !== undefined) {
      out += `msgid_plural ${quote(e.plural)}\n`;
      e.str.forEach((s, i) => (out += `msgstr[${i}] ${quote(s ?? "")}\n`));
    } else out += `msgstr ${quote(e.str[0] ?? "")}\n`;
  }
  return out;
}

// ---------------------------------------------------------------- plural forms
// "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);"
// is a C expression of n. It's evaluated by this small parser (no eval: the window's CSP forbids it, and a
// catalog is not code).

type Tok = { t: "num"; v: number } | { t: "n" } | { t: "op"; v: string };

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  const re = /\s*(\d+|n|==|!=|<=|>=|&&|\|\||[-+*/%<>?:()!])/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    const x = m[1];
    toks.push(/^\d/.test(x) ? { t: "num", v: Number(x) } : x === "n" ? { t: "n" } : { t: "op", v: x });
  }
  if (re.lastIndex < s.trimEnd().length)
    throw new Error(`plural expression: unexpected "${s.slice(re.lastIndex)}"`);
  return toks;
}

/** A plural expression as a function of n. */
export function pluralFunction(expr: string): (n: number) => number {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const op = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v && (i++, true);
  type F = (n: number) => number;
  const LEVELS = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];
  const apply = (o: string, a: number, b: number): number =>
    ({
      "||": +(!!a || !!b),
      "&&": +(!!a && !!b),
      "==": +(a === b),
      "!=": +(a !== b),
      "<": +(a < b),
      ">": +(a > b),
      "<=": +(a <= b),
      ">=": +(a >= b),
      "+": a + b,
      "-": a - b,
      "*": a * b,
      "/": Math.trunc(a / b),
      "%": a % b,
    })[o]!;
  const ternary = (): F => {
    const c = binary(0);
    if (!op("?")) return c;
    const a = ternary();
    if (!op(":")) throw new Error("plural expression: missing ':'");
    const b = ternary();
    return (n) => (c(n) ? a(n) : b(n));
  };
  const binary = (level: number): F => {
    if (level === LEVELS.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const o = LEVELS[level].find((v) => op(v));
      if (!o) return left;
      const l = left,
        r = binary(level + 1);
      left = (n) => apply(o, l(n), r(n));
    }
  };
  const unary = (): F => {
    if (op("!")) {
      const f = unary();
      return (n) => +!f(n);
    }
    if (op("(")) {
      const f = ternary();
      if (!op(")")) throw new Error("plural expression: missing ')'");
      return f;
    }
    const tk = toks[i++];
    if (tk?.t === "num") return () => tk.v;
    if (tk?.t === "n") return (n) => n;
    throw new Error("plural expression: unexpected end");
  };
  const f = ternary();
  if (i !== toks.length) throw new Error("plural expression: trailing tokens");
  return (n) => Number(f(n));
}

/** "nplurals=2; plural=(n > 1);" → how many forms, and which one a number takes. */
export function pluralRule(header: string | undefined): { count: number; pick: (n: number) => number } {
  const m = /nplurals\s*=\s*(\d+)\s*;\s*plural\s*=\s*([^;]+);?/.exec(header ?? "");
  if (!m) return { count: 2, pick: (n) => (n === 1 ? 0 : 1) };
  const f = pluralFunction(m[2]);
  return { count: Number(m[1]), pick: f };
}

/** A catalog ready to use: key → translation (fuzzy and empty ones left out: English is shown instead). */
export interface Translations {
  plural: string;
  strings: Record<string, string | string[]>;
}

export function translations(cat: Catalog): Translations {
  const strings: Record<string, string | string[]> = {};
  for (const e of cat.entries) {
    if (e.fuzzy || !e.ctx || e.str.every((s) => !s)) continue;
    strings[e.ctx] = e.plural !== undefined ? e.str : e.str[0];
  }
  return { plural: cat.headers["Plural-Forms"] ?? "", strings };
}
