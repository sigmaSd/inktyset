#!/usr/bin/python3
"""hand2tex: handwritten math scans -> LaTeX, using a local llama-server vision model.

Usage:
    hand2tex.py INPUT OUTDIR [--french] [--max-side 1600] [--force]

INPUT can be a single image, a folder of images, or a PDF (or a folder mixing them).
Requires a running llama-server (see start-server.sh). Nothing leaves 127.0.0.1.

Output in OUTDIR:
    scans/pageNNN.jpg     the (resized) image that was sent to the model
    pages/pageNNN.tex     transcription per page -- proofread/correct THESE
    raw/pageNNN.tex       untouched model output (for diffing against your corrections)
    build/pageNNN/        per-page compile check (+ PNG preview)
    main.tex / main.pdf   everything assembled
    review.html           scan next to rendered output, failures in red

Re-running skips pages whose .tex already exists (delete one to redo it, or --force).
"""
import argparse
import base64
import html
import io
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}

PROMPT = r"""Transcribe this handwritten mathematics page into LaTeX body content.
Rules:
- Transcribe exactly what is written. Do NOT fix, complete, simplify or add steps, even if the math looks wrong.
- Use \begin{theorem}, \begin{lemma}, \begin{proposition}, \begin{corollary}, \begin{definition}, \begin{remark}, \begin{example}, \begin{proof} where the page clearly uses them.
- Use \section*/\subsection* for headings, align* for multi-line computations, $...$ for inline math.
- If a symbol or word is illegible, write \textbf{[??]} in its place. Never guess silently.
- Crossed-out text: omit it.
- Diagrams/figures: write \textbf{[FIGURE: short description]}.
- Output ONLY the LaTeX body. No preamble, no \documentclass, no \begin{document}, no markdown fences, no comments to me."""

PROMPT_FR = "\n- The prose is in French: keep it in French exactly as written, with accents."


PREAMBLE = r"""\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
%BABEL%
\usepackage{amsmath,amssymb,amsthm,mathtools}
\usepackage[margin=2.5cm]{geometry}
\usepackage{xcolor}
\IfFileExists{tikz-cd.sty}{\usepackage{tikz-cd}}{}
\IfFileExists{enumitem.sty}{\usepackage{enumitem}}{}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem{corollary}[theorem]{Corollary}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\newtheorem{example}[theorem]{Example}
\theoremstyle{remark}
\newtheorem{remark}[theorem]{Remark}
% common shortcuts models like to use
\providecommand{\R}{\mathbb{R}}\providecommand{\N}{\mathbb{N}}
\providecommand{\Z}{\mathbb{Z}}\providecommand{\Q}{\mathbb{Q}}
\providecommand{\C}{\mathbb{C}}
"""


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def natural_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]


def collect_inputs(inp: Path, tmp: Path):
    """Return list of image paths in page order (PDFs expanded to PNGs)."""
    files = [inp] if inp.is_file() else sorted(
        (p for p in inp.iterdir() if p.is_file()), key=natural_key)
    out = []
    for f in files:
        ext = f.suffix.lower()
        if ext == ".pdf":
            dest = tmp / f.stem
            dest.mkdir(parents=True, exist_ok=True)
            if not any(dest.glob("*.png")):
                log(f"rasterizing {f.name} at 300 dpi ...")
                subprocess.run(["pdftoppm", "-r", "300", "-png", str(f), str(dest / "p")], check=True)
            out += sorted(dest.glob("*.png"), key=natural_key)
        elif ext in IMG_EXT:
            out.append(f)
        else:
            log(f"skipping {f.name} (not an image/pdf)")
    return out


def prepare_image(src: Path, dst: Path, max_side: int):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im).convert("RGB")
    w, h = im.size
    s = max_side / max(w, h)
    if s < 1:
        im = im.resize((round(w * s), round(h * s)), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "JPEG", quality=92)
    return im.size


def ask_model(server: str, img: Path, prompt: str, max_tokens: int, timeout: int):
    b64 = base64.b64encode(img.read_bytes()).decode()
    body = {
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            {"type": "text", "text": prompt},
        ]}],
        "temperature": 0.0,
        "top_k": 1,
        "repeat_penalty": 1.05,
        "max_tokens": max_tokens,
        # Qwen3.5 thinks by default; we want the transcription directly.
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        server.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.load(r)
    msg = resp["choices"][0]["message"]
    text = msg.get("content") or ""
    finish = resp["choices"][0].get("finish_reason")
    return text, finish, resp.get("timings", {}), resp.get("usage", {})


def clean_latex(t: str) -> str:
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.S)
    t = re.sub(r"^\s*```(?:latex|tex)?\s*\n", "", t)
    t = re.sub(r"\n\s*```\s*$", "", t)
    # if the model emitted a whole document anyway, keep only the body
    m = re.search(r"\\begin\{document\}(.*?)(\\end\{document\}|$)", t, flags=re.S)
    if m:
        t = m.group(1)
    t = re.sub(r"^\s*\\documentclass.*$|^\s*\\usepackage.*$", "", t, flags=re.M)
    return t.strip() + "\n"


def preamble(french: bool) -> str:
    return PREAMBLE.replace("%BABEL%", r"\usepackage[french]{babel}" if french else "")


def compile_page(out: Path, name: str, french: bool):
    """Compile one page standalone. Returns (ok, first_error, [png paths])."""
    bdir = out / "build" / name
    if bdir.exists():
        shutil.rmtree(bdir)
    bdir.mkdir(parents=True)
    tex = bdir / "doc.tex"
    tex.write_text(preamble(french) + "\\begin{document}\n\\input{../../pages/" + name + "}\n\\end{document}\n")
    r = subprocess.run(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "doc.tex"],
                       cwd=bdir, capture_output=True, text=True, timeout=120)
    logtxt = (bdir / "doc.log").read_text(errors="replace") if (bdir / "doc.log").exists() else r.stdout
    pdf = bdir / "doc.pdf"
    ok = r.returncode == 0 and pdf.exists()
    err = ""
    if not ok:
        m = re.search(r"^! .*?(?:\n.*?){0,3}", logtxt, flags=re.M)
        err = m.group(0) if m else "compile failed (see build/%s/doc.log)" % name
    pngs = []
    if pdf.exists():
        subprocess.run(["pdftoppm", "-r", "80", "-png", "doc.pdf", "render"], cwd=bdir, capture_output=True)
        pngs = sorted(bdir.glob("render*.png"), key=natural_key)
    return ok, err, pngs


def write_main(out: Path, names, french: bool):
    body = "\n".join(f"% ---- {n}\n\\input{{pages/{n}}}\n\\clearpage" for n in names)
    (out / "main.tex").write_text(preamble(french) + "\\begin{document}\n" + body + "\n\\end{document}\n")


def write_review(out: Path, rows):
    parts = ["""<!doctype html><meta charset=utf-8><title>hand2tex review</title>
<style>
body{font-family:sans-serif;margin:1em;background:#f4f4f4}
.p{display:grid;grid-template-columns:1fr 1fr;gap:1em;background:#fff;margin:0 0 2em;padding:1em;border-left:6px solid #3a3}
.p.bad{border-color:#d33}.p.unk{border-color:#da3}
img{width:100%;border:1px solid #ccc}h2{grid-column:1/3;margin:0;font-size:1.1em}
pre{grid-column:1/3;white-space:pre-wrap;background:#fee;padding:.5em;margin:0}
.meta{color:#666;font-weight:normal;font-size:.85em}
</style><h1>hand2tex review</h1>"""]
    for r in rows:
        cls = "bad" if not r["ok"] else ("unk" if r["unk"] else "")
        renders = "".join(f'<img src="{html.escape(p)}">' for p in r["pngs"]) or "<p>(no render)</p>"
        meta = f'{r["src"]} · [??]×{r["unk"]}' + (f' · {r["secs"]:.0f}s' if r.get("secs") else "")
        parts.append(f'<div class="p {cls}" id="{r["name"]}"><h2>{r["name"]} '
                     f'<span class=meta>{html.escape(meta)} · <a href="pages/{r["name"]}.tex">tex</a></span></h2>'
                     f'<div><img src="scans/{r["name"]}.jpg"></div><div>{renders}</div>'
                     + (f'<pre>{html.escape(r["err"])}</pre>' if r["err"] else "") + "</div>")
    (out / "review.html").write_text("\n".join(parts))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path)
    ap.add_argument("outdir", type=Path)
    ap.add_argument("--french", action="store_true", help="French prose (babel french + prompt hint)")
    ap.add_argument("--server", default="http://127.0.0.1:8080")
    ap.add_argument("--max-side", type=int, default=1600, help="resize long side to this many px (default 1600)")
    ap.add_argument("--max-tokens", type=int, default=4096)
    ap.add_argument("--timeout", type=int, default=1800, help="seconds per page before giving up")
    ap.add_argument("--force", action="store_true", help="redo pages that already have a .tex")
    a = ap.parse_args()

    out = a.outdir.expanduser().resolve()
    for d in ("scans", "pages", "raw", "build", "_raster"):
        (out / d).mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlopen(a.server + "/health", timeout=5)
    except Exception as e:
        sys.exit(f"llama-server not reachable at {a.server} ({e}). Start it with start-server.sh first.")

    images = collect_inputs(a.input.expanduser().resolve(), out / "_raster")
    if not images:
        sys.exit("no input images found")
    prompt = PROMPT + (PROMPT_FR if a.french else "")
    names, rows = [], []
    t_all = time.time()
    for i, src in enumerate(images, 1):
        name = f"page{i:03d}"
        names.append(name)
        texf = out / "pages" / f"{name}.tex"
        scan = out / "scans" / f"{name}.jpg"
        secs = None
        if texf.exists() and not a.force:
            log(f"[{i}/{len(images)}] {name} exists, skipping")
            if not scan.exists():
                prepare_image(src, scan, a.max_side)
        else:
            w, h = prepare_image(src, scan, a.max_side)
            log(f"[{i}/{len(images)}] {name} <- {src.name} ({w}x{h}) ...")
            t0 = time.time()
            try:
                text, finish, tim, usage = ask_model(a.server, scan, prompt, a.max_tokens, a.timeout)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                log(f"   model request failed: {e}")
                rows.append(dict(name=name, src=src.name, ok=False, err=f"model request failed: {e}",
                                 pngs=[], unk=0))
                write_review(out, rows)
                continue
            secs = time.time() - t0
            body = clean_latex(text)
            note = "% WARNING: output hit max_tokens, page may be truncated\n" if finish == "length" else ""
            texf.write_text(f"% source: {src}\n{note}{body}")
            # untouched copy: edit pages/, never raw/, so corrections can be diffed later
            (out / "raw" / f"{name}.tex").write_text(texf.read_text())
            pp, gen = tim.get("prompt_per_second"), tim.get("predicted_per_second")
            log(f"   done in {secs:.0f}s  ({usage.get('prompt_tokens', '?')} in @ {pp or 0:.0f} t/s, "
                f"{usage.get('completion_tokens', '?')} out @ {gen or 0:.1f} t/s)"
                + ("  TRUNCATED" if finish == "length" else ""))
        ok, err, pngs = compile_page(out, name, a.french)
        unk = texf.read_text().count("[??]")
        if not ok:
            log(f"   compile FAILED: {err.splitlines()[0] if err else ''}")
        rows.append(dict(name=name, src=src.name, ok=ok, err=err, unk=unk, secs=secs,
                         pngs=[str(p.relative_to(out)) for p in pngs]))
        write_main(out, names, a.french)
        write_review(out, rows)

    write_main(out, names, a.french)
    log("compiling main.pdf ...")
    subprocess.run(["latexmk", "-pdf", "-interaction=nonstopmode", "-f", "main.tex"],
                   cwd=out, capture_output=True, timeout=600)
    bad = [r["name"] for r in rows if not r["ok"]]
    unk = sum(r["unk"] for r in rows)
    log(f"\nfinished {len(rows)} pages in {(time.time() - t_all) / 60:.1f} min. "
        f"compile failures: {len(bad)} {bad if bad else ''}; [??] marks: {unk}")
    log(f"review: file://{out}/review.html")
    log(f"pdf:    {out}/main.pdf" if (out / "main.pdf").exists() else "main.pdf not produced (see main.log)")


if __name__ == "__main__":
    main()
