// The download links, from the latest GitHub release: one list per system, and the main button set to the
// visitor's own system. Without JavaScript (or if GitHub can't be reached), the links go to the releases page.
// Its words are in the page (<script id="t">), translated with the rest of it by tools/site.ts.
(async () => {
  const REPO = "sigmaSd/inktyset";
  const words = JSON.parse(document.getElementById("t").textContent);
  const lang = document.documentElement.lang;
  const t = (k, vars = {}) => words[k].replace(/\{(\w+)\}/g, (m, v) => (v in vars ? vars[v] : m));
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let release;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!r.ok) return;
    release = await r.json();
  } catch {
    return;
  }
  const assets = release.assets || [];
  const find = (re) => assets.find((a) => re.test(a.name));
  const mb = (a) => t("mb", { n: Math.round(a.size / 1e6).toLocaleString(`${lang}-u-nu-latn`) });
  const files = {
    linux: [
      [t("appImage"), find(/\.AppImage$/)],
      [t("deb"), find(/\.deb$/)],
      [t("rpm"), find(/\.rpm$/)],
    ],
    windows: [[t("exe"), find(/setup\.exe$/)]],
    mac: [
      [t("appleSilicon"), find(/arm64\.dmg$/)],
      [t("intel"), find(/(x64|x86_64)\.dmg$/) || find(/^(?!.*arm64).*\.dmg$/)],
    ],
  };
  for (const [os, list] of Object.entries(files)) {
    const box = document.getElementById(`dl-${os}`);
    const html = list
      .filter(([, a]) => a)
      .map(
        ([label, a]) =>
          `<a class="button" href="${esc(a.browser_download_url)}">${esc(label)}<small>${esc(mb(a))}</small></a>`,
      )
      .join("");
    if (html) box.innerHTML = html;
  }
  const date = new Date(release.published_at).toLocaleDateString(`${lang}-u-nu-latn`, { dateStyle: "long" });
  document.getElementById("version").innerHTML =
    `${esc(t("version", { v: release.tag_name.replace(/^v/, ""), date }))} · <a href="${esc(release.html_url)}">${esc(t("notes"))}</a>`;

  // the main button: this visitor's system
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "windows" : /Mac/.test(ua) ? "mac" : /Linux|X11/.test(ua) ? "linux" : null;
  const first = os && files[os].find(([, a]) => a);
  if (first) {
    const name = { linux: "Linux", windows: "Windows", mac: "macOS" }[os];
    const button = document.getElementById("primary");
    button.href = first[1].browser_download_url;
    button.textContent = t("downloadFor", { os: name });
    document.getElementById("primaryNote").innerHTML =
      `${esc(first[0])} · ${esc(mb(first[1]))} · <a href="#download">${esc(t("otherSystems"))}</a>`;
  }
})();
