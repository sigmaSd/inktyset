// What changed between two readings of a page, word by word (Myers' algorithm on tokens): shown in the
// Compare view when two versions are side by side. Tokens are LaTeX commands, words, numbers, single
// symbols and runs of spaces, so "\alpha" changed into "\beta" is one change, not five letters.

export type Part = { op: "same" | "del" | "add"; text: string };

const TOKEN = /\\[a-zA-Z]+\*?|\\.|[\p{L}\p{N}]+|\s+|./gsu;

export const tokenize = (s: string) => s.match(TOKEN) ?? [];

/** The shortest edit from `a` to `b`, as runs of kept, removed and added text. */
export function diffWords(a: string, b: string): Part[] {
  const x = tokenize(a),
    y = tokenize(b);
  // common start and end are kept as they are: the diff is only run on the middle
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end])
    end++;
  const xs = x.slice(start, x.length - end),
    ys = y.slice(start, y.length - end);
  const parts: Part[] = [];
  const push = (op: Part["op"], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.op === op) last.text += text;
    else parts.push({ op, text });
  };
  push("same", x.slice(0, start).join(""));
  for (const [op, tok] of myers(xs, ys)) push(op, tok);
  push("same", x.slice(x.length - end).join(""));
  return parts;
}

/** Myers' O((n+m)·d) diff; returns every token with what happened to it. */
function myers(a: string[], b: string[]): [Part["op"], string][] {
  const n = a.length,
    m = b.length,
    max = n + m;
  if (!n) return b.map((t) => ["add", t]);
  if (!m) return a.map((t) => ["del", t]);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let xk = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let yk = xk - k;
      while (xk < n && yk < m && a[xk] === b[yk]) {
        xk++;
        yk++;
      }
      next[off + k] = xk;
      if (xk >= n && yk >= m) {
        trace.push(next);
        break outer;
      }
    }
    v = next;
  }
  // walk back through the saved rows
  const out: [Part["op"], string][] = [];
  let xk = n,
    yk = m;
  for (let d = trace.length - 2; d >= 0 && (xk > 0 || yk > 0); d--) {
    const row = trace[d];
    const k = xk - yk;
    const down = k === -d || (k !== d && row[off + k - 1] < row[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = row[off + pk],
      py = px - pk;
    while (xk > px && yk > py) {
      out.push(["same", a[--xk]]);
      yk--;
    }
    if (d > 0) {
      if (down) out.push(["add", b[--yk]]);
      else out.push(["del", a[--xk]]);
    }
  }
  while (xk > 0 && yk > 0) {
    out.push(["same", a[--xk]]);
    yk--;
  }
  return out.reverse();
}
