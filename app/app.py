#!/usr/bin/python3
"""hand2tex app: a window around hand2tex.py.

    app/app.py            start (or bring back) the app
    app/app.py --browser  use the normal browser instead of an app window
    app/app.py --no-window  open nothing; quits 10 min after the last page closes (testing)

Pages come from files/PDFs dropped in the window, a scanner (SANE), or a phone running
Folder Camera. Each page is read by the local model (llama-server, 127.0.0.1 only),
compiled, and shown next to its scan for proofreading.

Everything is kept in ~/Documents/hand2tex. This process owns the model, the phone
receiver and the window: closing the window finishes any waiting pages, then stops all
of them. If this process dies, its children die with it.
"""
import ctypes
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
import hand2tex as h  # noqa: E402  (the pipeline: prompt, model call, cleanup, compile)

DATA = Path(os.environ.get("HAND2TEX_DATA") or Path.home() / "Documents" / "hand2tex")
STATE = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "hand2tex"
PORT = int(os.environ.get("HAND2TEX_PORT", "8765"))
MODEL_URL = "http://127.0.0.1:8080"
MAX_SIDE = 1600
BROWSER_GRACE = 600  # normal-browser mode: seconds without any open page before quitting

PR_SET_PDEATHSIG = 1


def die_with_parent():
    """Run in the child before exec: SIGTERM it when this process goes away, even on a crash."""
    try:
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    except Exception:
        pass


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- library

def trim(png: Path, pad=24):
    """Cut the empty page margins off a preview so short pages are readable."""
    from PIL import Image, ImageOps
    im = Image.open(png).convert("RGB")
    box = ImageOps.invert(im).point(lambda v: 255 if v > 24 else 0).getbbox()
    if box:
        l, t, r, b = box
        im.crop((max(0, l - pad), max(0, t - pad), min(im.width, r + pad), min(im.height, b + pad))).save(png)


class Library:
    """The pages, their order and status, kept in DATA/state.json."""

    def __init__(self):
        for d in ("scans", "pages", "raw", "build", "originals", "phone"):
            (DATA / d).mkdir(parents=True, exist_ok=True)
        self.path = DATA / "state.json"
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.intake = 0  # files still being prepared (PDF rasterizing etc.)
        self.compile_lock = threading.Lock()  # compile_page wipes the page's build dir
        data = {}
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text())
            except Exception:
                shutil.copy(self.path, self.path.with_suffix(".broken.json"))
        self.pages = data.get("pages", [])
        self.counter = data.get("counter", 0)
        self.settings = {"language": "english", **data.get("settings", {})}
        self.seen_phone = set(data.get("seen_phone", []))
        for p in self.pages:  # a page interrupted mid-read goes back in the queue
            if p["status"] == "working":
                p["status"] = "queued"
        self.save()

    def save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"pages": self.pages, "counter": self.counter, "settings": self.settings,
                                   "seen_phone": sorted(self.seen_phone)}, indent=1))
        os.replace(tmp, self.path)

    def bump(self):
        with self.lock:
            self.save()
            self.version += 1
            self.changed.notify_all()

    def get(self, pid):
        for p in self.pages:
            if p["id"] == pid:
                return p
        return None

    def busy(self):
        with self.lock:
            return self.intake > 0 or any(p["status"] in ("queued", "working") for p in self.pages)

    def add_image(self, src: Path, label: str, origin: str):
        with self.lock:
            self.counter += 1
            pid = f"page{self.counter:04d}"
        scan = DATA / "scans" / f"{pid}.jpg"
        h.prepare_image(src, scan, MAX_SIDE)
        with self.lock:
            self.pages.append(dict(id=pid, label=label, origin=origin, status="queued", added=time.time(),
                                   rev=1, ok=None, err="", unk=0, secs=None, truncated=False, pngs=[]))
            self.bump()
        return pid

    def add_file(self, src: Path, label: str, origin: str):
        """An image becomes one page; a PDF becomes one page per sheet."""
        with self.lock:
            self.intake += 1
            self.bump()
        try:
            if src.suffix.lower() == ".pdf":
                dest = src.parent / (src.stem + "_pages")
                dest.mkdir(exist_ok=True)
                subprocess.run(["pdftoppm", "-r", "300", "-png", str(src), str(dest / "p")], check=True,
                               capture_output=True)
                sheets = sorted(dest.glob("*.png"), key=h.natural_key)
                for i, s in enumerate(sheets, 1):
                    self.add_image(s, f"{label} · sheet {i}/{len(sheets)}", origin)
            else:
                self.add_image(src, label, origin)
        except Exception as e:
            log("could not add", src, e)
            with self.lock:
                self.counter += 1
                self.pages.append(dict(id=f"page{self.counter:04d}", label=label, origin=origin, status="failed",
                                       added=time.time(), rev=1, ok=False, unk=0, secs=None, truncated=False,
                                       pngs=[], err=f"This file could not be opened as a picture or PDF ({e})."))
        finally:
            with self.lock:
                self.intake -= 1
                self.bump()

    def tex_path(self, pid):
        return DATA / "pages" / f"{pid}.tex"

    def compile(self, pid):
        with self.lock:
            lang = self.settings["language"]
        with self.compile_lock:
            ok, err, pngs = h.compile_page(DATA, pid, lang, dpi=150)
            for png in pngs:
                trim(png)
        tex = self.tex_path(pid).read_text() if self.tex_path(pid).exists() else ""
        with self.lock:
            p = self.get(pid)
            if p:
                p.update(ok=ok, err=err, unk=tex.count("[??]"), rev=p["rev"] + 1,
                         pngs=[str(x.relative_to(DATA)) for x in pngs])
                self.bump()

    def body(self, pid):
        f = self.tex_path(pid)
        return f.read_text() if f.exists() else ""

    def all_bodies(self):
        with self.lock:
            done = [p for p in self.pages if p["status"] == "done"]
        return "\n".join(f"% ---- page {i}\n{self.body(p['id']).strip()}\n" for i, p in enumerate(done, 1))

    def recompile_all(self):
        """After a language change: the preview of every finished page uses the new setup."""
        with self.lock:
            ids = [p["id"] for p in self.pages if p["status"] == "done"]
        for pid in ids:
            self.compile(pid)

    def full_document(self):
        with self.lock:
            lang = self.settings["language"]
        return h.preamble(lang) + "\\begin{document}\n\n" + self.all_bodies().replace(
            "\n% ---- page", "\n\\clearpage\n% ---- page") + "\n\\end{document}\n"


# --------------------------------------------------------------------------- model

class Model:
    """llama-server: started here unless one is already answering on 8080."""

    def __init__(self, lib):
        self.lib = lib
        self.proc = None
        self.owned = False
        self.status = "stopped"
        self.detail = ""
        self.lock = threading.Lock()

    def healthy(self):
        try:
            with urllib.request.urlopen(MODEL_URL + "/health", timeout=3) as r:
                return r.status == 200
        except urllib.error.HTTPError as e:
            if e.code == 503:
                return False  # loading
            raise
        except Exception:
            return None  # nothing there

    def set(self, status, detail=""):
        if (status, detail) != (self.status, self.detail):
            self.status, self.detail = status, detail
            self.lib.bump()

    def ensure(self):
        """Start the server if nothing is running. Called from long-lived threads only."""
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return
            if self.healthy() is not None:
                self.owned = False
                return
            logf = open(STATE / "model.log", "ab")
            env = dict(os.environ, TMPDIR=str(Path.home() / "dev" / "tmp"))
            Path(env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
            self.proc = subprocess.Popen([str(ROOT / "start-server.sh")], stdout=logf, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, preexec_fn=die_with_parent, env=env)
            self.owned = True
            self.set("starting")
            log("model: started pid", self.proc.pid)

    def watch(self):
        while True:
            try:
                ok = self.healthy()
            except Exception:
                ok = False
            if ok:
                self.set("ready")
            elif self.proc and self.proc.poll() is not None:
                tail = ""
                try:
                    tail = (STATE / "model.log").read_text(errors="replace").strip().splitlines()[-1][-200:]
                except Exception:
                    pass
                self.set("error", f"The reading engine stopped ({tail}).")
            elif ok is False or (self.proc and self.proc.poll() is None):
                self.set("starting")
            else:
                self.set("stopped")
            time.sleep(2)

    def wait_ready(self, timeout=600):
        self.ensure()
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.healthy():
                return True
            if self.proc and self.proc.poll() is not None:
                return False
            time.sleep(2)
        return False

    def stop(self):
        if self.proc and self.owned and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def worker(lib: Library, model: Model):
    """Reads queued pages one at a time, in list order."""
    while True:
        with lib.lock:
            while not any(p["status"] == "queued" for p in lib.pages):
                lib.changed.wait()
            p = next(p for p in lib.pages if p["status"] == "queued")
            pid = p["id"]
            p.update(status="working", started=time.time(), err="")
            lang = lib.settings["language"]
            lib.bump()
        try:
            if not model.wait_ready():
                raise RuntimeError("The reading engine could not start. " + model.detail)
            prompt = h.PROMPT + h.lang_prompt(lang)
            t0 = time.time()
            text, finish, _tim, _usage = h.ask_model(MODEL_URL, DATA / "scans" / f"{pid}.jpg", prompt, 4096, 1800)
            secs = time.time() - t0
            body = h.clean_latex(text)
            with lib.lock:
                if not lib.get(pid):  # deleted while it was being read
                    continue
            lib.tex_path(pid).write_text(body)
            (DATA / "raw" / f"{pid}.tex").write_text(body)  # untouched, to diff against corrections
            with lib.lock:
                p = lib.get(pid)
                if p:
                    p.update(status="done", secs=secs, truncated=(finish == "length"))
            lib.compile(pid)
        except Exception as e:
            log("page", pid, "failed:", e)
            msg = str(e)
            if isinstance(e, (urllib.error.URLError, ConnectionError, TimeoutError)):
                msg = "The reading engine did not answer. Try again with Redo."
            with lib.lock:
                p = lib.get(pid)
                if p:
                    p.update(status="failed", err=msg)
                lib.bump()
            time.sleep(1)


# --------------------------------------------------------------------------- phone

class Phone:
    """Folder Camera receiver engine (app/receiver/phone.mjs) with its own pairing."""

    def __init__(self, lib):
        self.lib = lib
        self.proc = None
        self.snap = {"status": "starting"}
        self.wlock = threading.Lock()

    def start(self):
        rdir = HERE / "receiver"
        node = shutil.which("node")
        if not node:
            self.snap = {"status": "unavailable", "error": "Node.js is not installed."}
            return
        if not (rdir / "node_modules" / "folder-camera-receiver").exists():
            log("phone: installing receiver engine ...")
            r = subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=rdir, capture_output=True, text=True,
                               env=dict(os.environ, TMPDIR=str(Path.home() / "dev" / "tmp")))
            if r.returncode:
                self.snap = {"status": "unavailable", "error": "Could not install the phone receiver."}
                log(r.stderr[-500:])
                return
        (STATE / "phone").mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen([node, str(rdir / "phone.mjs"), str(STATE / "phone"), str(DATA / "phone")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=open(STATE / "phone.log", "ab"), text=True, bufsize=1,
                                     preexec_fn=die_with_parent)
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.proc.stdout:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") == "snapshot":
                self.snap = d
                self.lib.bump()
        self.snap = {"status": "error", "error": "The phone receiver stopped."}
        self.lib.bump()

    def send(self, cmd):
        with self.wlock:
            if self.proc and self.proc.poll() is None:
                self.proc.stdin.write(json.dumps(cmd) + "\n")
                self.proc.stdin.flush()

    def public(self):
        s = self.snap
        return {k: s.get(k) for k in ("status", "error", "endpoint", "pairingExpiresAt", "qr", "devices", "active")}

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()  # phone.mjs closes the receiver cleanly and exits
                self.proc.wait(8)
            except Exception:
                self.proc.terminate()


def watch_phone_folder(lib: Library):
    """New photos from the phone land in DATA/phone/...; each becomes a page."""
    folder = DATA / "phone"
    while True:
        try:
            for f in sorted(folder.rglob("*"), key=lambda x: x.stat().st_mtime if x.exists() else 0):
                rel = str(f.relative_to(folder))
                if (not f.is_file() or rel in lib.seen_phone or any(part.startswith(".") for part in f.relative_to(folder).parts)
                        or f.suffix.lower() not in h.IMG_EXT | {".pdf"}):
                    continue
                with lib.lock:
                    lib.seen_phone.add(rel)
                    lib.save()
                lib.add_file(f, "Phone photo " + f.stem, "phone")
        except Exception:
            traceback.print_exc()
        time.sleep(2)


# --------------------------------------------------------------------------- scanner

class Scanner:
    def __init__(self, lib):
        self.lib = lib
        self.devices = []
        self.looking = False
        self.scanning = False
        self.error = ""

    def find(self):
        if self.looking or not shutil.which("scanimage"):
            return
        self.looking = True
        self.lib.bump()
        try:
            r = subprocess.run(["scanimage", "-f", "%d\t%v %m%n"], capture_output=True, text=True, timeout=60)
            devs = []
            for line in r.stdout.splitlines():
                if "\t" in line:
                    d, name = line.split("\t", 1)
                    devs.append({"id": d, "name": name.strip() or d})
            self.devices = devs
        except Exception as e:
            log("scanner search failed:", e)
        finally:
            self.looking = False
            self.lib.bump()

    def scan(self, device):
        if self.scanning:
            return
        self.scanning, self.error = True, ""
        self.lib.bump()
        out = DATA / "originals" / f"scan-{time.strftime('%Y%m%d-%H%M%S')}.png"
        try:
            for opts in (["--resolution", "300", "--mode", "Gray"], ["--resolution", "300"], []):
                r = subprocess.run(["scanimage", "-d", device, "--format=png", "-o", str(out), *opts],
                                   capture_output=True, text=True, timeout=300)
                if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
                    break
            else:
                raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "scan failed")
            self.scanning = False
            self.lib.add_file(out, "Scan " + time.strftime("%H:%M"), "scan")
        except Exception as e:
            self.error = f"The scanner did not respond: {e}"
        finally:
            self.scanning = False
            self.lib.bump()


# --------------------------------------------------------------------------- web

class App:
    def __init__(self):
        self.lib = Library()
        self.model = Model(self.lib)
        self.phone = Phone(self.lib)
        self.scanner = Scanner(self.lib)
        self.clients = 0
        self.last_client = time.time()
        self.window = None
        self.window_lock = threading.Lock()
        self.browser_mode = False
        self.want_window = threading.Event()

    def state(self):
        lib = self.lib
        with lib.lock:
            done = [p["secs"] for p in lib.pages if p.get("secs")]
            return {
                "version": lib.version,
                "pages": lib.pages,
                "intake": lib.intake,
                "settings": lib.settings,
                "languages": [{"id": k, "name": v["name"]} for k, v in h.LANGS.items()],
                "avgSecs": (sum(done[-10:]) / len(done[-10:])) if done else 90,
                "model": {"status": self.model.status, "detail": self.model.detail},
                "phone": self.phone.public(),
                "scanner": {"devices": self.scanner.devices, "looking": self.scanner.looking,
                            "scanning": self.scanner.scanning, "error": self.scanner.error,
                            "available": bool(shutil.which("scanimage"))},
                "folder": str(DATA),
            }

    def open_window(self):
        """Chrome/Chromium in app mode with its own profile: the window is its own process,
        so we know exactly when it closes. Falls back to the default browser."""
        url = f"http://127.0.0.1:{self.port}/"
        with self.window_lock:
            if self.window and self.window.poll() is None:
                # already open: Chrome with the same profile just focuses/opens another window
                subprocess.Popen(self.chrome_cmd(url), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            chrome = None if self.browser_mode else self.chrome_cmd(url)
            if chrome:
                self.window = subprocess.Popen(chrome, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                               preexec_fn=die_with_parent)
                time.sleep(2)
                if self.window.poll() is None:
                    return
                log("window: chrome handed off or failed; using browser mode")
            self.browser_mode = True
            self.last_client = time.time()
            if "--no-window" in sys.argv:
                log("open", url)
                return
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def chrome_cmd(self, url):
        for b in ("google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "brave-browser"):
            exe = shutil.which(b)
            if exe:
                return [exe, f"--app={url}", f"--user-data-dir={STATE / 'window'}", "--class=hand2tex",
                        "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                        "--disable-sync", "--window-size=1400,950",
                        # No "Can't update Chrome / Reinstall" bubble in this window: it only ever shows
                        # the local page, and the user's normal Chrome still warns about updates.
                        "--simulate-outdated-no-au=Tue, 31 Dec 2099 23:59:59 GMT",
                        "--check-for-update-interval=31536000"]
        return None

    def window_open(self):
        return bool(self.window and self.window.poll() is None)


def make_handler(app: App):
    web = HERE / "web"

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def allowed(self):
            host = self.headers.get("Host", "")
            if host not in (f"127.0.0.1:{app.port}", f"localhost:{app.port}"):
                return False  # DNS rebinding
            origin = self.headers.get("Origin")
            if origin and origin not in (f"http://127.0.0.1:{app.port}", f"http://localhost:{app.port}"):
                return False
            return True

        def send(self, code, body=b"", ctype="application/json", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def json(self):
            b = self.body()
            return json.loads(b) if b else {}

        def do_GET(self):
            if not self.allowed():
                return self.send(403)
            path = self.path.split("?", 1)[0]
            lib = app.lib
            if path == "/":
                return self.send(200, (web / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path == "/icon.svg":
                return self.send(200, (HERE / "hand2tex.svg").read_bytes(), "image/svg+xml")
            if path == "/api/state":
                return self.send(200, app.state())
            if path == "/api/version":
                return self.send(200, {"version": lib.version})
            if path == "/api/events":
                return self.events()
            if path == "/api/all.tex":
                return self.send(200, lib.all_bodies(), "text/plain; charset=utf-8")
            if path == "/api/document.tex":
                return self.send(200, lib.full_document(), "application/x-tex; charset=utf-8",
                                 {"Content-Disposition": 'attachment; filename="hand2tex.tex"'})
            m = re.fullmatch(r"/api/page/(page\d+)", path)
            if m:
                return self.send(200, {"tex": lib.body(m.group(1))})
            m = re.fullmatch(r"/files/((?:scans|build)/[\w./-]+)", path)
            if m:
                f = (DATA / m.group(1)).resolve()
                if DATA.resolve() in f.parents and f.is_file():
                    ctype = "image/jpeg" if f.suffix == ".jpg" else "image/png"
                    return self.send(200, f.read_bytes(), ctype)
            return self.send(404, {"error": "not found"})

        def events(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            lib = app.lib
            app.clients += 1
            try:
                seen = -1
                while True:
                    with lib.lock:
                        if lib.version == seen:
                            lib.changed.wait(5)  # a ping every 5 s notices a closed window quickly
                        v = lib.version
                    msg = f"data: {v}\n\n" if v != seen else ": ping\n\n"
                    seen = v
                    self.wfile.write(msg.encode())
                    self.wfile.flush()
                    time.sleep(0.15)  # coalesce bursts
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                app.clients -= 1
                app.last_client = time.time()
                self.close_connection = True

        def do_POST(self):
            if not self.allowed() or self.headers.get("X-Hand2tex") != "1":
                return self.send(403)
            path = self.path.split("?", 1)[0]
            lib = app.lib
            try:
                if path == "/api/upload":
                    name = os.path.basename(urllib.request.unquote(self.headers.get("X-Filename", "file")))
                    name = re.sub(r"[^\w.\- ()]", "_", name)[:120] or "file"
                    dest = DATA / "originals" / f"{uuid.uuid4().hex[:8]}-{name}"
                    dest.write_bytes(self.body())
                    threading.Thread(target=lib.add_file, args=(dest, name, "file"), daemon=True).start()
                    return self.send(200, {"ok": True})
                if path == "/api/settings":
                    d = self.json()
                    lang = str(d.get("language", "")).strip()[:40]
                    if not re.fullmatch(r"[^\\{}$%#&~^_\n]{1,40}", lang):
                        return self.send(400, {"error": "language name not allowed"})
                    with lib.lock:
                        changed = lang.lower() != lib.settings["language"].lower()
                        lib.settings["language"] = lang.lower() if lang.lower() in h.LANGS else lang
                        lib.bump()
                    if changed:
                        threading.Thread(target=lib.recompile_all, daemon=True).start()
                    return self.send(200, {"ok": True})
                if path == "/api/open-window":
                    app.want_window.set()  # opened by the main thread, which outlives the window
                    return self.send(200, {"ok": True})
                if path == "/api/phone/pair":
                    app.phone.send({"cmd": "pair"})
                    return self.send(200, {"ok": True})
                if path == "/api/phone/revoke":
                    app.phone.send({"cmd": "revoke", "id": self.json().get("id")})
                    return self.send(200, {"ok": True})
                if path == "/api/scanner/find":
                    threading.Thread(target=app.scanner.find, daemon=True).start()
                    return self.send(200, {"ok": True})
                if path == "/api/scanner/scan":
                    dev = self.json().get("device")
                    if dev not in [d["id"] for d in app.scanner.devices]:
                        return self.send(400, {"error": "unknown scanner"})
                    threading.Thread(target=app.scanner.scan, args=(dev,), daemon=True).start()
                    return self.send(200, {"ok": True})
                m = re.fullmatch(r"/api/page/(page\d+)/(tex|redo|delete|move)", path)
                if m:
                    pid, action = m.groups()
                    with lib.lock:
                        p = lib.get(pid)
                        if not p:
                            return self.send(404, {"error": "no such page"})
                        if action == "tex":
                            if p["status"] != "done":
                                return self.send(409, {"error": "page is not ready"})
                            lib.tex_path(pid).write_text(self.json().get("tex", ""))
                        elif action == "redo":
                            if p["status"] == "working":
                                return self.send(409, {"error": "page is being read"})
                            p.update(status="queued", err="", ok=None, pngs=[], rev=p["rev"] + 1)
                        elif action == "delete":
                            lib.pages.remove(p)
                        elif action == "move":
                            i = lib.pages.index(p)
                            j = max(0, min(len(lib.pages) - 1, i + int(self.json().get("by", 0))))
                            lib.pages.insert(j, lib.pages.pop(i))
                        lib.bump()
                    if action == "tex":
                        threading.Thread(target=lib.compile, args=(pid,), daemon=True).start()
                    return self.send(200, {"ok": True})
                return self.send(404, {"error": "not found"})
            except Exception as e:
                traceback.print_exc()
                return self.send(500, {"error": str(e)})

    return H


# --------------------------------------------------------------------------- main

class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            super().handle_error(request, client_address)  # closed tabs/probes are not errors


def notify(msg):
    if shutil.which("notify-send"):
        subprocess.Popen(["notify-send", "-a", "hand2tex", "-i", str(HERE / "hand2tex.svg"), "hand2tex", msg],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def ask_running_instance_to_open_window():
    try:
        info = json.loads((STATE / "app.json").read_text())
        req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/api/open-window", data=b"{}",
                                     headers={"X-Hand2tex": "1", "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5)
        return True
    except Exception as e:
        log("could not reach the running app:", e)
        return False


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    lockf = open(STATE / "app.lock", "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        # already running: bring its window back instead of starting a second copy
        sys.exit(0 if ask_running_instance_to_open_window() else 1)

    app = App()
    app.browser_mode = "--browser" in sys.argv or "--no-window" in sys.argv
    for port in [PORT] + list(range(PORT + 1, PORT + 20)):
        try:
            httpd = QuietServer(("127.0.0.1", port), make_handler(app))
            break
        except OSError:
            continue
    else:
        sys.exit("no free port")
    httpd.daemon_threads = True
    app.port = port
    (STATE / "app.json").write_text(json.dumps({"port": port, "pid": os.getpid()}))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log(f"hand2tex app on http://127.0.0.1:{port}/  data: {DATA}")

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *a: stop.set())
    signal.signal(signal.SIGINT, lambda *a: stop.set())

    app.model.ensure()  # warm up the model while the window opens
    threading.Thread(target=app.model.watch, daemon=True).start()
    threading.Thread(target=worker, args=(app.lib, app.model), daemon=True).start()
    app.phone.start()
    threading.Thread(target=watch_phone_folder, args=(app.lib,), daemon=True).start()
    threading.Thread(target=app.scanner.find, daemon=True).start()
    app.open_window()

    told = False
    while not stop.wait(1):
        if app.want_window.is_set():
            app.want_window.clear()
            app.open_window()
        if app.window_open() or app.clients > 0:
            told = False
            continue
        if app.browser_mode and time.time() - app.last_client < BROWSER_GRACE:
            continue
        if app.lib.busy():
            if not told:
                with app.lib.lock:
                    n = sum(p["status"] in ("queued", "working") for p in app.lib.pages)
                notify(f"Finishing {n} page(s) in the background. Open hand2tex to watch.")
                told = True
            continue
        break

    log("shutting down")
    if told:
        notify("All pages are done.")
    app.phone.stop()
    app.model.stop()
    httpd.shutdown()
    (STATE / "app.json").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
